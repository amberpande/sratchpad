import type { DataResponseLine, QueryResult } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { createApp, defaultEngines, MemoryDashboardStore, MemoryResultCache, MemoryShareStore, StaticTokenVerifier, type App } from '../src';
import { parseAttributes } from '../src/auth';
import { attributesWithin, loadRlsPolicies, parseRlsPolicies, rowAccess, type RlsPolicies } from '../src/rls';

const NOW = new Date('2026-11-09T15:30:00Z');
const TOKENS = [
  'editor:team-a:ed:editor:region=Europe|APAC',
  'admin:team-a:root:editor:region=*',
  'eu:team-a:eu-viewer:viewer:region=Europe',
  'noattr:team-a:plain:viewer',
  'plain-editor:team-a:pe',
].join(',');

const doc = (extra: Record<string, unknown> = {}) => ({
  specVersion: '1.3',
  id: 'dash_int',
  title: 'Interactive',
  interactions: { crossFilter: true },
  dataSources: { orders: { type: 'sample', ref: 'orders' } },
  queries: {
    q_region: { source: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
    q_year: { source: 'orders', dimensions: [{ field: 'order_date', grain: 'year' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
    q_cat: { source: 'orders', dimensions: [{ field: 'category' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
  },
  widgets: {
    w_region: { type: 'bar-chart', query: 'q_region', encoding: { x: 'region', y: 'revenue' }, options: {}, drill: { levels: [{ field: 'region' }, { field: 'channel' }] } },
    w_year: {
      type: 'line-chart',
      query: 'q_year',
      encoding: { x: 'order_date', y: 'revenue' },
      options: {},
      drill: { levels: [{ field: 'order_date', grain: 'year' }, { field: 'order_date', grain: 'month' }] },
    },
    w_cat: { type: 'table', query: 'q_cat', options: {} },
  },
  layout: [
    { i: 'w_region', x: 0, y: 0, w: 6, h: 4 },
    { i: 'w_year', x: 6, y: 0, w: 6, h: 4 },
    { i: 'w_cat', x: 0, y: 4, w: 12, h: 4 },
  ],
  params: {
    regions: { type: 'multiselect', field: 'region', options: ['Europe', 'APAC', 'North America', 'LATAM'], bind: ['q_cat.filters'] },
    metric: {
      type: 'measure',
      as: 'revenue',
      options: [
        { value: 'rev', label: 'Revenue', field: 'amount', agg: 'sum' },
        { value: 'orders', label: 'Orders', field: '*', agg: 'count' },
      ],
      default: 'rev',
      bind: ['q_cat.measures'],
    },
    amount: { type: 'range', field: 'amount', bind: ['q_cat.filters'] },
    find: { type: 'search', field: 'category', match: 'starts_with', bind: ['q_cat.filters'] },
  },
  ...extra,
});

function setup(opts: { rls?: RlsPolicies; cache?: boolean } = {}) {
  const shares = new MemoryShareStore();
  const app = createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(TOKENS),
    engines: defaultEngines(() => NOW),
    now: () => NOW,
    shares,
    rls: opts.rls ?? {},
    ...(opts.cache ? { queryServices: { cache: new MemoryResultCache(), cacheTtlSeconds: 60 } } : {}),
  });
  return { app, shares };
}

const call = (app: App, method: string, path: string, body?: unknown, token = 'admin') =>
  app.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function save(app: App, spec: unknown = doc()) {
  const res = await call(app, 'PUT', '/v1/dashboards/dash_int', { spec });
  expect(res.status, JSON.stringify(await res.clone().json())).toBeLessThan(300);
}

async function data(app: App, body: unknown, token = 'admin') {
  const res = await call(app, 'POST', '/v1/dashboards/dash_int/data', body, token);
  const lines = res.ok ? (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as DataResponseLine) : [];
  return { res, lines, byId: Object.fromEntries(lines.map((l) => [l.id, l])) };
}
const ok = (l: DataResponseLine | undefined): QueryResult => {
  if (!l?.ok) throw new Error(`expected ok, got ${JSON.stringify(l)}`);
  return l.result;
};
const total = (r: QueryResult, col = 'revenue') => Math.round(r.rows.reduce((s, row) => s + Number(row[col]), 0));

describe('cross-filtering', () => {
  it('filters other queries by a clicked dimension value', async () => {
    const { app } = setup();
    await save(app);
    const regions = ok((await data(app, { queries: ['q_region'] })).byId.q_region);
    const europe = Number(regions.rows.find((r) => r.region === 'Europe')!.revenue);
    const { byId } = await data(app, { queries: [{ query: 'q_cat', key: 'q_cat~eu', filters: [{ field: 'region', op: 'in', values: ['Europe'] }] }] });
    expect(total(ok(byId['q_cat~eu']))).toBe(Math.round(europe));
    // A time bucket click (year) becomes a date range on the column.
    const year = await data(app, { queries: [{ query: 'q_region', key: 'k', filters: [{ field: 'order_date', op: 'eq', grain: 'year', values: ['2025-01-01'] }] }] });
    expect(ok(year.byId.k).rows.length).toBeGreaterThan(0);
    // Drill levels are declared dimensions too ("channel" is only a drill level of w_region).
    const channel = await data(app, { queries: [{ query: 'q_cat', key: 'c', filters: [{ field: 'channel', op: 'in', values: ['Online'] }] }] });
    expect(total(ok(channel.byId.c))).toBeLessThan(total(ok((await data(app, { queries: ['q_cat'] })).byId.q_cat)));
  });

  it('refuses anything outside the author-declared surface', async () => {
    const { app } = setup();
    await save(app);
    const bad = async (filters: unknown) => (await data(app, { queries: [{ query: 'q_cat', key: 'x', filters }] })).res.status;
    expect(await bad([{ field: 'amount', op: 'in', values: [1] }])).toBe(400); // a measure, not a dimension
    expect(await bad([{ field: 'customer_id', op: 'in', values: ['cus_0001'] }])).toBe(400); // undeclared
    expect(await bad([{ field: 'region', op: 'gt', values: ['A'] }])).toBe(400);
    expect(await bad([{ field: 'region', op: 'in', values: Array.from({ length: 101 }, (_, i) => `r${i}`) }])).toBe(400);
    expect(await bad([{ field: 'region', op: 'in', values: [{ $ne: 1 }] }])).toBe(400);
    expect(await bad([{ field: 'order_date', op: 'eq', grain: 'day', values: ['2025-01-01'] }])).toBe(400); // grain not used
    // Dashboards without cross-filtering accept no runtime filters at all.
    const { app: off } = setup();
    await save(off, doc({ interactions: undefined }));
    expect((await data(off, { queries: [{ query: 'q_cat', key: 'x', filters: [{ field: 'region', op: 'in', values: ['Europe'] }] }] })).res.status).toBe(400);
  });

  it('caches variants separately', async () => {
    const { app } = setup({ cache: true });
    await save(app);
    const a = await data(app, { queries: [{ query: 'q_cat', key: 'a', filters: [{ field: 'region', op: 'in', values: ['Europe'] }] }] });
    const b = await data(app, { queries: [{ query: 'q_cat', key: 'b', filters: [{ field: 'region', op: 'in', values: ['APAC'] }] }] });
    expect(total(ok(a.byId.a))).not.toBe(total(ok(b.byId.b)));
  });
});

describe('drill-down', () => {
  it('derives the next level from the saved levels, keeping the output column name', async () => {
    const { app } = setup();
    await save(app);
    const { byId } = await data(app, { queries: [{ query: 'q_region', key: 'd', drill: { widget: 'w_region', level: 1, path: ['Europe'] } }] });
    const r = ok(byId.d);
    expect(r.columns.map((c) => c.name)).toContain('region'); // alias kept for the widget's encoding
    expect(new Set(r.rows.map((row) => row.region))).toEqual(new Set(['Direct', 'Online', 'Partner']));
    const months = ok((await data(app, { queries: [{ query: 'q_year', key: 'm', drill: { widget: 'w_year', level: 1, path: ['2025-01-01'] } }] })).byId.m);
    expect(months.rows.every((row) => String(row.order_date).startsWith('2025-'))).toBe(true);
    expect(months.rows.length).toBeGreaterThan(1);
  });

  it('rejects drills the widget does not declare', async () => {
    const { app } = setup();
    await save(app);
    expect((await data(app, { queries: [{ query: 'q_cat', key: 'd', drill: { widget: 'w_cat', level: 1, path: ['x'] } }] })).res.status).toBe(400);
    expect((await data(app, { queries: [{ query: 'q_cat', key: 'd', drill: { widget: 'w_region', level: 1, path: ['x'] } }] })).res.status).toBe(400);
    const deep = await data(app, { queries: [{ query: 'q_region', key: 'd', drill: { widget: 'w_region', level: 2, path: ['a', 'b'] } }] });
    expect(deep.byId.d).toMatchObject({ ok: false, error: { code: 'invalid_drill' } });
    const short = await data(app, { queries: [{ query: 'q_region', key: 'd', drill: { widget: 'w_region', level: 1, path: [] } }] });
    expect(short.byId.d).toMatchObject({ ok: false, error: { code: 'invalid_drill' } });
  });
});

describe('1.3 params', () => {
  it('multiselect, range and measure switch run only declared values', async () => {
    const { app } = setup();
    await save(app);
    const all = total(ok((await data(app, { queries: ['q_cat'] })).byId.q_cat));
    const eu = total(ok((await data(app, { queries: ['q_cat'], params: { regions: ['Europe'] } })).byId.q_cat));
    expect(eu).toBeLessThan(all);
    const small = total(ok((await data(app, { queries: ['q_cat'], params: { amount: [0, 500] } })).byId.q_cat));
    expect(small).toBeLessThan(all);
    const counts = ok((await data(app, { queries: ['q_cat'], params: { metric: 'orders' } })).byId.q_cat);
    expect(counts.rows.every((r) => Number.isInteger(r.revenue))).toBe(true); // same column, now a count
    const soft = ok((await data(app, { queries: ['q_cat'], params: { find: 'Soft' } })).byId.q_cat);
    expect(soft.rows.map((r) => r.category)).toEqual(['Software']);
    for (const params of [{ find: 'x'.repeat(201) }, { metric: 'drop_tables' }, { regions: ['Atlantis'] }, { amount: [500, 0] }, { amount: 'big' }]) {
      expect((await data(app, { queries: ['q_cat'], params })).res.status).toBe(400);
    }
  });
});

describe('row-level security', () => {
  const rls: RlsPolicies = { 'team-a': [{ field: 'region', attribute: 'region', source: { type: 'sample' } }] };

  it('filters by attributes, fails closed without them, and keeps cache entries apart', async () => {
    const { app } = setup({ rls, cache: true });
    await save(app);
    const admin = ok((await data(app, { queries: ['q_region'] }, 'admin')).byId.q_region);
    expect(admin.rows.length).toBe(4);
    const eu = ok((await data(app, { queries: ['q_region'] }, 'eu')).byId.q_region);
    expect(eu.rows.map((r) => r.region)).toEqual(['Europe']);
    // Same query again as admin after the EU user: still all regions (cache keys include row filters).
    expect(ok((await data(app, { queries: ['q_region'] }, 'admin')).byId.q_region).rows.length).toBe(4);
    const none = (await data(app, { queries: ['q_region'] }, 'noattr')).byId.q_region;
    expect(none).toMatchObject({ ok: false, error: { code: 'rls_denied' } });
    // Cross-filters can't widen access.
    const sneaky = await data(app, { queries: [{ query: 'q_region', key: 'k', filters: [{ field: 'region', op: 'in', values: ['APAC'] }] }] }, 'eu');
    expect(ok(sneaky.byId.k).rows).toEqual([]);
  });

  it('applies to draft previews too', async () => {
    const { app } = setup({ rls });
    const res = await call(app, 'POST', '/v1/preview/data', { spec: doc(), queries: ['q_region'] }, 'editor');
    const line = JSON.parse((await res.text()).trim()) as DataResponseLine;
    expect(new Set(ok(line).rows.map((r) => r.region))).toEqual(new Set(['Europe', 'APAC']));
    const plain = await call(app, 'POST', '/v1/preview/data', { spec: doc(), queries: ['q_region'] }, 'plain-editor');
    expect(JSON.parse((await plain.text()).trim())).toMatchObject({ ok: false, error: { code: 'rls_denied' } });
  });

  it('shares carry a subset of the creator’s attributes, never more', async () => {
    const { app } = setup({ rls });
    await save(app);
    const create = (body: Record<string, unknown>) => call(app, 'POST', '/v1/dashboards/dash_int/shares', { audience: 'app', ...body }, 'editor');
    expect((await create({ attributes: { region: ['LATAM'] } })).status).toBe(403);
    expect((await create({ attributes: { country: ['FR'] } })).status).toBe(403);
    expect((await create({ attributes: 'region=' })).status).toBe(400);
    const narrowed = (await (await create({ attributes: { region: ['Europe'] } })).json()) as { token: string; share: { attributes?: unknown } };
    expect(narrowed.share.attributes).toEqual({ region: ['Europe'] });
    const viaShare = await call(app, 'POST', '/v1/dashboards/dash_int/data', { queries: ['q_region'] }, narrowed.token);
    expect(ok(JSON.parse((await viaShare.text()).trim())).rows.map((r) => r.region)).toEqual(['Europe']);
    const inherited = (await (await create({})).json()) as { token: string };
    const viaInherited = await call(app, 'POST', '/v1/dashboards/dash_int/data', { queries: ['q_region'] }, inherited.token);
    expect(new Set(ok(JSON.parse((await viaInherited.text()).trim())).rows.map((r) => r.region))).toEqual(new Set(['Europe', 'APAC']));
  });

  it('parses policies and attributes strictly', () => {
    expect(parseAttributes('region=EU|US;country=FR', 'test')).toEqual({ region: ['EU', 'US'], country: ['FR'] });
    expect(() => parseAttributes('region', 'test')).toThrow(/Bad attribute/);
    expect(() => StaticTokenVerifier.parse('t:team:me:viewer:bad')).toThrow(/Bad attribute/);
    expect(() => parseRlsPolicies('{not json')).toThrow(/must be JSON/);
    expect(() => parseRlsPolicies('{"team-a": [{"field": "region"}]}')).toThrow(/attribute/);
    expect(loadRlsPolicies({ BI_RLS_POLICIES: '' })).toEqual({});
    expect(rowAccess(rls, 'team-b', undefined, { type: 'sample', ref: 'orders' })).toEqual({ ok: true, filters: [] }); // other team: no policy
    expect(rowAccess(rls, 'team-a', { teamId: 'team-a', subject: 's', attributes: { region: ['*'] } }, { type: 'sample', ref: 'orders' })).toEqual({ ok: true, filters: [] });
    expect(attributesWithin({ region: ['EU'] }, { region: ['*'] })).toBeNull();
    expect(() => createApp({ store: new MemoryDashboardStore(), auth: StaticTokenVerifier.parse(TOKENS), engines: defaultEngines(), rls: parseRlsPolicies('{}') })).not.toThrow();
  });
});
