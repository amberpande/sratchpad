import { beforeEach, describe, expect, it } from 'vitest';
import { buildProfile, statsFromRows } from '../src/data/profile';
import type { FileSourceRecord, FileSourceRegistry } from '../src/data/files/registry';
import { VersionConflictError } from '../src/errors';
import { newShare, verifyShareToken, type ShareStore } from '../src/sharing/store';
import type { DashboardStore } from '../src/store/types';

/**
 * Behavioural contracts every store implementation must pass: memory, Postgres and Snowflake
 * Hybrid Tables run the same cases.
 */

/** One behavioural contract, run against every store implementation. */
export function storeContract(name: string, makeStore: () => Promise<DashboardStore>) {
  describe(`${name} store`, () => {
    let store: DashboardStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    const save = (overrides: Partial<Parameters<DashboardStore['save']>[0]> = {}) =>
      store.save({ teamId: 't1', id: 'd1', title: 'One', specVersion: '1.0', spec: { a: 1, nested: [1, 2] }, createdBy: 'u1', ...overrides });

    it('appends versions and returns the latest by default', async () => {
      expect((await save()).version).toBe(1);
      expect((await save({ title: 'One v2', spec: { a: 2 } })).version).toBe(2);
      expect(await store.get('t1', 'd1')).toMatchObject({ version: 2, title: 'One v2', spec: { a: 2 } });
      expect(await store.get('t1', 'd1', 1)).toMatchObject({ version: 1, spec: { a: 1, nested: [1, 2] } });
      expect(await store.get('t1', 'd1', 3)).toBeNull();
      expect((await store.listVersions('t1', 'd1')).map((v) => v.version)).toEqual([2, 1]);
    });

    it('scopes everything by team', async () => {
      await save();
      await save({ teamId: 't2', title: 'Theirs' });
      expect(await store.get('t3', 'd1')).toBeNull();
      expect((await store.list('t1')).map((d) => d.title)).toEqual(['One']);
      expect((await store.list('t2')).map((d) => d.title)).toEqual(['Theirs']);
    });

    it('enforces expectedVersion', async () => {
      await save({ expectedVersion: 0 });
      await expect(save({ expectedVersion: 0 })).rejects.toBeInstanceOf(VersionConflictError);
      await expect(save({ expectedVersion: 1 })).resolves.toMatchObject({ version: 2 });
    });

    it('serializes concurrent saves into distinct versions', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => save({ title: `v${i}` })));
      expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  });
}


export function shareContract(name: string, make: () => Promise<{ shares: ShareStore; dashboards: DashboardStore }>) {
  describe(`${name} share store`, () => {
    let shares: ShareStore;
    const NOW = new Date('2026-11-09T12:00:00Z');
    beforeEach(async () => {
      const made = await make();
      shares = made.shares;
      await made.dashboards.save({ teamId: 't1', id: 'd1', title: 'One', specVersion: '1.0', spec: {}, createdBy: 'u1' });
    });

    it('verifies, lists, touches and revokes', async () => {
      const { record, token } = newShare({ teamId: 't1', dashboardId: 'd1', audience: 'viewer', label: 'L', version: 1, createdBy: 'u1', expiresAt: '2026-12-01T00:00:00.000Z' }, NOW);
      await shares.insert(record);
      expect(await verifyShareToken(shares, token, NOW)).toMatchObject({ id: record.id, version: 1, audience: 'viewer', expiresAt: '2026-12-01T00:00:00.000Z' });
      expect(await verifyShareToken(shares, token, new Date('2026-12-02T00:00:00Z'))).toBeNull();
      expect((await shares.list('t1', 'd1')).map((s) => s.id)).toEqual([record.id]);
      expect(await shares.list('t2', 'd1')).toEqual([]);
      await shares.touch(record.id, NOW.toISOString());
      expect((await shares.get(record.id))!.lastUsedAt).toBe(NOW.toISOString());
      expect(await shares.revoke('t2', 'd1', record.id, NOW.toISOString())).toBe(false);
      expect(await shares.revoke('t1', 'd1', record.id, NOW.toISOString())).toBe(true);
      expect(await verifyShareToken(shares, token, NOW)).toBeNull();
    });
  });
}


export const record = (overrides: Partial<FileSourceRecord> = {}): FileSourceRecord => ({
  id: 'file_000000000000000000000001',
  teamId: 't1',
  name: 'a.csv',
  format: 'csv',
  sizeBytes: 10,
  rowCount: 2,
  createdAt: '2026-11-01T00:00:00.000Z',
  createdBy: 'u1',
  ...overrides,
});

export function registryContract(name: string, make: () => Promise<FileSourceRegistry>) {
  describe(`${name} file registry`, () => {
    let registry: FileSourceRegistry;
    beforeEach(async () => {
      registry = await make();
    });

    it('scopes reads by team', async () => {
      await registry.put(record());
      await registry.put(record({ id: 'file_000000000000000000000002', teamId: 't2' }));
      expect(await registry.get('t1', 'file_000000000000000000000001')).toMatchObject({ name: 'a.csv' });
      expect(await registry.get('t2', 'file_000000000000000000000001')).toBeNull();
      expect((await registry.list('t1')).map((r) => r.id)).toEqual(['file_000000000000000000000001']);
    });

    it('lists newest first and stores the profile', async () => {
      await registry.put(record());
      await registry.put(record({ id: 'file_000000000000000000000003', createdAt: '2026-11-05T00:00:00.000Z' }));
      expect((await registry.list('t1')).map((r) => r.id)).toEqual(['file_000000000000000000000003', 'file_000000000000000000000001']);
      const profile = buildProfile({ type: 'file', ref: 'file_000000000000000000000001' }, statsFromRows([{ a: 1 }], ['a']));
      await registry.put(record({ profile }));
      expect((await registry.get('t1', 'file_000000000000000000000001'))?.profile).toEqual(profile);
    });

    it('records where the rows live', async () => {
      await registry.put(record());
      expect((await registry.get('t1', 'file_000000000000000000000001'))?.storage ?? 'local').toBe('local');
      await registry.put(record({ storage: 'snowflake', table: 'BI_APP.UPLOADS.FILE_000000000000000000000001' }));
      expect(await registry.get('t1', 'file_000000000000000000000001')).toMatchObject({ storage: 'snowflake', table: 'BI_APP.UPLOADS.FILE_000000000000000000000001' });
    });
  });
}

