import { validateDashboard, type DataResponseLine } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, StaticTokenVerifier } from '../src';

// Reusable value sets (D-086): one definition, used to group a dimension and to filter, in any query.
const NOW = new Date('2026-11-09T15:30:00Z');
const spec = (extra: Record<string, unknown> = {}) => ({
  specVersion: '1.4',
  id: 'd_sets',
  title: 'Sets',
  dataSources: { o: { type: 'sample', ref: 'orders' } },
  sets: { west: { field: 'region', values: ['North America', 'LATAM'], label: 'Americas', otherLabel: 'Rest of world' } },
  queries: {
    grouped: { source: 'o', dimensions: [{ field: 'region', set: 'west' }], measures: [{ field: '*', agg: 'count', as: 'orders' }], orderBy: [{ field: 'region', dir: 'asc' }] },
    filtered: { source: 'o', dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count', as: 'orders' }], filters: [{ field: 'region', op: 'not_in', set: 'west' }], orderBy: [{ field: 'region', dir: 'asc' }] },
  },
  widgets: {},
  layout: [],
  ...extra,
});

describe('value sets', () => {
  it('validate references, fields and versions', () => {
    expect(validateDashboard(spec()).ok).toBe(true);
    const bad = validateDashboard(spec({ queries: { q: { source: 'o', dimensions: [{ field: 'channel', set: 'west' }], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'region', op: 'in', set: 'nope' }] } } }));
    expect(bad.ok ? [] : bad.errors.map((e) => e.code).sort()).toEqual(['invalid_value', 'unknown_reference']);
    expect(validateDashboard({ ...spec(), specVersion: '1.3' }).ok).toBe(false);
  });

  it('group a dimension and filter, through the API', async () => {
    const app = createApp({ store: new MemoryDashboardStore(), auth: StaticTokenVerifier.parse(DEV_TOKENS), engines: defaultEngines(() => NOW), now: () => NOW });
    const res = await app.request('/v1/preview/data', {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-token-team-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: spec(), queries: ['grouped', 'filtered'] }),
    });
    const lines = Object.fromEntries((await res.text()).trim().split('\n').map((l) => JSON.parse(l) as DataResponseLine).map((l) => [l.id, l]));
    const grouped = lines.grouped!;
    const filtered = lines.filtered!;
    expect(grouped.ok && grouped.result.rows.map((r) => r.region)).toEqual(['Americas', 'Rest of world']);
    expect(filtered.ok && filtered.result.rows.map((r) => r.region)).toEqual(['APAC', 'Europe']);
  });
});
