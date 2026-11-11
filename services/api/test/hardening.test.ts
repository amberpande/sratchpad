import type { DataResponseLine, DataSource, Query, QueryResult } from '@yourorg/bi-spec';
import { beforeEach, describe, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import {
  createApp,
  createLogger,
  defaultEngines,
  DEV_TOKENS,
  MemoryDashboardStore,
  MemoryResultCache,
  Metrics,
  QueryGate,
  QueueFullError,
  RateLimiter,
  resultCacheKey,
  StaticTokenVerifier,
  type App,
  type AppOptions,
  type Engine,
  type ExecuteContext,
} from '../src';

const NOW = new Date('2026-11-09T15:30:00Z');
const TEAM_A = 'dev-token-team-a';
const TEAM_B = 'dev-token-team-b';

/** Wraps the sample engine and counts executions. */
class CountingEngine implements Engine {
  calls = 0;
  constructor(
    private readonly inner: Engine,
    private readonly delayMs = 0,
  ) {}
  async execute(source: DataSource, query: Query, ctx: ExecuteContext): Promise<QueryResult> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.execute(source, query, ctx);
  }
}

function setup(extra: Partial<AppOptions> = {}, delayMs = 0) {
  const engines = defaultEngines(() => NOW);
  const sample = new CountingEngine(engines.sample!, delayMs);
  const metrics = new Metrics();
  const cache = new MemoryResultCache();
  const app = createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: { ...engines, sample },
    now: () => NOW,
    metrics,
    queryServices: { cache, cacheTtlSeconds: 60 },
    ...extra,
  });
  return { app, sample, metrics, cache };
}

async function seed(app: App, token = TEAM_A) {
  const res = await app.request('/v1/dashboards/dash_9f2a', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec: salesOverview }),
  });
  expect(res.status).toBe(201);
}

async function data(app: App, body: unknown, { token = TEAM_A, headers = {} as Record<string, string> } = {}) {
  const res = await app.request('/v1/dashboards/dash_9f2a/data', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const lines = res.ok ? (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as DataResponseLine) : [];
  return { res, lines };
}

const okResult = (line: DataResponseLine | undefined) => {
  if (!line?.ok) throw new Error(`expected ok, got ${JSON.stringify(line)}`);
  return line.result;
};

describe('result cache', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await seed(ctx.app);
  });

  it('serves repeat queries from the cache with the original asOf', async () => {
    const first = okResult((await data(ctx.app, { queries: ['q_totals'] })).lines[0]);
    expect(first.cached).toBeUndefined();
    expect(ctx.sample.calls).toBe(1);
    const second = okResult((await data(ctx.app, { queries: ['q_totals'] })).lines[0]);
    expect(second.cached).toBe(true);
    expect(second.rows).toEqual(first.rows);
    expect(second.asOf).toBe(first.asOf);
    expect(ctx.sample.calls).toBe(1);
    expect(ctx.metrics.cache.get({ result: 'hit' })).toBe(1);
    expect(ctx.metrics.queries.get({ engine: 'sample', outcome: 'cache_hit' })).toBe(1);
  });

  it('keys on resolved params, so another date range misses', async () => {
    await data(ctx.app, { queries: ['q_rev_by_month'] });
    await data(ctx.app, { queries: ['q_rev_by_month'], params: { dateRange: 'last_30d' } });
    expect(ctx.sample.calls).toBe(2);
  });

  it('never shares entries across teams', async () => {
    await seed(ctx.app, TEAM_B);
    await data(ctx.app, { queries: ['q_totals'] });
    const b = okResult((await data(ctx.app, { queries: ['q_totals'] }, { token: TEAM_B })).lines[0]);
    expect(b.cached).toBeUndefined();
    expect(ctx.sample.calls).toBe(2);
    const q = { source: 'orders', dimensions: [], measures: [], filters: [], orderBy: [], limit: 1 } as unknown as Query;
    expect(resultCacheKey('team-a', { type: 'sample', ref: 'orders' }, q)).not.toBe(resultCacheKey('team-b', { type: 'sample', ref: 'orders' }, q));
  });

  it('Cache-Control: no-cache skips the read but refreshes the entry', async () => {
    await data(ctx.app, { queries: ['q_totals'] });
    const fresh = okResult((await data(ctx.app, { queries: ['q_totals'] }, { headers: { 'Cache-Control': 'no-cache' } })).lines[0]);
    expect(fresh.cached).toBeUndefined();
    expect(ctx.sample.calls).toBe(2);
    expect(ctx.metrics.cache.get({ result: 'bypass' })).toBe(1);
  });

  it('dedupes identical queries in flight', async () => {
    const slow = setup({}, 30);
    await seed(slow.app);
    const [a, b] = await Promise.all([data(slow.app, { queries: ['q_totals'] }), data(slow.app, { queries: ['q_totals'] })]);
    expect(okResult(a.lines[0]).rows).toEqual(okResult(b.lines[0]).rows);
    expect(slow.sample.calls).toBe(1);
  });

  it('a failing cache never breaks queries', async () => {
    const broken = setup({
      queryServices: {
        cacheTtlSeconds: 60,
        cache: { get: () => Promise.reject(new Error('redis down')), set: () => Promise.reject(new Error('redis down')) },
      },
    });
    await seed(broken.app);
    expect(okResult((await data(broken.app, { queries: ['q_totals'] })).lines[0]).rows.length).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(broken.metrics.cache.get({ result: 'error' })).toBe(2);
  });

  it('MemoryResultCache expires entries and evicts the least recently used', async () => {
    let t = 0;
    const cache = new MemoryResultCache(2, () => t);
    const r = (n: number): QueryResult => ({ columns: [], rows: [{ n }], truncated: false });
    await cache.set('a', r(1), 10);
    await cache.set('b', r(2), 10);
    await cache.get('a'); // a is now most recent
    await cache.set('c', r(3), 10);
    expect(await cache.get('b')).toBeUndefined();
    expect((await cache.get('a'))!.rows).toEqual([{ n: 1 }]);
    t = 11_000;
    expect(await cache.get('a')).toBeUndefined();
  });
});

describe('per-team guardrails', () => {
  it('rate limits by team with 429 and Retry-After', async () => {
    const { app, metrics } = setup({ rateLimits: { data: 2 } });
    await seed(app);
    await seed(app, TEAM_B);
    expect((await data(app, { queries: ['q_totals'] })).res.status).toBe(200);
    expect((await data(app, { queries: ['q_totals'] })).res.status).toBe(200);
    const limited = await data(app, { queries: ['q_totals'] });
    expect(limited.res.status).toBe(429);
    expect(Number(limited.res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await limited.res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Another team has its own budget.
    expect((await data(app, { queries: ['q_totals'] }, { token: TEAM_B })).res.status).toBe(200);
    expect(metrics.rateLimited.get({ limit: 'data' })).toBe(1);
  });

  it('RateLimiter refills over time', () => {
    let t = 0;
    const rl = new RateLimiter(60, 1, () => t);
    expect(rl.take('a')).toBe(0);
    expect(rl.take('a')).toBe(1);
    t = 1000;
    expect(rl.take('a')).toBe(0);
    expect(new RateLimiter(0).take('a')).toBe(0);
  });

  it('caps concurrent queries per team and rejects past the queue', async () => {
    const { app } = setup({ queryServices: { gate: new QueryGate(1, 0) } }, 20);
    await seed(app);
    const { lines } = await data(app, { queries: ['q_totals', 'q_rev_by_region'] });
    const byOk = lines.map((l) => (l.ok ? 'ok' : l.error.code)).sort();
    expect(byOk).toEqual(['ok', 'rate_limited']);
  });

  it('QueryGate queues fairly and hands slots over', async () => {
    const gate = new QueryGate(1, 1);
    const r1 = await gate.acquire('t');
    const second = gate.acquire('t');
    await expect(gate.acquire('t')).rejects.toBeInstanceOf(QueueFullError);
    expect(gate.active('t')).toBe(1);
    r1();
    const r2 = await second;
    expect(gate.active('t')).toBe(1);
    r2();
    expect(gate.active('t')).toBe(0);
    // A waiter that gives up leaves the queue.
    const r3 = await gate.acquire('t');
    const ac = new AbortController();
    const waiting = gate.acquire('t', ac.signal);
    ac.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    r3();
    expect(gate.active('t')).toBe(0);
  });
});

describe('observability', () => {
  it('tags responses with a request id (echoing a safe incoming one)', async () => {
    const { app } = setup();
    const res = await app.request('/healthz', { headers: { 'X-Request-Id': 'abc-123' } });
    expect(res.headers.get('X-Request-Id')).toBe('abc-123');
    const generated = await app.request('/healthz', { headers: { 'X-Request-Id': 'bad id with spaces' } });
    expect(generated.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exposes Prometheus metrics labelled by route pattern, optionally behind a token', async () => {
    const { app } = setup({ metricsToken: 'secret' });
    await seed(app);
    await data(app, { queries: ['q_totals'] });
    expect((await app.request('/metrics')).status).toBe(401);
    const res = await app.request('/metrics', { headers: { Authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('bi_http_requests_total{method="POST",route="/v1/dashboards/:id/data",status="200"} 1');
    expect(text).toContain('bi_queries_total{engine="sample",outcome="ok"} 1');
    expect(text).toMatch(/bi_query_duration_seconds_count\{engine="sample"\} 1/);
    expect(text).not.toContain('dash_9f2a');
    expect(text).not.toContain('team-a');
  });

  it('writes one structured access log line per request, without tokens', async () => {
    const lines: string[] = [];
    const { app } = setup({ logger: createLogger({ format: 'json', write: (l) => lines.push(l) }) });
    await seed(app);
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry).toMatchObject({ level: 'info', msg: 'request', method: 'PUT', route: '/v1/dashboards/:id', status: 201, team: 'team-a' });
    expect(entry.requestId).toBeTruthy();
    expect(lines.join('\n')).not.toContain(TEAM_A);
  });
});
