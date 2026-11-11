import type { SourceProfile } from '@yourorg/bi-spec';
import type { FileSourceRecord, FileSourceRegistry } from '../../data/files/registry';
import { VersionConflictError } from '../../errors';
import type { ShareRecord, ShareStore } from '../../sharing/store';
import type { DashboardRecord, DashboardStore, DashboardSummary, SaveInput, VersionSummary } from '../types';
import type { SqlClient, SqlRow } from './client';

/**
 * Dashboards, versions, shares and upload metadata in Snowflake hybrid tables (see schema.ts).
 *
 * Hybrid tables lock rows but offer no SELECT … FOR UPDATE, so a save is optimistic:
 *   1. read latest_version (N); a stale expectedVersion is a conflict right away;
 *   2. in one transaction, move the head N → N+1 with `UPDATE … WHERE latest_version = N`
 *      (0 rows = someone else saved first) or, for a new dashboard, INSERT it (duplicate key =
 *      someone else created it first), then insert version N+1, whose enforced primary key is a
 *      second guarantee that two saves can never produce the same version.
 * Saves without expectedVersion ("save on top") retry on a lost race instead of failing.
 *
 * SQL is plain and portable on purpose (`?` binds, text timestamps): the same statements run in
 * the test suite against Postgres through an adapter, so the concurrency logic is exercised for real.
 */

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const optStr = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));
const num = (v: unknown): number => Number(v);

const SAVE_RETRIES = 8;

/** A write lost to a concurrent save, or failed for its own reason (`cause`); the caller tells which. */
class LostRace extends Error {
  constructor(readonly original?: unknown) {
    super('lost a concurrent save');
  }
}

function versionRecord(r: SqlRow): DashboardRecord {
  return {
    teamId: str(r.team_id),
    id: str(r.dashboard_id),
    version: num(r.version),
    title: str(r.title),
    specVersion: str(r.spec_version),
    spec: JSON.parse(str(r.spec)),
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
  };
}

export class SnowflakeDashboardStore implements DashboardStore {
  constructor(
    private readonly db: SqlClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(teamId: string, id: string, version?: number): Promise<DashboardRecord | null> {
    let v = version;
    if (v === undefined) {
      const head = await this.db.query('SELECT latest_version FROM dashboards WHERE team_id = ? AND id = ?', [teamId, id]);
      if (!head.rows[0]) return null;
      v = num(head.rows[0].latest_version);
    }
    const { rows } = await this.db.query(
      `SELECT team_id, dashboard_id, version, title, spec_version, spec, created_by, created_at
         FROM dashboard_versions WHERE team_id = ? AND dashboard_id = ? AND version = ?`,
      [teamId, id, v],
    );
    return rows[0] ? versionRecord(rows[0]) : null;
  }

  async list(teamId: string): Promise<DashboardSummary[]> {
    const { rows } = await this.db.query(
      'SELECT id, title, latest_version, updated_at FROM dashboards WHERE team_id = ? AND latest_version > 0 ORDER BY id',
      [teamId],
    );
    return rows.map((r) => ({ id: str(r.id), title: str(r.title), latestVersion: num(r.latest_version), updatedAt: str(r.updated_at) }));
  }

  async listVersions(teamId: string, id: string): Promise<VersionSummary[]> {
    const { rows } = await this.db.query(
      `SELECT version, title, spec_version, created_by, created_at FROM dashboard_versions
        WHERE team_id = ? AND dashboard_id = ? ORDER BY version DESC`,
      [teamId, id],
    );
    return rows.map((r) => ({ version: num(r.version), title: str(r.title), specVersion: str(r.spec_version), createdBy: str(r.created_by), createdAt: str(r.created_at) }));
  }

  async save(input: SaveInput): Promise<DashboardRecord> {
    const spec = JSON.stringify(input.spec);
    for (let attempt = 0; ; attempt++) {
      const head = await this.db.query('SELECT latest_version FROM dashboards WHERE team_id = ? AND id = ?', [input.teamId, input.id]);
      const current = head.rows[0] ? num(head.rows[0].latest_version) : 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== current) {
        throw new VersionConflictError(current, input.expectedVersion);
      }
      const next = current + 1;
      const at = this.now().toISOString();
      try {
        await this.db.transaction(async (tx) => {
          if (current === 0) {
            try {
              await tx.query('INSERT INTO dashboards (team_id, id, title, latest_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
                input.teamId,
                input.id,
                input.title,
                next,
                at,
                at,
              ]);
            } catch (error) {
              throw new LostRace(error); // most likely a duplicate primary key: created concurrently
            }
          } else {
            const moved = await tx.query('UPDATE dashboards SET latest_version = ?, title = ?, updated_at = ? WHERE team_id = ? AND id = ? AND latest_version = ?', [
              next,
              input.title,
              at,
              input.teamId,
              input.id,
              current,
            ]);
            if (moved.affected !== 1) throw new LostRace();
          }
          try {
            await tx.query(
              `INSERT INTO dashboard_versions (team_id, dashboard_id, version, title, spec_version, spec, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [input.teamId, input.id, next, input.title, input.specVersion, spec, input.createdBy, at],
            );
          } catch (error) {
            throw new LostRace(error); // most likely a duplicate (team, dashboard, version)
          }
        });
        return { teamId: input.teamId, id: input.id, version: next, title: input.title, specVersion: input.specVersion, spec: JSON.parse(spec), createdBy: input.createdBy, createdAt: at };
      } catch (error) {
        if (!(error instanceof LostRace)) throw error;
        const latest = await this.db.query('SELECT latest_version FROM dashboards WHERE team_id = ? AND id = ?', [input.teamId, input.id]);
        const now = latest.rows[0] ? num(latest.rows[0].latest_version) : 0;
        // The head did not move, so nobody else saved: the statement failed for its own reason.
        if (now === current && error.original !== undefined) throw error.original;
        if (input.expectedVersion !== undefined) throw new VersionConflictError(now, input.expectedVersion);
        if (attempt >= SAVE_RETRIES) throw new Error(`Could not save dashboard "${input.id}": too many concurrent saves.`);
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
      }
    }
  }

  async close(): Promise<void> {
    // The shared client is closed by its owner (see createSnowflakeAppStores).
  }
}

function shareRecord(r: SqlRow): ShareRecord {
  const version = r.version === null || r.version === undefined ? undefined : num(r.version);
  const expiresAt = optStr(r.expires_at);
  const revokedAt = optStr(r.revoked_at);
  const lastUsedAt = optStr(r.last_used_at);
  const attributes = optStr(r.attributes);
  return {
    id: str(r.id),
    teamId: str(r.team_id),
    dashboardId: str(r.dashboard_id),
    audience: str(r.audience) as ShareRecord['audience'],
    label: str(r.label),
    ...(version !== undefined ? { version } : {}),
    secretHash: str(r.secret_hash),
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
    ...(expiresAt ? { expiresAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(attributes ? { attributes: JSON.parse(attributes) as Record<string, string[]> } : {}),
  };
}

const SHARE_COLUMNS = 'id, team_id, dashboard_id, audience, label, version, secret_hash, created_by, created_at, expires_at, revoked_at, last_used_at, attributes';

export class SnowflakeShareStore implements ShareStore {
  constructor(private readonly db: SqlClient) {}

  async insert(r: ShareRecord): Promise<void> {
    await this.db.query(`INSERT INTO dashboard_shares (${SHARE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`, [
      r.id,
      r.teamId,
      r.dashboardId,
      r.audience,
      r.label,
      r.version ?? null,
      r.secretHash,
      r.createdBy,
      r.createdAt,
      r.expiresAt ?? null,
      r.attributes ? JSON.stringify(r.attributes) : null,
    ]);
  }

  async get(id: string): Promise<ShareRecord | null> {
    const { rows } = await this.db.query(`SELECT ${SHARE_COLUMNS} FROM dashboard_shares WHERE id = ?`, [id]);
    return rows[0] ? shareRecord(rows[0]) : null;
  }

  async list(teamId: string, dashboardId: string): Promise<ShareRecord[]> {
    const { rows } = await this.db.query(`SELECT ${SHARE_COLUMNS} FROM dashboard_shares WHERE team_id = ? AND dashboard_id = ? ORDER BY created_at DESC, id`, [
      teamId,
      dashboardId,
    ]);
    return rows.map(shareRecord);
  }

  async revoke(teamId: string, dashboardId: string, id: string, at: string): Promise<boolean> {
    // Two statements so a repeat revoke keeps the first timestamp and still reports success.
    await this.db.query('UPDATE dashboard_shares SET revoked_at = ? WHERE id = ? AND team_id = ? AND dashboard_id = ? AND revoked_at IS NULL', [at, id, teamId, dashboardId]);
    const { rows } = await this.db.query('SELECT id FROM dashboard_shares WHERE id = ? AND team_id = ? AND dashboard_id = ?', [id, teamId, dashboardId]);
    return rows.length > 0;
  }

  async touch(id: string, at: string): Promise<void> {
    // At most one write per share per minute: a busy dashboard must not write on every request.
    const threshold = new Date(Date.parse(at) - 60_000).toISOString();
    await this.db.query('UPDATE dashboard_shares SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)', [at, id, threshold]);
  }
}

function fileRecord(r: SqlRow): FileSourceRecord {
  const profile = optStr(r.profile);
  return {
    id: str(r.id),
    teamId: str(r.team_id),
    name: str(r.name),
    format: str(r.format) as FileSourceRecord['format'],
    sizeBytes: num(r.size_bytes),
    rowCount: num(r.row_count),
    createdAt: str(r.created_at),
    createdBy: str(r.created_by),
    ...(profile ? { profile: JSON.parse(profile) as SourceProfile } : {}),
    ...(r.storage === 'snowflake' || r.storage === 'local' ? { storage: r.storage as 'local' | 'snowflake' } : {}),
    ...(optStr(r.table_name) ? { table: optStr(r.table_name) } : {}),
  };
}

const FILE_COLUMNS = 'id, team_id, name, format, size_bytes, row_count, profile, storage, table_name, created_by, created_at';

export class SnowflakeFileSourceRegistry implements FileSourceRegistry {
  constructor(private readonly db: SqlClient) {}

  async get(teamId: string, id: string): Promise<FileSourceRecord | null> {
    // team_id in the WHERE clause: another team's id reads exactly like a missing one.
    const { rows } = await this.db.query(`SELECT ${FILE_COLUMNS} FROM file_sources WHERE id = ? AND team_id = ?`, [id, teamId]);
    return rows[0] ? fileRecord(rows[0]) : null;
  }

  async list(teamId: string): Promise<FileSourceRecord[]> {
    const { rows } = await this.db.query(`SELECT ${FILE_COLUMNS} FROM file_sources WHERE team_id = ? ORDER BY created_at DESC, id`, [teamId]);
    return rows.map(fileRecord);
  }

  async put(r: FileSourceRecord): Promise<void> {
    const profile = r.profile ? JSON.stringify(r.profile) : null;
    // Update-then-insert instead of MERGE (Snowflake advises plain DML for single-row changes).
    const updated = await this.db.query('UPDATE file_sources SET profile = ?, row_count = ?, storage = ?, table_name = ? WHERE id = ? AND team_id = ?', [
      profile,
      r.rowCount,
      r.storage ?? null,
      r.table ?? null,
      r.id,
      r.teamId,
    ]);
    if (updated.affected > 0) return;
    await this.db.query(`INSERT INTO file_sources (${FILE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      r.id,
      r.teamId,
      r.name,
      r.format,
      r.sizeBytes,
      r.rowCount,
      profile,
      r.storage ?? null,
      r.table ?? null,
      r.createdBy,
      r.createdAt,
    ]);
  }
}

export interface SnowflakeAppStores {
  dashboards: SnowflakeDashboardStore;
  shares: SnowflakeShareStore;
  files: SnowflakeFileSourceRegistry;
  close(): Promise<void>;
}

/** All app stores on one client (one connection pool), closed together. */
export function createSnowflakeAppStores(db: SqlClient): SnowflakeAppStores {
  return {
    dashboards: new SnowflakeDashboardStore(db),
    shares: new SnowflakeShareStore(db),
    files: new SnowflakeFileSourceRegistry(db),
    close: () => db.close(),
  };
}
