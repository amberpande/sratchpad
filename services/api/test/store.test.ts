import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryDashboardStore } from '../src/store/memory';
import { PostgresDashboardStore } from '../src/store/postgres';
import { runMigrations } from '../src/store/migrations';
import { MemoryShareStore, PostgresShareStore } from '../src/sharing/store';
import { shareContract, storeContract } from './contracts';
import type { DashboardStore } from '../src/store/types';

storeContract('memory', async () => new MemoryDashboardStore());

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DATABASE_URL)('postgres', () => {
  const stores: PostgresDashboardStore[] = [];
  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()));
  });

  it('migrations are idempotent', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    try {
      await runMigrations(pool);
      expect(await runMigrations(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  storeContract('postgres', async () => {
    const store = await PostgresDashboardStore.connect(TEST_DATABASE_URL!);
    stores.push(store);
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query('TRUNCATE dashboards CASCADE');
    await pool.end();
    return store;
  });
});


shareContract('memory', async () => ({ shares: new MemoryShareStore(), dashboards: new MemoryDashboardStore() }));

describe.skipIf(!TEST_DATABASE_URL)('postgres shares', () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
  });
  shareContract('postgres', async () => {
    const dashboards = await PostgresDashboardStore.connect(TEST_DATABASE_URL!);
    const shares = await PostgresShareStore.connect(TEST_DATABASE_URL!);
    closers.push(() => dashboards.close(), () => shares.close!());
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query('TRUNCATE dashboards CASCADE');
    await pool.end();
    return { shares, dashboards };
  });
});
