import type { DataResponseLine } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, StaticTokenVerifier } from '../src';

// Joins through the real request path (attachJoinSources in runQuery), and the fail-closed guard:
// a join with a row-secured source is refused instead of being read unfiltered.
const NOW = new Date('2026-11-09T15:30:00Z');

const spec = {
  specVersion: '1.3',
  id: 'd_join',
  title: 'Join',
  dataSources: { o: { type: 'sample', ref: 'orders' }, o2: { type: 'sample', ref: 'orders' } },
  queries: {
    q: {
      source: 'o',
      joins: [{ source: 'o2', type: 'inner', on: [{ left: 'order_id', right: 'order_id' }] }],
      dimensions: [{ field: 'region' }],
      measures: [{ field: 'o2.amount', agg: 'sum', as: 'joined_amount' }],
      orderBy: [{ field: 'region', dir: 'asc' }],
    },
  },
  widgets: {},
  layout: [],
};

function app(rls?: Record<string, Array<{ field: string; attribute: string; source?: { type: string; ref: string } }>>) {
  return createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: defaultEngines(() => NOW),
    now: () => NOW,
    queryServices: rls ? { rls } : undefined,
  });
}

async function preview(a: ReturnType<typeof app>) {
  const res = await a.request('/v1/preview/data', {
    method: 'POST',
    headers: { Authorization: 'Bearer dev-token-team-a', 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec, queries: ['q'] }),
  });
  expect(res.status).toBe(200);
  return JSON.parse((await res.text()).trim()) as DataResponseLine;
}

describe('joins through runQuery', () => {
  it('runs a self-join on the sample source', async () => {
    const line = await preview(app({}));
    expect(line.ok, JSON.stringify(line)).toBe(true);
    if (line.ok) expect(line.result.rows.length).toBeGreaterThan(0);
  });

  it('refuses a join with a row-secured source when the principal lacks the attribute (fail closed)', async () => {
    const line = await preview(app({ 'team-a': [{ field: 'region', attribute: 'region', source: { type: 'sample', ref: 'orders' } }] }));
    expect(line).toMatchObject({ ok: false, error: { code: 'rls_denied' } });
  });

  it('filters a row-secured joined source by its own columns (D-079)', async () => {
    const a = createApp({
      store: new MemoryDashboardStore(),
      auth: StaticTokenVerifier.parse('t-eu:team-a:eu:editor:region=Europe'),
      engines: defaultEngines(() => NOW),
      now: () => NOW,
      // Only the joined source is governed here, so its filter alone must restrict the result.
      queryServices: { rls: { 'team-a': [{ field: 'region', attribute: 'region', source: { type: 'sample', ref: 'orders' } }] } },
    });
    const res = await a.request('/v1/preview/data', {
      method: 'POST',
      headers: { Authorization: 'Bearer t-eu', 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec, queries: ['q'] }),
    });
    const line = JSON.parse((await res.text()).trim()) as DataResponseLine;
    expect(line.ok, JSON.stringify(line)).toBe(true);
    if (line.ok) expect(line.result.rows.map((r) => r.region)).toEqual(['Europe']);
    // The SQL path (DuckDB) gets the same filter on "o2.region"; the reference engine already proves the rows.
  });
});
