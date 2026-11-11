import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SHARE_TOKEN_PREFIX, type Share, type ShareAudience } from '@yourorg/bi-spec';
import type pg from 'pg';

/**
 * Share grants. A share token looks like `bis_<shareId>_<secret>`: the id finds the row, the
 * secret is checked against a SHA-256 hash in constant time. Only the hash is stored, so a database
 * dump does not leak usable tokens.
 */

export interface ShareRecord extends Share {
  teamId: string;
  secretHash: string;
  /** Row-level security attributes the share sees (a subset of its creator's). Absent = none. */
  attributes?: Record<string, string[]>;
}

export interface CreateShareInput {
  teamId: string;
  dashboardId: string;
  audience: ShareAudience;
  label: string;
  version?: number;
  createdBy: string;
  expiresAt?: string;
  attributes?: Record<string, string[]>;
}

export interface ShareStore {
  insert(record: ShareRecord): Promise<void>;
  get(id: string): Promise<ShareRecord | null>;
  list(teamId: string, dashboardId: string): Promise<ShareRecord[]>;
  /** False when there is no such share for this team and dashboard. Idempotent. */
  revoke(teamId: string, dashboardId: string, id: string, at: string): Promise<boolean>;
  touch(id: string, at: string): Promise<void>;
  close?(): Promise<void>;
}

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const TOKEN = new RegExp(`^${SHARE_TOKEN_PREFIX}([a-z0-9]{12})_([A-Za-z0-9_-]{32,64})$`);

export function isShareToken(token: string): boolean {
  return token.startsWith(SHARE_TOKEN_PREFIX);
}

export function newShare(input: CreateShareInput, now: Date): { record: ShareRecord; token: string } {
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const record: ShareRecord = {
    id,
    teamId: input.teamId,
    dashboardId: input.dashboardId,
    audience: input.audience,
    label: input.label,
    ...(input.version !== undefined ? { version: input.version } : {}),
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.attributes ? { attributes: structuredClone(input.attributes) } : {}),
    secretHash: hash(secret),
  };
  return { record, token: `${SHARE_TOKEN_PREFIX}${id}_${secret}` };
}

/** The share a token grants, if it is valid, unexpired and not revoked. */
export async function verifyShareToken(store: ShareStore, token: string, now: Date): Promise<ShareRecord | null> {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const record = await store.get(m[1]!);
  if (!record) return null;
  const a = Buffer.from(hash(m[2]!), 'hex');
  const b = Buffer.from(record.secretHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) return null;
  return record;
}

export function publicShare(r: ShareRecord): Share {
  const { teamId: _t, secretHash: _h, ...share } = r;
  return share;
}

export class MemoryShareStore implements ShareStore {
  private readonly rows = new Map<string, ShareRecord>();

  async insert(record: ShareRecord): Promise<void> {
    this.rows.set(record.id, structuredClone(record));
  }

  async get(id: string): Promise<ShareRecord | null> {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }

  async list(teamId: string, dashboardId: string): Promise<ShareRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.teamId === teamId && r.dashboardId === dashboardId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => structuredClone(r));
  }

  async revoke(teamId: string, dashboardId: string, id: string, at: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.teamId !== teamId || r.dashboardId !== dashboardId) return false;
    r.revokedAt ??= at;
    return true;
  }

  async touch(id: string, at: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.lastUsedAt = at;
  }
}

interface ShareRow {
  id: string;
  team_id: string;
  dashboard_id: string;
  audience: ShareAudience;
  label: string;
  version: number | null;
  secret_hash: string;
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  /** Migration 00x_share_attributes (jsonb). */
  attributes?: Record<string, string[]> | null;
}

function fromRow(r: ShareRow): ShareRecord {
  return {
    id: r.id,
    teamId: r.team_id,
    dashboardId: r.dashboard_id,
    audience: r.audience,
    label: r.label,
    ...(r.version !== null ? { version: r.version } : {}),
    secretHash: r.secret_hash,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    ...(r.expires_at ? { expiresAt: r.expires_at.toISOString() } : {}),
    ...(r.revoked_at ? { revokedAt: r.revoked_at.toISOString() } : {}),
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at.toISOString() } : {}),
    ...(r.attributes ? { attributes: r.attributes } : {}),
  };
}

/** Uses the `dashboard_shares` table (migration 003). */
export class PostgresShareStore implements ShareStore {
  constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PostgresShareStore> {
    const { default: pgm } = await import('pg');
    return new PostgresShareStore(new pgm.Pool({ connectionString, max: 5 }));
  }

  async insert(r: ShareRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO dashboard_shares (id, team_id, dashboard_id, audience, label, version, secret_hash, created_by, created_at, expires_at, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [r.id, r.teamId, r.dashboardId, r.audience, r.label, r.version ?? null, r.secretHash, r.createdBy, r.createdAt, r.expiresAt ?? null, r.attributes ? JSON.stringify(r.attributes) : null],
    );
  }

  async get(id: string): Promise<ShareRecord | null> {
    const { rows } = await this.pool.query<ShareRow>('SELECT * FROM dashboard_shares WHERE id = $1', [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async list(teamId: string, dashboardId: string): Promise<ShareRecord[]> {
    const { rows } = await this.pool.query<ShareRow>(
      'SELECT * FROM dashboard_shares WHERE team_id = $1 AND dashboard_id = $2 ORDER BY created_at DESC',
      [teamId, dashboardId],
    );
    return rows.map(fromRow);
  }

  async revoke(teamId: string, dashboardId: string, id: string, at: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE dashboard_shares SET revoked_at = COALESCE(revoked_at, $4) WHERE id = $1 AND team_id = $2 AND dashboard_id = $3`,
      [id, teamId, dashboardId, at],
    );
    return (rowCount ?? 0) > 0;
  }

  async touch(id: string, at: string): Promise<void> {
    // At most one write per share per minute, so a busy dashboard doesn't write on every request.
    await this.pool.query(
      `UPDATE dashboard_shares SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '1 minute')`,
      [id, at],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
