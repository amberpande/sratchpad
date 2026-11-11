import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { VersionConflictError } from '../src/errors';
import { loadConfig } from '../src/config';
import { lowerKeys, type SqlClient, type SqlExecutor, type SqlResult, type SqlValue } from '../src/store/snowflake/client';
import { MIGRATIONS_TABLE, runSnowflakeMigrations, SNOWFLAKE_MIGRATIONS } from '../src/store/snowflake/schema';
import { createSnowflakeAppStores, SnowflakeDashboardStore } from '../src/store/snowflake/stores';
import { registryContract, shareContract, storeContract } from './contracts';

// ── unit: the Snowflake SQL itself (no database) ────────────────────────────

/** Records statements; answers from a scripted handler. */
class FakeClient implements SqlClient {
  readonly log: Array<{ sql: string; binds: SqlValue[] }> = [];
  constructor(private readonly handler: (sql: string, binds: SqlValue[]) => SqlResult = () => ({ rows: [], affected: 0 })) {}
  async query(sql: string, binds: SqlValue[] = []) {
    this.log.push({ sql, binds });
    return this.handler(sql, binds);
  }
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.log.push({ sql: 'BEGIN', binds: [] });
    try {
      const r = await fn(this);
      this.log.push({ sql: 'COMMIT', binds: [] });
      return r;
    } catch (e) {
      this.log.push({ sql: 'ROLLBACK', binds: [] });
      throw e;
    }
  }
  async close() {}
}

describe('Snowflake hybrid-table schema', () => {
  const ddl = [MIGRATIONS_TABLE, ...SNOWFLAKE_MIGRATIONS.flatMap((m) => m.statements)];

  it('creates only hybrid tables, each with an enforced primary key, idempotently', () => {
    for (const sql of ddl) {
      expect(sql).toMatch(/^CREATE HYBRID TABLE IF NOT EXISTS /);
      expect(sql).toMatch(/PRIMARY KEY \(/);
      // Hybrid tables cannot index or key VARIANT / TIMESTAMP_TZ, and foreign keys cannot cascade.
      expect(sql).not.toMatch(/VARIANT|TIMESTAMP_TZ|CASCADE/);
    }
    expect(ddl.join('\n')).toMatch(/FOREIGN KEY \(team_id, dashboard_id\) REFERENCES dashboards \(team_id, id\)/);
  });

  it('runs pending migrations once and tolerates another task recording them first', async () => {
    const db = new FakeClient((sql) => {
      if (sql.startsWith('SELECT id FROM bi_schema_migrations')) return { rows: [{ id: '001_dashboards' }], affected: 0 };
      if (sql.startsWith('INSERT INTO bi_schema_migrations')) throw new Error('Primary key already exists');
      return { rows: [], affected: 0 };
    });
    expect(await runSnowflakeMigrations(db)).toEqual([]);
    const created = db.log.map((l) => l.sql).filter((s) => s.startsWith('CREATE HYBRID TABLE'));
    const table = (name: string) => created.some((s) => s.startsWith(`CREATE HYBRID TABLE IF NOT EXISTS ${name} (`));
    expect(table('dashboards')).toBe(false); // 001 already applied
    expect(table('dashboard_versions')).toBe(false);
    expect(table('file_sources')).toBe(true);
    expect(table('dashboard_shares')).toBe(true);
  });
});

describe('SnowflakeDashboardStore statements', () => {
  it('binds every value (no user input in SQL text) and moves the head conditionally', async () => {
    let head = 3;
    const db = new FakeClient((sql) => {
      if (sql.startsWith('SELECT latest_version')) return { rows: [{ LATEST_VERSION: head }].map(lowerKeys), affected: 0 };
      if (sql.startsWith('UPDATE dashboards')) return { rows: [], affected: 1 };
      return { rows: [], affected: 1 };
    });
    const store = new SnowflakeDashboardStore(db, () => new Date('2026-11-10T00:00:00Z'));
    const saved = await store.save({ teamId: "t'1", id: 'd1', title: "Robert'); DROP TABLE x;--", specVersion: '1.1', spec: { a: 1 }, createdBy: 'u', expectedVersion: 3 });
    expect(saved).toMatchObject({ version: 4, createdAt: '2026-11-10T00:00:00.000Z' });
    for (const { sql } of db.log) {
      expect(sql).not.toContain('Robert');
      expect(sql).not.toContain("t'1");
    }
    const update = db.log.find((l) => l.sql.startsWith('UPDATE dashboards'))!;
    expect(update.sql).toMatch(/WHERE team_id = \? AND id = \? AND latest_version = \?$/);
    expect(update.binds).toEqual([4, "Robert'); DROP TABLE x;--", '2026-11-10T00:00:00.000Z', "t'1", 'd1', 3]);
    expect(db.log.map((l) => l.sql.split(' ')[0])).toEqual(['SELECT', 'BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
    head = 5;
    await expect(store.save({ teamId: 't', id: 'd1', title: 'x', specVersion: '1.1', spec: {}, createdBy: 'u', expectedVersion: 3 })).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('reports a genuine insert failure instead of calling it a conflict', async () => {
    const db = new FakeClient((sql) => {
      if (sql.startsWith('SELECT latest_version')) return { rows: [{ latest_version: 1 }], affected: 0 };
      if (sql.startsWith('UPDATE dashboards')) return { rows: [], affected: 1 };
      if (sql.startsWith('INSERT INTO dashboard_versions')) throw new Error('String is too long and would be truncated');
      return { rows: [], affected: 0 };
    });
    const store = new SnowflakeDashboardStore(db);
    await expect(store.save({ teamId: 't', id: 'd1', title: 'x', specVersion: '1.1', spec: {}, createdBy: 'u', expectedVersion: 1 })).rejects.toThrow(/too long/);
    expect(db.log.some((l) => l.sql === 'ROLLBACK')).toBe(true);
  });
});

describe('config', () => {
  const sf = { SNOWFLAKE_ACCOUNT: 'acct', SNOWFLAKE_USER: 'svc', SNOWFLAKE_PASSWORD: 'p', SNOWFLAKE_WAREHOUSE: 'WH' };
  it('selects the Snowflake store and requires its settings', () => {
    const c = loadConfig({ ...sf, BI_STORE: 'snowflake', SNOWFLAKE_APP_DATABASE: 'BI_APP' });
    expect(c.store).toBe('snowflake');
    expect(c.snowflakeApp).toEqual({ database: 'BI_APP', schema: 'PUBLIC', warehouse: 'WH', role: undefined, poolMax: 8 });
    expect(c.seed).toBe(false);
    expect(() => loadConfig({ ...sf, BI_STORE: 'snowflake' })).toThrow(/SNOWFLAKE_APP_DATABASE/);
    expect(() => loadConfig({ BI_STORE: 'snowflake', SNOWFLAKE_APP_DATABASE: 'BI_APP' })).toThrow(/SNOWFLAKE_ACCOUNT/);
    expect(() => loadConfig({ NODE_ENV: 'production', BI_TOKENS: 't:team' })).toThrow(/durable store/);
  });
});

// ── integration: the same statements on a real transactional database ──────

/**
 * Runs the Snowflake stores' SQL on Postgres: `?` → `$n`, and the hybrid-table DDL with only the
 * Snowflake-specific words swapped. This exercises the optimistic-save logic, constraints and
 * transactions for real. It does not prove Snowflake-specific behaviour (session parameters,
 * hybrid-table locking): that needs a Snowflake account (see README).
 */
class PostgresAdapter implements SqlClient {
  constructor(readonly pool: pg.Pool) {}
  static toPg(sql: string): string {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  }
  private async run(q: pg.Pool | pg.PoolClient, sql: string, binds: SqlValue[] = []): Promise<SqlResult> {
    const res = await q.query(PostgresAdapter.toPg(sql), binds);
    return { rows: (res.rows ?? []).map(lowerKeys), affected: res.rowCount ?? 0 };
  }
  query(sql: string, binds?: SqlValue[]) {
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
  async close() {
    await this.pool.end();
  }
}

const toPostgresDdl = (sql: string) =>
  sql
    .replace('CREATE HYBRID TABLE', 'CREATE TABLE')
    .replace(/,\s*INDEX \w+ \([^)]*\)/g, '')
    .replace(/NUMBER\(38,0\)/g, 'NUMERIC(38,0)');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DATABASE_URL)('Snowflake stores on a transactional database (Postgres adapter)', () => {
  const SCHEMA = 'sf_hybrid_test';
  const admin = TEST_DATABASE_URL ? new pg.Pool({ connectionString: TEST_DATABASE_URL }) : null;
  let ready: Promise<void> | undefined;
  const adapters: PostgresAdapter[] = [];
  afterAll(async () => {
    await Promise.all(adapters.map((a) => a.close()));
    await admin?.end();
  });

  async function fresh(): Promise<PostgresAdapter> {
    ready ??= (async () => {
      await admin!.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin!.query(`CREATE SCHEMA ${SCHEMA}`);
      const boot = new PostgresAdapter(new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}` }));
      const migrations = SNOWFLAKE_MIGRATIONS.map((m) => ({ ...m, statements: m.statements.map(toPostgresDdl) }));
      expect(await runSnowflakeMigrations(boot, migrations, toPostgresDdl(MIGRATIONS_TABLE))).toEqual(SNOWFLAKE_MIGRATIONS.map((m) => m.id));
      expect(await runSnowflakeMigrations(boot, migrations, toPostgresDdl(MIGRATIONS_TABLE))).toEqual([]);
      await boot.close();
    })();
    await ready;
    await admin!.query(`TRUNCATE ${SCHEMA}.dashboard_shares, ${SCHEMA}.dashboard_versions, ${SCHEMA}.dashboards, ${SCHEMA}.file_sources`);
    const a = new PostgresAdapter(new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}`, max: 10 }));
    adapters.push(a);
    return a;
  }

  storeContract('snowflake (on postgres)', async () => createSnowflakeAppStores(await fresh()).dashboards);
  shareContract('snowflake (on postgres)', async () => {
    const stores = createSnowflakeAppStores(await fresh());
    return { shares: stores.shares, dashboards: stores.dashboards };
  });
  registryContract('snowflake (on postgres)', async () => createSnowflakeAppStores(await fresh()).files);

  it('enforces the foreign key from versions to dashboards', async () => {
    const a = await fresh();
    await expect(
      a.query('INSERT INTO dashboard_versions (team_id, dashboard_id, version, title, spec_version, spec, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        't',
        'missing',
        1,
        'x',
        '1.1',
        '{}',
        'u',
        '2026-11-10T00:00:00.000Z',
      ]),
    ).rejects.toThrow(/foreign key/i);
  });
});
