import { SUPPORTED_SPEC, type DataResponseLine, type QueryResult } from '@yourorg/bi-spec';
import { beforeEach, describe, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import docExample from '../../../packages/spec/test/fixtures/doc-example.json';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, StaticTokenVerifier, type App } from '../src';

const NOW = new Date('2026-11-09T15:30:00Z');
const TEAM_A = 'dev-token-team-a';
const TEAM_B = 'dev-token-team-b';

let app: App;

function call(method: string, path: string, { token = TEAM_A, body }: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function data(id: string, body: unknown, token = TEAM_A) {
  const res = await call('POST', `/v1/dashboards/${id}/data`, { body, token });
  const text = await res.text();
  const lines = res.ok ? text.trim().split('\n').map((l) => JSON.parse(l) as DataResponseLine) : [];
  return { res, lines, byId: Object.fromEntries(lines.map((l) => [l.id, l])), text };
}

function ok(line: DataResponseLine | undefined): QueryResult {
  if (!line?.ok) throw new Error(`expected an ok line, got ${JSON.stringify(line)}`);
  return line.result;
}

beforeEach(async () => {
  app = createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: defaultEngines(() => NOW),
    now: () => NOW,
  });
  const res = await call('PUT', '/v1/dashboards/dash_9f2a', { body: { spec: salesOverview } });
  expect(res.status).toBe(201);
});

describe('gateway', () => {
  it('requires a valid bearer token', async () => {
    expect((await call('GET', '/v1/dashboards', { token: null })).status).toBe(401);
    const res = await call('GET', '/v1/dashboards', { token: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'A valid bearer token is required.' } });
  });

  it('isolates teams: another team cannot see or query the dashboard', async () => {
    expect(await (await call('GET', '/v1/dashboards', { token: TEAM_B })).json()).toEqual({ dashboards: [] });
    expect((await call('GET', '/v1/dashboards/dash_9f2a', { token: TEAM_B })).status).toBe(404);
    const { res } = await data('dash_9f2a', { queries: ['q_totals'] }, TEAM_B);
    expect(res.status).toBe(404);
  });

  it('serves health without auth', async () => {
    expect((await call('GET', '/healthz', { token: null })).status).toBe(200);
  });
});

describe('dashboard store', () => {
  it('versions every save and serves any version', async () => {
    const edited = { ...salesOverview, title: 'Sales overview (edited)' };
    const v2 = await call('PUT', '/v1/dashboards/dash_9f2a', { body: { spec: edited, expectedVersion: 1 } });
    expect(v2.status).toBe(200);
    expect(v2.headers.get('ETag')).toBe('"2"');

    const latest = await (await call('GET', '/v1/dashboards/dash_9f2a')).json();
    expect(latest).toMatchObject({ id: 'dash_9f2a', version: 2, title: 'Sales overview (edited)', specVersion: '1.0', createdBy: 'dev-a' });
    const v1 = await (await call('GET', '/v1/dashboards/dash_9f2a?version=1')).json();
    expect(v1).toMatchObject({ version: 1, title: 'Sales overview' });
    expect(v1.spec).toEqual(salesOverview);

    const versions = await (await call('GET', '/v1/dashboards/dash_9f2a/versions')).json();
    expect(versions.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const list = await (await call('GET', '/v1/dashboards')).json();
    expect(list.dashboards).toEqual([expect.objectContaining({ id: 'dash_9f2a', latestVersion: 2 })]);
  });

  it('rejects stale writes with 409', async () => {
    const res = await call('PUT', '/v1/dashboards/dash_9f2a', { body: { spec: salesOverview, expectedVersion: 0 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'version_conflict', details: { currentVersion: 1 } } });
  });

  it('refuses invalid specs with every error path', async () => {
    const broken = structuredClone(salesOverview) as any;
    broken.widgets.w_line.encoding.y = 'profit';
    broken.layout[0].w = 20;
    const res = await call('PUT', '/v1/dashboards/dash_9f2a', { body: { spec: broken } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_spec');
    expect(body.error.details.errors.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(['layout.0.w', 'widgets.w_line.encoding.y']),
    );
  });

  it('refuses a spec whose id does not match the URL, and newer spec versions', async () => {
    expect((await call('PUT', '/v1/dashboards/other_id', { body: { spec: salesOverview } })).status).toBe(422);
    // One minor beyond what this build supports (robust to the supported minor being bumped).
    const newer = { ...salesOverview, specVersion: `${SUPPORTED_SPEC.major}.${SUPPORTED_SPEC.minor + 1}` };
    const res = await call('PUT', '/v1/dashboards/dash_9f2a', { body: { spec: newer } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.details.errors[0].code).toBe('version_too_new');
  });

  it('returns 404 for unknown dashboards and versions, 400 for bad input', async () => {
    expect((await call('GET', '/v1/dashboards/missing')).status).toBe(404);
    expect((await call('GET', '/v1/dashboards/dash_9f2a?version=7')).status).toBe(404);
    expect((await call('GET', '/v1/dashboards/dash_9f2a?version=abc')).status).toBe(400);
    expect((await call('GET', '/v1/dashboards/9bad')).status).toBe(400);
    const res = await app.request('/v1/dashboards/dash_9f2a', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TEAM_A}`, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('data endpoint', () => {
  it('streams one NDJSON line per unique query, in a single round-trip', async () => {
    const { res, lines, byId } = await data('dash_9f2a', { queries: ['q_rev_by_month', 'q_totals', 'q_rev_by_month', 'q_rev_by_region'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');
    expect(res.headers.get('X-Dashboard-Version')).toBe('1');
    expect(lines).toHaveLength(3);

    const months = ok(byId.q_rev_by_month);
    expect(months.columns[0]).toEqual({ name: 'order_date', type: 'time', grain: 'month' });
    // default range is last_365d → 2025-11-10 … 2026-11-09, i.e. 13 calendar months
    expect(months.rows.map((r) => r.order_date)).toEqual(
      Array.from({ length: 13 }, (_, i) => new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10)),
    );

    // The same filters through different queries must agree.
    const monthly = months.rows.reduce((s, r) => s + (r.revenue as number), 0);
    const regional = ok(byId.q_rev_by_region).rows.reduce((s, r) => s + (r.revenue as number), 0);
    expect(regional).toBeCloseTo(monthly, 2);
    expect(ok(byId.q_totals).rows).toHaveLength(1);
  });

  it('applies params to the queries they bind', async () => {
    const wide = ok((await data('dash_9f2a', { queries: ['q_totals'] })).byId.q_totals).rows[0]!;
    const narrow = ok((await data('dash_9f2a', { queries: ['q_totals'], params: { dateRange: 'last_30d' } })).byId.q_totals).rows[0]!;
    expect(narrow.orders as number).toBeLessThan(wide.orders as number);
    expect(narrow.orders as number).toBeGreaterThan(0);
    const months = ok((await data('dash_9f2a', { queries: ['q_rev_by_month'], params: { dateRange: 'last_30d' } })).byId.q_rev_by_month);
    expect(months.rows.map((r) => r.order_date)).toEqual(['2026-10-01', '2026-11-01']);
  });

  it('rejects unknown or invalid params', async () => {
    const unknown = await data('dash_9f2a', { queries: ['q_totals'], params: { region: 'EU' } });
    expect(unknown.res.status).toBe(400);
    expect(JSON.parse(unknown.text).error.code).toBe('unknown_param');
    const invalid = await data('dash_9f2a', { queries: ['q_totals'], params: { dateRange: 'last_2y' } });
    expect(invalid.res.status).toBe(400);
    expect(JSON.parse(invalid.text).error.code).toBe('invalid_param');
  });

  it('validates the request shape', async () => {
    expect((await data('dash_9f2a', { queries: [] })).res.status).toBe(400);
    expect((await data('dash_9f2a', { queries: ['DROP TABLE x;'] })).res.status).toBe(400);
    expect((await data('dash_9f2a', { queries: ['q_totals'], version: 0 })).res.status).toBe(400);
  });

  it('isolates failures to the query that failed', async () => {
    const { lines, byId } = await data('dash_9f2a', { queries: ['q_totals', 'q_not_here'] });
    expect(lines).toHaveLength(2);
    expect(byId.q_totals?.ok).toBe(true);
    expect(byId.q_not_here).toEqual({ id: 'q_not_here', ok: false, error: expect.objectContaining({ code: 'unknown_query' }) });
  });

  it('reports engines that are not built yet (the doc example points at Snowflake)', async () => {
    const doc = { ...docExample, id: 'doc_example' };
    expect((await call('PUT', '/v1/dashboards/doc_example', { body: { spec: doc } })).status).toBe(201);
    const { byId } = await data('doc_example', { queries: ['q_rev_by_month'] });
    expect(byId.q_rev_by_month).toMatchObject({ ok: false, error: { code: 'engine_unavailable' } });
  });

  it('runs against a pinned version', async () => {
    const v2 = structuredClone(salesOverview) as any;
    delete v2.queries.q_totals;
    delete v2.widgets.w_orders;
    delete v2.widgets.w_aov;
    v2.layout = v2.layout.filter((l: { i: string }) => l.i !== 'w_orders' && l.i !== 'w_aov');
    v2.params.dateRange.bind = v2.params.dateRange.bind.filter((b: string) => b !== 'q_totals.filters');
    expect((await call('PUT', '/v1/dashboards/dash_9f2a', { body: { spec: v2 } })).status).toBe(200);

    expect((await data('dash_9f2a', { queries: ['q_totals'] })).byId.q_totals?.ok).toBe(false);
    const pinned = await data('dash_9f2a', { queries: ['q_totals'], version: 1 });
    expect(pinned.res.headers.get('X-Dashboard-Version')).toBe('1');
    expect(pinned.byId.q_totals?.ok).toBe(true);
  });
});
