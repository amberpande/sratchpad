import pg from 'pg';
import { lowerKeys, type SqlClient, type SqlExecutor, type SqlResult, type SqlValue } from '../store/snowflake/client';

/**
 * The platform store: team-scoped JSON records grouped in collections (comments, favorites,
 * subscriptions, alerts, metric catalogs, refresh schedules, …), counters (usage), and leases
 * (the scheduler's leader election across ECS tasks).
 *
 * One SQL implementation serves Snowflake hybrid tables and Postgres: the statements are plain and
 * portable (`?` binds, text timestamps, JSON as text), exactly like the Snowflake app stores. Every
 * read and write takes the team id, so one team never sees another team's records.
 */

export interface PlatformRecord<T = unknown> {
  teamId: string;
  collection: string;
  id: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface CounterRow {
  counter: string;
  bucket: string;
  value: number;
}

export interface PlatformStore {
  put<T>(teamId: string, collection: string, id: string, data: T): Promise<PlatformRecord<T>>;
  get<T>(teamId: string, collection: string, id: string): Promise<PlatformRecord<T> | null>;
  /** Newest first. `prefix` filters ids. */
  list<T>(teamId: string, collection: string, options?: { prefix?: string; limit?: number }): Promise<PlatformRecord<T>[]>;
  delete(teamId: string, collection: string, id: string): Promise<boolean>;
  /** Adds `by` to a counter bucket (e.g. views of a dashboard on a day). */
  increment(teamId: string, counter: string, bucket: string, by?: number): Promise<void>;
  /** Buckets of counters whose name starts with `prefix`, buckets >= `fromBucket`. */
  counters(teamId: string, prefix: string, fromBucket?: string): Promise<CounterRow[]>;
  /** Takes or renews a lease for `holder` until now+ttl. False if another holder has a live lease. */
  acquireLease(name: string, holder: string, ttlMs: number, now: Date): Promise<boolean>;
  releaseLease(name: string, holder: string): Promise<void>;
  /** Every record of a collection across teams (the scheduler's job scan). */
  listAllTeams<T>(collection: string): Promise<PlatformRecord<T>[]>;
  close?(): Promise<void>;
}

const nowIso = () => new Date().toISOString();

export class MemoryPlatformStore implements PlatformStore {
  private readonly records = new Map<string, PlatformRecord>();
  private readonly counterMap = new Map<string, number>();
  private readonly leases = new Map<string, { holder: string; expires: number }>();

  private key(...parts: string[]) {
    return parts.join('\u0000');
  }

  async put<T>(teamId: string, collection: string, id: string, data: T): Promise<PlatformRecord<T>> {
    const k = this.key(teamId, collection, id);
    const prev = this.records.get(k);
    const at = nowIso();
    const rec: PlatformRecord<T> = { teamId, collection, id, data: structuredClone(data), createdAt: prev?.createdAt ?? at, updatedAt: at };
    this.records.set(k, rec as PlatformRecord);
    return structuredClone(rec);
  }

  async get<T>(teamId: string, collection: string, id: string): Promise<PlatformRecord<T> | null> {
    const r = this.records.get(this.key(teamId, collection, id));
    return r ? (structuredClone(r) as PlatformRecord<T>) : null;
  }

  async list<T>(teamId: string, collection: string, options: { prefix?: string; limit?: number } = {}): Promise<PlatformRecord<T>[]> {
    return [...this.records.values()]
      .filter((r) => r.teamId === teamId && r.collection === collection && (!options.prefix || r.id.startsWith(options.prefix)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, options.limit ?? 1000)
      .map((r) => structuredClone(r) as PlatformRecord<T>);
  }

  async delete(teamId: string, collection: string, id: string): Promise<boolean> {
    return this.records.delete(this.key(teamId, collection, id));
  }

  async increment(teamId: string, counter: string, bucket: string, by = 1): Promise<void> {
    const k = this.key(teamId, counter, bucket);
    this.counterMap.set(k, (this.counterMap.get(k) ?? 0) + by);
  }

  async counters(teamId: string, prefix: string, fromBucket = ''): Promise<CounterRow[]> {
    const out: CounterRow[] = [];
    for (const [k, value] of this.counterMap) {
      const [t, counter, bucket] = k.split('\u0000') as [string, string, string];
      if (t === teamId && counter.startsWith(prefix) && bucket >= fromBucket) out.push({ counter, bucket, value });
    }
    return out.sort((a, b) => a.counter.localeCompare(b.counter) || a.bucket.localeCompare(b.bucket));
  }

  async acquireLease(name: string, holder: string, ttlMs: number, now: Date): Promise<boolean> {
    const l = this.leases.get(name);
    if (l && l.holder !== holder && l.expires > now.getTime()) return false;
    this.leases.set(name, { holder, expires: now.getTime() + ttlMs });
    return true;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    if (this.leases.get(name)?.holder === holder) this.leases.delete(name);
  }

  async listAllTeams<T>(collection: string): Promise<PlatformRecord<T>[]> {
    return [...this.records.values()].filter((r) => r.collection === collection).map((r) => structuredClone(r) as PlatformRecord<T>);
  }
}

const RECORD_COLUMNS = 'team_id, collection, id, data, created_at, updated_at';

/** A LIKE pattern matching `prefix` literally (escape char "!"), portable to Postgres and Snowflake. */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

function toRecord<T>(r: Record<string, unknown>): PlatformRecord<T> {
  return {
    teamId: String(r.team_id),
    collection: String(r.collection),
    id: String(r.id),
    data: JSON.parse(String(r.data)) as T,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Postgres and Snowflake hybrid tables (migrations 005_platform / 004_platform). */
export class SqlPlatformStore implements PlatformStore {
  constructor(
    private readonly db: SqlClient,
    private readonly ownsClient = false,
  ) {}

  async put<T>(teamId: string, collection: string, id: string, data: T): Promise<PlatformRecord<T>> {
    const json = JSON.stringify(data);
    const at = nowIso();
    const updated = await this.db.query('UPDATE platform_records SET data = ?, updated_at = ? WHERE team_id = ? AND collection = ? AND id = ?', [json, at, teamId, collection, id]);
    if (updated.affected === 0) {
      try {
        await this.db.query(`INSERT INTO platform_records (${RECORD_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, [teamId, collection, id, json, at, at]);
      } catch (error) {
        // Inserted concurrently by someone else (primary key): last writer wins.
        const retry = await this.db.query('UPDATE platform_records SET data = ?, updated_at = ? WHERE team_id = ? AND collection = ? AND id = ?', [json, at, teamId, collection, id]);
        if (retry.affected === 0) throw error;
      }
    }
    return (await this.get<T>(teamId, collection, id))!;
  }

  async get<T>(teamId: string, collection: string, id: string): Promise<PlatformRecord<T> | null> {
    const { rows } = await this.db.query(`SELECT ${RECORD_COLUMNS} FROM platform_records WHERE team_id = ? AND collection = ? AND id = ?`, [teamId, collection, id]);
    return rows[0] ? toRecord<T>(rows[0]) : null;
  }

  async list<T>(teamId: string, collection: string, options: { prefix?: string; limit?: number } = {}): Promise<PlatformRecord<T>[]> {
    const limit = Math.max(1, Math.min(5000, Math.floor(options.limit ?? 1000)));
    const binds: SqlValue[] = [teamId, collection];
    let where = 'team_id = ? AND collection = ?';
    if (options.prefix) {
      // LIKE with an escaped pattern: collation-independent (a string range is not, across databases).
      where += " AND id LIKE ? ESCAPE '!'";
      binds.push(likePrefix(options.prefix));
    }
    const { rows } = await this.db.query(`SELECT ${RECORD_COLUMNS} FROM platform_records WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`, binds);
    return rows.map((r) => toRecord<T>(r));
  }

  async delete(teamId: string, collection: string, id: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM platform_records WHERE team_id = ? AND collection = ? AND id = ?', [teamId, collection, id]);
    return res.affected > 0;
  }

  async increment(teamId: string, counter: string, bucket: string, by = 1): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.db.query('UPDATE platform_counters SET value = value + ? WHERE team_id = ? AND counter = ? AND bucket = ?', [by, teamId, counter, bucket]);
      if (res.affected > 0) return;
      try {
        await this.db.query('INSERT INTO platform_counters (team_id, counter, bucket, value) VALUES (?, ?, ?, ?)', [teamId, counter, bucket, by]);
        return;
      } catch {
        // Created concurrently: loop and update.
      }
    }
  }

  async counters(teamId: string, prefix: string, fromBucket = ''): Promise<CounterRow[]> {
    const { rows } = await this.db.query(
      "SELECT counter, bucket, value FROM platform_counters WHERE team_id = ? AND counter LIKE ? ESCAPE '!' AND bucket >= ? ORDER BY counter, bucket",
      [teamId, likePrefix(prefix), fromBucket],
    );
    return rows.map((r) => ({ counter: String(r.counter), bucket: String(r.bucket), value: Number(r.value) }));
  }

  async acquireLease(name: string, holder: string, ttlMs: number, now: Date): Promise<boolean> {
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    const nowS = now.toISOString();
    const res = await this.db.query('UPDATE platform_leases SET holder = ?, expires_at = ? WHERE name = ? AND (holder = ? OR expires_at < ?)', [holder, expires, name, holder, nowS]);
    if (res.affected > 0) return true;
    try {
      await this.db.query('INSERT INTO platform_leases (name, holder, expires_at) VALUES (?, ?, ?)', [name, holder, expires]);
      return true;
    } catch {
      return false; // another holder exists (primary key)
    }
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    await this.db.query('DELETE FROM platform_leases WHERE name = ? AND holder = ?', [name, holder]);
  }

  async listAllTeams<T>(collection: string): Promise<PlatformRecord<T>[]> {
    const { rows } = await this.db.query(`SELECT ${RECORD_COLUMNS} FROM platform_records WHERE collection = ? ORDER BY team_id, id LIMIT 10000`, [collection]);
    return rows.map((r) => toRecord<T>(r));
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.db.close();
  }
}

/** A SqlClient over a pg Pool: `?` placeholders become `$n`. */
export class PgSqlClient implements SqlClient {
  constructor(private readonly pool: pg.Pool) {}

  static connect(connectionString: string, max = 4): PgSqlClient {
    return new PgSqlClient(new pg.Pool({ connectionString, max }));
  }

  static toPg(sql: string): string {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  }

  private async run(q: pg.Pool | pg.PoolClient, sql: string, binds: SqlValue[] = []): Promise<SqlResult> {
    const res = await q.query(PgSqlClient.toPg(sql), binds);
    return { rows: (res.rows ?? []).map(lowerKeys), affected: res.rowCount ?? 0 };
  }

  query(sql: string, binds?: SqlValue[]): Promise<SqlResult> {
    return this.run(this.pool, sql, binds);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn({ query: (sql, binds) => this.run(client, sql, binds) });
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
