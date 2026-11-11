import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryPlatformStore, PgSqlClient, SqlPlatformStore, type PlatformStore } from '../src/platform/store';
import { runMigrations } from '../src/store/migrations';
import { MIGRATIONS_TABLE, runSnowflakeMigrations, SNOWFLAKE_MIGRATIONS } from '../src/store/snowflake/schema';

/** One behavioural contract for every platform store implementation. */
function platformStoreContract(name: string, make: () => Promise<PlatformStore>) {
  describe(`${name} platform store`, () => {
    let store: PlatformStore;
    beforeEach(async () => {
      store = await make();
    });

    it('puts, gets, lists newest first with prefixes, and deletes, scoped by team', async () => {
      await store.put('t1', 'comments', 'd1:a', { body: 'first' });
      await new Promise((r) => setTimeout(r, 5));
      await store.put('t1', 'comments', 'd1:b', { body: 'second' });
      await store.put('t1', 'comments', 'd2:a', { body: 'other dashboard' });
      await store.put('t2', 'comments', 'd1:a', { body: 'other team' });
      expect((await store.get<{ body: string }>('t1', 'comments', 'd1:a'))!.data.body).toBe('first');
      expect(await store.get('t3', 'comments', 'd1:a')).toBeNull();
      expect((await store.list<{ body: string }>('t1', 'comments', { prefix: 'd1:' })).map((r) => r.data.body)).toEqual(['second', 'first']);
      expect((await store.list('t1', 'comments')).length).toBe(3);
      expect(await store.delete('t1', 'comments', 'd1:a')).toBe(true);
      expect(await store.delete('t1', 'comments', 'd1:a')).toBe(false);
      expect((await store.get<{ body: string }>('t2', 'comments', 'd1:a'))!.data.body).toBe('other team');
    });

    it('upserts keep createdAt and update data', async () => {
      const a = await store.put('t1', 'subscriptions', 's1', { v: 1 });
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.put('t1', 'subscriptions', 's1', { v: 2 });
      expect(b.data).toEqual({ v: 2 });
      expect(b.createdAt).toBe(a.createdAt);
      expect(b.updatedAt >= a.updatedAt).toBe(true);
      expect((await store.listAllTeams('subscriptions')).map((r) => r.teamId)).toEqual(['t1']);
    });

    it('counts by bucket, including concurrent increments', async () => {
      await Promise.all(Array.from({ length: 10 }, () => store.increment('t1', 'views:d1', '2026-11-10')));
      await store.increment('t1', 'views:d1', '2026-11-09', 3);
      await store.increment('t1', 'views:d2', '2026-11-10');
      await store.increment('t2', 'views:d1', '2026-11-10');
      expect(await store.counters('t1', 'views:d1')).toEqual([
        { counter: 'views:d1', bucket: '2026-11-09', value: 3 },
        { counter: 'views:d1', bucket: '2026-11-10', value: 10 },
      ]);
      expect((await store.counters('t1', 'views:', '2026-11-10')).map((r) => r.counter)).toEqual(['views:d1', 'views:d2']);
    });

    it('leases: one holder at a time, renewable, taken over after expiry', async () => {
      const t0 = new Date('2026-11-10T00:00:00Z');
      expect(await store.acquireLease('scheduler', 'a', 60_000, t0)).toBe(true);
      expect(await store.acquireLease('scheduler', 'b', 60_000, new Date(t0.getTime() + 1000))).toBe(false);
      expect(await store.acquireLease('scheduler', 'a', 60_000, new Date(t0.getTime() + 30_000))).toBe(true);
      expect(await store.acquireLease('scheduler', 'b', 60_000, new Date(t0.getTime() + 95_000))).toBe(true);
      await store.releaseLease('scheduler', 'b');
      expect(await store.acquireLease('scheduler', 'a', 60_000, new Date(t0.getTime() + 96_000))).toBe(true);
    });
  });
}

platformStoreContract('memory', async () => new MemoryPlatformStore());

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DATABASE_URL)('platform store on Postgres', () => {
  const clients: PgSqlClient[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
  });

  platformStoreContract('postgres', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await runMigrations(pool);
    await pool.query('TRUNCATE platform_records, platform_counters, platform_leases');
    await pool.end();
    const client = PgSqlClient.connect(TEST_DATABASE_URL!);
    clients.push(client);
    return new SqlPlatformStore(client);
  });

  // The Snowflake hybrid-table DDL, translated only where Postgres differs (as in snowflake-store.test.ts).
  const SCHEMA = 'sf_platform_test';
  const toPg = (sql: string) => sql.replace('CREATE HYBRID TABLE', 'CREATE TABLE').replace(/,\s*INDEX \w+ \([^)]*\)/g, '').replace(/NUMBER\(38,0\)/g, 'NUMERIC(38,0)');
  let ready: Promise<void> | undefined;
  platformStoreContract('snowflake (on postgres)', async () => {
    ready ??= (async () => {
      const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      await admin.end();
      const boot = new PgSqlClient(new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}` }));
      await runSnowflakeMigrations(boot, SNOWFLAKE_MIGRATIONS.map((m) => ({ ...m, statements: m.statements.map(toPg) })), toPg(MIGRATIONS_TABLE));
      await boot.close();
    })();
    await ready;
    const client = new PgSqlClient(new pg.Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}`, max: 10 }));
    clients.push(client);
    await client.query('TRUNCATE platform_records, platform_counters, platform_leases');
    return new SqlPlatformStore(client);
  });
});
