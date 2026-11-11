import { applyParams, drillQuery, type DataResponseLine, type DataSource, type DrillConfig, type Filter, type ParamValues, type Query, type QueryResult, type ValidDashboard } from '@yourorg/bi-spec';
import type { Principal } from '../auth';
import { loadRlsPolicies, rowAccess, type RlsPolicies } from '../rls';
import { QueueFullError, type QueryGate } from '../guard/limits';
import type { Logger } from '../obs/logger';
import type { Metrics } from '../obs/metrics';
import { resultCacheKey, type ResultCache } from './cache';
import { expandMetrics, type MetricCatalog } from './metrics';
import { attachJoinSources } from './sql/joins';
import { EngineError, type Engine, type EngineRegistry } from './engine';

/** Phase 5 hardening shared by every query: result cache, per-team concurrency, metrics. */
export interface QueryServices {
  cache?: ResultCache;
  cacheTtlSeconds?: number;
  gate?: QueryGate;
  metrics?: Metrics;
  logger?: Logger;
  /** Team metric catalog (workstream A expands references; workstream D stores it). */
  metricCatalog?: MetricCatalog;
  /** Row-level security policies. Default: BI_RLS_POLICIES from the environment (never "none" by omission). */
  rls?: RlsPolicies;
}

/** A per-request variant of a saved query, derived only from author-declared config (validated by the caller). */
export interface QueryVariant {
  /** Id of the response line (client-chosen, distinguishes variants of one query). Default: the query id. */
  key?: string;
  /** Extra filters, e.g. validated cross-filters. */
  filters?: Filter[];
  /** Drill-down: the widget's saved levels, the level and the clicked path (checked by drillQuery). */
  drill?: { config: DrillConfig; level: number; path: unknown[] };
}

export interface RunContext {
  dashboard: ValidDashboard;
  values: ParamValues;
  engines: EngineRegistry;
  teamId: string;
  now: Date;
  timeoutMs: number;
  /** Aborted when the client disconnects. */
  signal?: AbortSignal;
  services?: QueryServices;
  /** Skip cache reads (the client sent Cache-Control: no-cache); fresh results are still stored. */
  bypassCache?: boolean;
  /** Who is asking: row-level security filters by their attributes. Missing = no attributes (fail closed). */
  principal?: Principal;
  variant?: QueryVariant;
}

/** Identical queries in flight at the same time (same key, same cache) share one engine execution. */
const inFlightByCache = new WeakMap<ResultCache, Map<string, Promise<QueryResult>>>();

async function execute(engine: Engine, source: DataSource, query: Query, ctx: RunContext, signal: AbortSignal): Promise<QueryResult> {
  const { gate, metrics } = ctx.services ?? {};
  const release = gate ? await gate.acquire(ctx.teamId, signal) : () => {};
  const started = performance.now();
  try {
    return await raceAbort(engine.execute(source, query, { teamId: ctx.teamId, signal }), signal);
  } finally {
    release();
    metrics?.queryDuration.observe({ engine: source.type }, (performance.now() - started) / 1000);
  }
}

async function cachedExecute(engine: Engine, source: DataSource, query: Query, ctx: RunContext, signal: AbortSignal): Promise<QueryResult> {
  const { cache, metrics, logger } = ctx.services ?? {};
  const ttl = ctx.services?.cacheTtlSeconds ?? 0;
  if (!cache || ttl <= 0) return execute(engine, source, query, ctx, signal);
  const key = resultCacheKey(ctx.teamId, source, query);
  let inFlight = inFlightByCache.get(cache);
  if (!inFlight) inFlightByCache.set(cache, (inFlight = new Map()));
  if (!ctx.bypassCache) {
    try {
      const hit = await cache.get(key);
      if (hit) {
        metrics?.cache.inc({ result: 'hit' });
        return { ...hit, cached: true };
      }
      metrics?.cache.inc({ result: 'miss' });
    } catch (error) {
      // A broken cache must never break dashboards: fall through to the engine.
      metrics?.cache.inc({ result: 'error' });
      logger?.warn('result cache read failed', { error });
    }
    const shared = inFlight.get(key);
    if (shared) {
      try {
        return structuredClone(await raceAbort(shared, signal));
      } catch (error) {
        // The shared run failed for its own caller (e.g. that client went away): run our own.
        if (signal.aborted || error instanceof EngineError) throw error;
      }
    }
  } else {
    metrics?.cache.inc({ result: 'bypass' });
  }
  const run = execute(engine, source, query, ctx, signal).then((result) => {
    if (!result.asOf) result.asOf = ctx.now.toISOString();
    cache.set(key, result, ttl).catch((error: unknown) => {
      metrics?.cache.inc({ result: 'error' });
      logger?.warn('result cache write failed', { error });
    });
    return result;
  });
  if (!ctx.bypassCache && !inFlight.has(key)) {
    const map = inFlight;
    map.set(key, run);
    const done = () => {
      if (map.get(key) === run) map.delete(key);
    };
    run.then(done, done);
  }
  return structuredClone(await run);
}

/** AbortSignal.any, with a fallback for runtimes that lack it (e.g. jsdom in tests). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) return (controller.abort(s.reason), controller.signal);
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms).unref?.();
  return controller.signal;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Runs one of a dashboard's stored queries. Clients name queries by id; they never send query
 * bodies, so a host app can only ever run what an author saved. Failures become an error line
 * for that query alone.
 */
export async function runQuery(queryId: string, ctx: RunContext): Promise<DataResponseLine> {
  const lineId = ctx.variant?.key ?? queryId;
  const query = ctx.dashboard.queries[queryId];
  if (!query) {
    return { id: lineId, ok: false, error: { code: 'unknown_query', message: `Query "${queryId}" is not part of this dashboard.` } };
  }
  const source = ctx.dashboard.dataSources[query.source]!;
  const engine = ctx.engines[source.type];
  if (!engine) {
    return { id: lineId, ok: false, error: { code: 'engine_unavailable', message: `No engine serves "${source.type}" data sources.` } };
  }

  const timeout = timeoutSignal(ctx.timeoutMs);
  const signal = ctx.signal ? anySignal([ctx.signal, timeout]) : timeout;
  const started = performance.now();
  const metrics = ctx.services?.metrics;
  const fail = (code: string, message: string): DataResponseLine => {
    metrics?.queries.inc({ engine: source.type, outcome: code });
    return { id: lineId, ok: false, error: { code, message } };
  };

  // The concrete query: saved query + params, then the variant (drill level, cross-filters), then
  // row-level security, then metric references. All before the cache, so its key covers all of it.
  let resolved: Query = applyParams(ctx.dashboard, queryId, ctx.values, ctx.now);
  const drill = ctx.variant?.drill;
  if (drill) {
    const drilled = drillQuery(resolved, drill.config, drill.level, drill.path);
    if (!drilled.ok) return fail('invalid_drill', drilled.message);
    resolved = drilled.query;
  }
  if (ctx.variant?.filters?.length) resolved = { ...resolved, filters: [...resolved.filters, ...ctx.variant.filters] };
  let policies: RlsPolicies;
  try {
    policies = ctx.services?.rls ?? loadRlsPolicies();
  } catch {
    return fail('rls_misconfigured', 'Row-level security is misconfigured on this server, so no data is shown.');
  }
  const access = rowAccess(policies, ctx.teamId, ctx.principal, source);
  if (!access.ok) return fail('rls_denied', access.message);
  if (access.filters.length) resolved = { ...resolved, filters: [...resolved.filters, ...access.filters] };
  // Joined sources: row-level security can only filter the primary source today, so a join with a
  // row-secured source is refused rather than read unfiltered (fail closed).
  for (const join of (resolved as { joins?: Array<{ source: string }> }).joins ?? []) {
    const joined = ctx.dashboard.dataSources[join.source];
    if (!joined) continue;
    const joinedAccess = rowAccess(policies, ctx.teamId, ctx.principal, joined);
    if (!joinedAccess.ok) return fail('rls_denied', joinedAccess.message);
    if (joinedAccess.filters.length) return fail('rls_denied', 'Row-level security: joining a row-secured source is not supported yet.');
  }
  resolved = attachJoinSources(resolved, ctx.dashboard.dataSources);

  try {
    if (ctx.services?.metricCatalog) resolved = expandMetrics(resolved, await ctx.services.metricCatalog.get(ctx.teamId));
    const result = await cachedExecute(engine, source, resolved, ctx, signal);
    // Every engine reads live, so the data is as of this request. Engines (or a result cache)
    // that know better set asOf themselves.
    if (!result.asOf) result.asOf = ctx.now.toISOString();
    metrics?.queries.inc({ engine: source.type, outcome: result.cached ? 'cache_hit' : 'ok' });
    return { id: lineId, ok: true, result, ms: Math.round(performance.now() - started) };
  } catch (error) {
    if (error instanceof EngineError) return fail(error.code, error.message);
    if (error instanceof QueueFullError) {
      metrics?.rateLimited.inc({ limit: 'concurrent_queries' });
      return fail('rate_limited', 'Too many queries are running for your team right now. Try again shortly.');
    }
    if (timeout.aborted) return fail('timeout', `The query took longer than ${ctx.timeoutMs} ms.`);
    if (signal.aborted) return fail('cancelled', 'The request was cancelled.');
    (ctx.services?.logger ?? { error: (m: string, f: unknown) => console.error(m, f) }).error('query failed', { queryId, engine: source.type, error });
    return fail('query_failed', 'The query failed unexpectedly.');
  }
}
