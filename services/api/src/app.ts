import {
  coerceParamValue,
  DATA_SOURCE_TYPES,
  effectiveParamValues,
  ID_PATTERN,
  NDJSON_CONTENT_TYPE,
  validateDashboard,
  runtimeFilters,
  type DrillConfig,
  type RenderableWidget,
  SHARE_AUDIENCES,
  type ApiErrorBody,
  type CreateShareResponse,
  type ShareAudience,
  type ShareIntrospection,
  type SourceSummary,
  type StoredDashboard,
  type ValidDashboard,
} from '@yourorg/bi-spec';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import { getPath } from 'hono/utils/url';
import { AssistantDeclinedError, type ChatMessage, type DashboardAssistant } from './ai/assistant';
import { Recommender } from './ai/recommender';
import type { Principal, TokenVerifier } from './auth';
import type { EngineRegistry } from './data/engine';
import { UploadError } from './data/files/ingest';
import { runQuery, type QueryServices, type QueryVariant } from './data/run';
import { attributesWithin, loadRlsPolicies, type RlsPolicies } from './rls';
import { parseAttributes } from './auth';
import { SampleEngine, SampleSources } from './data/sample/engine';
import type { SourceCatalog } from './data/sources';
import { HttpError, VersionConflictError } from './errors';
import { RateLimiter } from './guard/limits';
import { silentLogger, type Logger } from './obs/logger';
import { isShareToken, newShare, publicShare, verifyShareToken, type ShareStore } from './sharing/store';
import { registerPlatformRoutes, type PlatformServices } from './routes/platform';
import type { Metrics } from './obs/metrics';
import type { DashboardRecord, DashboardStore } from './store/types';

export interface AppOptions {
  store: DashboardStore;
  auth: TokenVerifier;
  engines: EngineRegistry;
  /** Source listing, profiling and uploads. Defaults to the sample datasets only (no uploads). */
  sources?: SourceCatalog;
  now?: () => Date;
  queryTimeoutMs?: number;
  /** Origins allowed to call the API directly from a browser. Host apps behind a proxy need none. */
  corsOrigins?: string[];
  maxBodyBytes?: number;
  /** Phase 4. Defaults to rules-only recommendations (no LLM). */
  recommender?: Recommender;
  /** Phase 5: result cache, per-team query concurrency and query metrics. */
  queryServices?: QueryServices;
  metrics?: Metrics;
  logger?: Logger;
  /** Per-team requests per minute, by route group. 0 or missing disables that limit. */
  rateLimits?: Partial<Record<RateLimitBucket, number>>;
  /** When set, GET /metrics requires "Authorization: Bearer <metricsToken>". */
  metricsToken?: string;
  /** The Studio's dashboard assistant (Claude). Without it, the assistant routes report it as off. */
  assistant?: DashboardAssistant | null;
  /** Platform features (workstream D): comments, favorites, usage, subscriptions, alerts, catalog, … */
  platform?: PlatformServices;
  /** Read-only share grants. Without it, sharing routes answer 503. */
  shares?: ShareStore;
  /** Row-level security policies. Default: BI_RLS_POLICIES (parsed at startup; malformed = refuse to start). */
  rls?: RlsPolicies;
  /** Public URL of the hosted viewer app; share links are `<viewerUrl>#token=<token>`. Wins over publicHosts. */
  viewerUrl?: string;
  /**
   * Hostnames the app is served on (e.g. "sratchpad.example.com"). When viewerUrl is unset, a share
   * link is built from the request's host if, and only if, it is on this list: the viewer is served
   * by the same app at `viewerPath`. A forged Host header never ends up in a link.
   */
  publicHosts?: string[];
  /** Where the single-container deployment serves the viewer. Default "/view/". */
  viewerPath?: string;
  /**
   * Also answer every route under this prefix (e.g. "/bi-api", what the frontends call). The prefix
   * is stripped before routing, so /bi-api/v1/… and /v1/… are the same route.
   */
  pathPrefix?: string;
}

export type RateLimitBucket = 'data' | 'recommendations' | 'uploads' | 'writes' | 'assistant';

type Env = { Variables: { principal: Principal; requestId: string } };

export const MAX_QUERIES_PER_REQUEST = 50;
const UPLOAD_PATH = '/v1/sources/files';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toStored(r: DashboardRecord): StoredDashboard {
  return { id: r.id, version: r.version, title: r.title, specVersion: r.specVersion, createdAt: r.createdAt, createdBy: r.createdBy, spec: r.spec };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body must be valid JSON.');
  }
}

function dashboardId(c: Context): string {
  const id = c.req.param('id');
  if (!id || !ID_PATTERN.test(id)) {
    throw new HttpError(400, 'invalid_id', 'Dashboard ids start with a letter and use only letters, digits, "_" or "-".');
  }
  return id;
}

function parseVersion(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_version', `${name} must be a positive integer.`);
  return n;
}

function notFound(id: string, version?: number): HttpError {
  // Same answer whether the dashboard is missing or belongs to another team: no existence leaks.
  return new HttpError(404, 'not_found', version ? `Dashboard "${id}" has no version ${version}.` : `Dashboard "${id}" was not found.`);
}

function loadValid(record: DashboardRecord): ValidDashboard {
  const result = validateDashboard(record.spec, { allowNewerMinor: false });
  if (!result.ok) {
    throw new HttpError(500, 'stored_spec_invalid', `Stored dashboard "${record.id}" v${record.version} no longer validates.`, {
      errors: result.errors,
    });
  }
  return result.dashboard;
}

function normalizeAttributes(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) throw new Error('"attributes" must be an object like {"region": ["EU"]}.');
  const out: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(raw)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`"${name}" is not an attribute name.`);
    if (!Array.isArray(values) || !values.length || values.length > 100 || !values.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200)) {
      throw new Error(`"attributes.${name}" must be a list of 1–100 strings.`);
    }
    out[name] = [...new Set(values as string[])];
  }
  return out;
}

interface QueryEntry {
  queryId: string;
  variant?: QueryVariant;
}

const VARIANT_KEY = /^[A-Za-z0-9_.~-]{1,160}$/;

/**
 * `queries` lists saved query ids, or (spec 1.3) variants of them:
 *   { "query": "q_rev", "key": "q_rev~1", "filters"?: [cross-filters], "drill"?: { "widget", "level", "path" } }
 * Variants are derived only from author-declared config: cross-filters must fit the dashboard's
 * declared dimensions (runtimeFilters) and drills must follow a widget's saved levels (drillQuery).
 */
function parseQueryEntries(raw: unknown, dashboard: ValidDashboard): QueryEntry[] {
  const bad = () => new HttpError(400, 'invalid_queries', `"queries" must list 1–${MAX_QUERIES_PER_REQUEST} query ids or {"query", "key", "filters"?, "drill"?} entries.`);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUERIES_PER_REQUEST) throw bad();
  const entries: QueryEntry[] = [];
  const keys = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      if (!ID_PATTERN.test(item)) throw bad();
      if (keys.has(item)) continue;
      keys.add(item);
      entries.push({ queryId: item });
      continue;
    }
    if (!isRecord(item) || typeof item.query !== 'string' || !ID_PATTERN.test(item.query)) throw bad();
    const key = item.key === undefined ? item.query : item.key;
    if (typeof key !== 'string' || !VARIANT_KEY.test(key)) throw new HttpError(400, 'invalid_queries', 'A query "key" uses letters, digits, "_", ".", "~" or "-" (max 160).');
    if (keys.has(key)) throw new HttpError(400, 'invalid_queries', `Duplicate query key "${key}".`);
    keys.add(key);
    const variant: QueryVariant = { key };
    if (item.filters !== undefined) {
      const filters = runtimeFilters(dashboard, item.query, item.filters);
      if (!filters.ok) throw new HttpError(400, 'invalid_filters', filters.message);
      variant.filters = filters.filters;
    }
    if (item.drill !== undefined) {
      const d = item.drill;
      if (!isRecord(d) || typeof d.widget !== 'string') throw new HttpError(400, 'invalid_drill', '"drill" must be {"widget", "level", "path"}.');
      const widget = dashboard.widgets[d.widget] as (RenderableWidget & { drill?: DrillConfig }) | undefined;
      if (!widget || widget.type === '__unsupported__' || widget.query !== item.query || !widget.drill) {
        throw new HttpError(400, 'invalid_drill', `Widget "${d.widget}" has no drill-down on query "${item.query}".`);
      }
      if (typeof d.level !== 'number' || !Array.isArray(d.path)) throw new HttpError(400, 'invalid_drill', '"drill" needs a numeric "level" and a "path" list.');
      variant.drill = { config: widget.drill, level: d.level, path: d.path };
    }
    entries.push({ queryId: item.query, variant });
  }
  return entries;
}

/** Rejects params the dashboard does not declare or whose values do not fit, then merges defaults. */
function resolveParams(dashboard: ValidDashboard, raw: unknown) {
  if (raw !== undefined && !isRecord(raw)) throw new HttpError(400, 'invalid_params', '"params" must be an object.');
  const provided = (raw ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(provided)) {
    const param = dashboard.params[name];
    if (!param) throw new HttpError(400, 'unknown_param', `Dashboard "${dashboard.id}" has no param "${name}".`);
    const coerced = coerceParamValue(param, value);
    if (!coerced.ok) throw new HttpError(400, 'invalid_param', `Param "${name}": ${coerced.message}.`);
  }
  return effectiveParamValues(dashboard, provided);
}

const SHARE_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/v1\/share$/],
  ['GET', /^\/v1\/dashboards$/],
  ['GET', /^\/v1\/dashboards\/([^/]+)$/],
  ['POST', /^\/v1\/dashboards\/([^/]+)\/data$/],
];

/** Share tokens can only read the dashboard they were created for. */
function assertShareRoute(method: string, path: string, dashboardId: string) {
  for (const [m, re] of SHARE_ROUTES) {
    const match = re.exec(path);
    if (method !== m || !match) continue;
    if (match[1] !== undefined && decodeURIComponent(match[1]) !== dashboardId) {
      throw new HttpError(404, 'not_found', `Dashboard "${decodeURIComponent(match[1])}" was not found.`);
    }
    return;
  }
  throw new HttpError(403, 'forbidden', 'A share token can only read the dashboard it was created for.');
}

/** A pinned share serves only its version; an unpinned share follows the latest (or any version asked for). */
function shareVersion(c: Context<Env>, requested: number | undefined, id: string): number | undefined {
  const pinned = c.get('principal').share?.version;
  if (pinned === undefined) return requested;
  if (requested !== undefined && requested !== pinned) throw notFound(id, requested);
  return pinned;
}

function defaultCatalog(engines: EngineRegistry, now: () => Date): SourceCatalog {
  return { providers: engines.sample instanceof SampleEngine ? [new SampleSources(engines.sample, now)] : [] };
}

export function createApp(options: AppOptions) {
  const { store, auth, engines } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.queryTimeoutMs ?? 15_000;
  const sources = options.sources ?? defaultCatalog(engines, now);
  const recommender = options.recommender ?? new Recommender();
  const logger = options.logger ?? silentLogger;
  const metrics = options.metrics;
  // Parsed at startup, so a malformed BI_RLS_POLICIES stops the server rather than serving unfiltered rows.
  const services: QueryServices = { metrics, logger, rls: options.rls ?? loadRlsPolicies(), ...options.queryServices };
  const limiters = Object.fromEntries(
    Object.entries(options.rateLimits ?? {}).map(([bucket, perMinute]) => [bucket, new RateLimiter(perMinute ?? 0)]),
  ) as Partial<Record<RateLimitBucket, RateLimiter>>;
  const prefix = options.pathPrefix ? `/${options.pathPrefix.replace(/^\/+|\/+$/g, '')}` : '';
  const app = new Hono<Env>({
    getPath: (req) => {
      const path = getPath(req);
      return prefix && (path === prefix || path.startsWith(`${prefix}/`)) ? path.slice(prefix.length) || '/' : path;
    },
  });

  /** Per-team token bucket; 429 with Retry-After when empty. */
  const limit = (bucket: RateLimitBucket) => async (c: Context<Env>, next: () => Promise<void>) => {
    const limiter = limiters[bucket];
    const wait = limiter ? limiter.take(c.get('principal').teamId) : 0;
    if (wait > 0) {
      metrics?.rateLimited.inc({ limit: bucket });
      c.header('Retry-After', String(wait));
      throw new HttpError(429, 'rate_limited', `Too many ${bucket} requests for your team. Retry in ${wait} s.`);
    }
    await next();
  };

  /** Streams one NDJSON line per query, in completion order (shared by saved and draft dashboards). */
  const streamQueries = (c: Context<Env>, dashboard: ValidDashboard, queries: QueryEntry[], values: ReturnType<typeof resolveParams>) => {
    const principal = c.get('principal');
    const { teamId } = principal;
    const at = now();
    const bypassCache = /no-cache|no-store/i.test(c.req.header('Cache-Control') ?? '');
    c.header('Content-Type', `${NDJSON_CONTENT_TYPE}; charset=utf-8`);
    c.header('Cache-Control', 'no-store');
    return stream(c, async (out) => {
      const disconnected = new AbortController();
      out.onAbort(() => disconnected.abort());
      await Promise.all(
        queries.map(async ({ queryId, variant }) => {
          const line = await runQuery(queryId, { dashboard, values, engines, teamId, now: at, timeoutMs, signal: disconnected.signal, services, bypassCache, principal, variant });
          if (!out.aborted) await out.write(`${JSON.stringify(line)}\n`);
        }),
      );
    });
  };

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
      return c.json(body, error.status);
    }
    logger.error('unhandled error', { requestId: c.get('requestId'), method: c.req.method, path: c.req.path, error });
    return c.json<ApiErrorBody>({ error: { code: 'internal', message: 'Internal server error.' } }, 500);
  });
  app.notFound((c) => c.json<ApiErrorBody>({ error: { code: 'not_found', message: 'No such route.' } }, 404));

  if (options.corsOrigins?.length) {
    app.use(
      '*',
      cors({
        origin: options.corsOrigins,
        allowHeaders: ['Authorization', 'Content-Type', 'Cache-Control', 'X-Request-Id'],
        allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
        exposeHeaders: ['ETag', 'X-Dashboard-Version', 'X-Request-Id', 'Retry-After'],
        maxAge: 600,
      }),
    );
  }

  // ── observability: request ids, access logs, HTTP metrics ──
  app.use('*', async (c, next) => {
    const incoming = c.req.header('X-Request-Id');
    const requestId = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    const started = performance.now();
    try {
      await next();
    } finally {
      // Route pattern (e.g. /v1/dashboards/:id), never the raw path: keeps metric labels bounded.
      const route = [...c.req.matchedRoutes].reverse().find((r) => r.method !== 'ALL')?.path ?? 'unmatched';
      const seconds = (performance.now() - started) / 1000;
      const status = c.res.status;
      metrics?.httpRequests.inc({ method: c.req.method, route, status: String(status) });
      metrics?.httpDuration.observe({ route }, seconds);
      if (route !== '/healthz' && route !== '/metrics') {
        const principal = c.get('principal');
        logger[status >= 500 ? 'error' : 'info']('request', {
          requestId,
          method: c.req.method,
          route,
          status,
          ms: Math.round(seconds * 1000),
          ...(principal ? { team: principal.teamId } : {}),
        });
      }
    }
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/metrics', (c) => {
    if (!metrics) throw new HttpError(404, 'not_found', 'No such route.');
    if (options.metricsToken && c.req.header('Authorization') !== `Bearer ${options.metricsToken}`) {
      throw new HttpError(401, 'unauthorized', 'A valid metrics token is required.');
    }
    return c.text(metrics.render(), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  });

  // ── gateway: every /v1 request resolves to a team (and, for share tokens, one dashboard) ──
  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('Authorization');
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const token = match?.[1];
    let principal: Principal | null = null;
    if (token && isShareToken(token)) {
      const share = options.shares ? await verifyShareToken(options.shares, token, now()) : null;
      if (share) {
        principal = {
          teamId: share.teamId,
          subject: `share:${share.id}`,
          role: 'viewer',
          share: { id: share.id, dashboardId: share.dashboardId, version: share.version },
          // Row-level security: a share sees what its creator granted it (a subset of their own access).
          ...(share.attributes ? { attributes: share.attributes } : {}),
        };
        options.shares!.touch(share.id, now().toISOString()).catch((error: unknown) => logger.warn('share touch failed', { error }));
      }
    } else if (token) {
      principal = await auth.verify(token);
    }
    if (!principal) {
      c.header('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized', 'A valid bearer token is required.');
    }
    c.set('principal', principal);
    if (principal.share) assertShareRoute(c.req.method, c.req.path, principal.share.dashboardId);
    await next();
  });

  /** Authoring routes: editors only (team viewers and share tokens are read-only). */
  const editor = async (c: Context<Env>, next: () => Promise<void>) => {
    const p = c.get('principal');
    if (p.share || (p.role ?? 'editor') !== 'editor') {
      throw new HttpError(403, 'forbidden', 'This action needs the editor role; your access is read-only.');
    }
    await next();
  };
  const tooLarge = (c: Context) => c.json<ApiErrorBody>({ error: { code: 'payload_too_large', message: 'The request body is too large.' } }, 413);
  const jsonLimit = bodyLimit({ maxSize: options.maxBodyBytes ?? 1024 * 1024, onError: tooLarge });
  // Uploads have their own, larger limit (on the route below); everything else is small JSON.
  app.use('/v1/*', (c, next) => (c.req.path === UPLOAD_PATH ? next() : jsonLimit(c, next)));

  // ── dashboard store ──
  app.get('/v1/dashboards', async (c) => {
    const { teamId, share } = c.get('principal');
    const all = await store.list(teamId);
    return c.json({ dashboards: share ? all.filter((d) => d.id === share.dashboardId) : all });
  });

  app.get('/v1/dashboards/:id', async (c) => {
    const id = dashboardId(c);
    const version = shareVersion(c, parseVersion(c.req.query('version'), '"version"'), id);
    const record = await store.get(c.get('principal').teamId, id, version);
    if (!record) throw notFound(id, version);
    try {
      options.platform?.onDashboardView?.(c.get('principal'), id);
    } catch {
      /* usage analytics must never break reads */
    }
    c.header('ETag', `"${record.version}"`);
    return c.json(toStored(record));
  });

  app.get('/v1/dashboards/:id/versions', async (c) => {
    const id = dashboardId(c);
    if (c.get('principal').share) throw notFound(id);
    const versions = await store.listVersions(c.get('principal').teamId, id);
    if (!versions.length) throw notFound(id);
    return c.json({ id, versions });
  });

  app.put('/v1/dashboards/:id', editor, limit('writes'), async (c) => {
    const { teamId, subject } = c.get('principal');
    const id = dashboardId(c);
    const body = await readJson(c);
    if (!isRecord(body) || !('spec' in body)) {
      throw new HttpError(400, 'invalid_body', 'Expected {"spec": {...}, "expectedVersion"?: number}.');
    }
    const expected = body.expectedVersion;
    if (expected !== undefined && (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)) {
      throw new HttpError(400, 'invalid_expected_version', '"expectedVersion" must be a non-negative integer (0 = create only).');
    }
    const result = validateDashboard(body.spec, { allowNewerMinor: false });
    if (!result.ok) {
      throw new HttpError(422, 'invalid_spec', `The dashboard spec has ${result.errors.length} error(s).`, {
        errors: result.errors,
        warnings: result.warnings,
      });
    }
    if (result.dashboard.id !== id) {
      throw new HttpError(422, 'id_mismatch', `The spec's id "${result.dashboard.id}" does not match the URL ("${id}").`);
    }
    try {
      const record = await store.save({
        teamId,
        id,
        title: result.dashboard.title,
        specVersion: result.dashboard.specVersion,
        spec: body.spec,
        createdBy: subject,
        expectedVersion: expected as number | undefined,
      });
      c.header('ETag', `"${record.version}"`);
      return c.json({ ...toStored(record), warnings: result.warnings }, record.version === 1 ? 201 : 200);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        throw new HttpError(409, 'version_conflict', error.message, { currentVersion: error.currentVersion });
      }
      throw error;
    }
  });

  // ── query layer: one batched round-trip per dashboard load, streamed per query ──
  app.post('/v1/dashboards/:id/data', limit('data'), async (c) => {
    const { teamId } = c.get('principal');
    const id = dashboardId(c);
    const body = await readJson(c);
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body', 'Expected {"queries": [...], "params"?: {...}, "version"?: number}.');
    if (body.params !== undefined && !isRecord(body.params)) throw new HttpError(400, 'invalid_params', '"params" must be an object.');
    const version = shareVersion(c, parseVersion(body.version, '"version"'), id);

    const record = await store.get(teamId, id, version);
    if (!record) throw notFound(id, version);
    const dashboard = loadValid(record);
    const queries = parseQueryEntries(body.queries, dashboard);
    const values = resolveParams(dashboard, body.params);
    c.header('X-Dashboard-Version', String(record.version));
    return streamQueries(c, dashboard, queries, values);
  });

  // ── authoring preview: run queries of an unsaved draft ──
  app.post('/v1/preview/data', editor, limit('data'), async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !('spec' in body)) {
      throw new HttpError(400, 'invalid_body', 'Expected {"spec": {...}, "queries": [...], "params"?: {...}}.');
    }
    if (body.params !== undefined && !isRecord(body.params)) throw new HttpError(400, 'invalid_params', '"params" must be an object.');
    // Same bar as saving: a draft runs only if it would be accepted by PUT /v1/dashboards/:id.
    const result = validateDashboard(body.spec, { allowNewerMinor: false });
    if (!result.ok) {
      throw new HttpError(422, 'invalid_spec', `The dashboard spec has ${result.errors.length} error(s).`, {
        errors: result.errors,
        warnings: result.warnings,
      });
    }
    const queries = parseQueryEntries(body.queries, result.dashboard);
    const values = resolveParams(result.dashboard, body.params);
    return streamQueries(c, result.dashboard, queries, values);
  });

  // ── sources: catalog, profiler, uploads ──
  app.get('/v1/sources', editor, async (c) => {
    const { teamId } = c.get('principal');
    const lists = await Promise.all(
      sources.providers.map(async (p) => {
        try {
          return await p.list(teamId);
        } catch (error) {
          // One unreachable warehouse must not hide the sample data and uploads.
          logger.warn('listing sources failed', { requestId: c.get('requestId'), type: p.type, error });
          return [] as SourceSummary[];
        }
      }),
    );
    return c.json({ sources: lists.flat() });
  });

  app.get('/v1/sources/profile', editor, async (c) => {
    const { teamId } = c.get('principal');
    const type = c.req.query('type') ?? '';
    const ref = c.req.query('ref') ?? '';
    if (!(DATA_SOURCE_TYPES as readonly string[]).includes(type)) {
      throw new HttpError(400, 'invalid_source', `"type" must be one of ${DATA_SOURCE_TYPES.join(', ')}.`);
    }
    if (!ref || ref.length > 512) throw new HttpError(400, 'invalid_source', '"ref" is required (max 512 characters).');
    const provider = sources.providers.find((p) => p.type === type);
    const profile = provider ? await provider.profile(teamId, ref) : null;
    // Same answer for "missing", "another team's" and "engine not configured": no existence leaks.
    if (!profile) throw new HttpError(404, 'not_found', `Source ${type}:${ref} was not found.`);
    return c.json(profile);
  });

  // ── AI recommendations: profile → rule candidates → (Claude) ranking → starter dashboard ──
  app.post('/v1/recommendations', editor, limit('recommendations'), async (c) => {
    const { teamId } = c.get('principal');
    const body = await readJson(c);
    const source = isRecord(body) ? body.source : undefined;
    if (!isRecord(source) || typeof source.type !== 'string' || typeof source.ref !== 'string') {
      throw new HttpError(400, 'invalid_body', 'Expected {"source": {"type": "...", "ref": "..."}}.');
    }
    const { type, ref } = source;
    if (!(DATA_SOURCE_TYPES as readonly string[]).includes(type)) {
      throw new HttpError(400, 'invalid_source', `"source.type" must be one of ${DATA_SOURCE_TYPES.join(', ')}.`);
    }
    if (!ref || ref.length > 512) throw new HttpError(400, 'invalid_source', '"source.ref" is required (max 512 characters).');
    const provider = sources.providers.find((p) => p.type === type);
    const profile = provider ? await provider.profile(teamId, ref) : null;
    if (!profile) throw new HttpError(404, 'not_found', `Source ${type}:${ref} was not found.`);
    // Display name: uploads and samples list cheaply; warehouse tables are named by their ref.
    let sourceName = ref.split('.').pop() ?? ref;
    if (type !== 'snowflake') {
      const listed = await provider!.list(teamId).catch(() => []);
      sourceName = listed.find((s) => s.source.ref === ref)?.name ?? sourceName;
    }
    const disconnected = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => disconnected.abort(), { once: true });
    const response = await recommender.recommend({ source: { type, ref }, sourceName, profile, signal: disconnected.signal });
    metrics?.recommendations.inc({ generated_by: response.generatedBy });
    return c.json(response);
  });

  // ── sharing: read-only grants for apps and business viewers ──
  const publicHosts = new Set((options.publicHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  const viewerPath = `/${(options.viewerPath ?? '/view/').replace(/^\/+|\/+$/g, '')}/`;
  /** The viewer's base URL for this request (ending in "/"), or undefined if it can't be known safely. */
  const viewerBase = (c: Context<Env>): string | undefined => {
    if (options.viewerUrl) return `${options.viewerUrl.replace(/\/+$/, '')}/`;
    // Behind a load balancer the original host/scheme arrive in X-Forwarded-*; first hop wins.
    const host = (c.req.header('X-Forwarded-Host') ?? c.req.header('Host') ?? '').split(',')[0]!.trim().toLowerCase();
    if (!host || !publicHosts.has(host)) return undefined;
    const forwarded = (c.req.header('X-Forwarded-Proto') ?? '').split(',')[0]!.trim().toLowerCase();
    const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : new URL(c.req.url).protocol.replace(':', '');
    return `${proto}://${host}${viewerPath}`;
  };
  const shareStore = () => {
    if (!options.shares) throw new HttpError(503, 'sharing_unavailable', 'Sharing is not enabled on this server.');
    return options.shares;
  };

  app.post('/v1/dashboards/:id/shares', editor, limit('writes'), async (c) => {
    const { teamId, subject } = c.get('principal');
    const id = dashboardId(c);
    const shares = shareStore();
    const body = await readJson(c);
    if (!isRecord(body)) throw new HttpError(400, 'invalid_body', 'Expected {"audience": "app" | "viewer", "label"?, "version"?, "expiresInDays"?}.');
    const audience = body.audience;
    if (typeof audience !== 'string' || !(SHARE_AUDIENCES as readonly string[]).includes(audience)) {
      throw new HttpError(400, 'invalid_audience', '"audience" must be "app" (read the JSON from an application) or "viewer" (view it in the browser).');
    }
    if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 100)) {
      throw new HttpError(400, 'invalid_label', '"label" must be a string of at most 100 characters.');
    }
    const days = body.expiresInDays;
    if (days !== undefined && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365)) {
      throw new HttpError(400, 'invalid_expiry', '"expiresInDays" must be a whole number from 1 to 365 (omit it for no expiry).');
    }
    const version = parseVersion(body.version, '"version"');
    // Row-level security: the share sees the creator's attributes, or a narrower set they choose
    // ({"region": ["EU"]} or "region=EU"), never more than the creator has.
    const creator = c.get('principal');
    let attributes = creator.attributes;
    if (body.attributes !== undefined) {
      let requested: Record<string, string[]>;
      try {
        requested = typeof body.attributes === 'string' ? parseAttributes(body.attributes, '"attributes"') : normalizeAttributes(body.attributes);
      } catch (error) {
        throw new HttpError(400, 'invalid_attributes', (error as Error).message);
      }
      const problem = attributesWithin(requested, creator.attributes);
      if (problem) throw new HttpError(403, 'forbidden', problem);
      attributes = requested;
    }
    const record = await store.get(teamId, id, version);
    if (!record) throw notFound(id, version);
    const at = now();
    const label = (body.label as string | undefined)?.trim() || (audience === 'app' ? 'Application access' : 'Viewer link');
    const { record: share, token } = newShare(
      {
        teamId,
        dashboardId: id,
        audience: audience as ShareAudience,
        label,
        version,
        createdBy: subject,
        expiresAt: days ? new Date(at.getTime() + (days as number) * 86_400_000).toISOString() : undefined,
        ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
      },
      at,
    );
    await shares.insert(share);
    logger.info('share created', { requestId: c.get('requestId'), team: teamId, dashboard: id, share: share.id, audience, by: subject });
    const response: CreateShareResponse = {
      share: publicShare(share),
      token,
      ...(audience === 'viewer' && viewerBase(c) ? { viewerUrl: `${viewerBase(c)}#token=${token}` } : {}),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(response, 201);
  });

  app.get('/v1/dashboards/:id/shares', editor, async (c) => {
    const { teamId } = c.get('principal');
    const id = dashboardId(c);
    const list = await shareStore().list(teamId, id);
    return c.json({ shares: list.map(publicShare) });
  });

  app.delete('/v1/dashboards/:id/shares/:shareId', editor, async (c) => {
    const { teamId, subject } = c.get('principal');
    const id = dashboardId(c);
    const shareId = c.req.param('shareId');
    const ok = await shareStore().revoke(teamId, id, shareId, now().toISOString());
    if (!ok) throw new HttpError(404, 'not_found', `Share "${shareId}" was not found.`);
    logger.info('share revoked', { requestId: c.get('requestId'), team: teamId, dashboard: id, share: shareId, by: subject });
    return c.body(null, 204);
  });

  /** Called with a share token: what it grants, so a viewer or app needs only the token. */
  app.get('/v1/share', async (c) => {
    const { teamId, share } = c.get('principal');
    if (!share) throw new HttpError(400, 'not_a_share_token', 'Call this route with a share token.');
    const record = await shareStore().get(share.id);
    const latest = await store.get(teamId, share.dashboardId);
    if (!record || !latest) throw notFound(share.dashboardId);
    const body: ShareIntrospection = {
      share: {
        id: record.id,
        dashboardId: record.dashboardId,
        audience: record.audience,
        label: record.label,
        ...(record.version !== undefined ? { version: record.version } : {}),
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      },
      dashboard: { id: latest.id, title: latest.title, latestVersion: latest.version },
    };
    return c.json(body);
  });

  // ── dashboard assistant (Studio chat): edits an unsaved draft; never saves ──
  app.get('/v1/assistant', editor, (c) => c.json({ enabled: Boolean(options.assistant), ...(options.assistant ? { model: options.assistant.modelName } : {}) }));

  app.post('/v1/assistant/chat', editor, limit('assistant'), async (c) => {
    if (!options.assistant) throw new HttpError(503, 'assistant_unavailable', 'The assistant is not enabled on this server.');
    const { teamId } = c.get('principal');
    const body = await readJson(c);
    if (!isRecord(body) || !isRecord(body.draft) || !Array.isArray(body.messages)) {
      throw new HttpError(400, 'invalid_body', 'Expected {"draft": {...}, "messages": [{"role", "content"}], "selectedWidgetId"?}.');
    }
    const messages = body.messages as unknown[];
    if (messages.length < 1 || messages.length > 50) throw new HttpError(400, 'invalid_messages', 'Send 1–50 messages.');
    const valid = messages.every(
      (m): m is ChatMessage => isRecord(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0 && m.content.length <= 10_000,
    );
    if (!valid) throw new HttpError(400, 'invalid_messages', 'Each message needs role "user" or "assistant" and non-empty content (max 10,000 characters).');
    if ((messages[messages.length - 1] as ChatMessage).role !== 'user') throw new HttpError(400, 'invalid_messages', 'The last message must be from the user.');
    const selected = body.selectedWidgetId;
    if (selected !== undefined && selected !== null && (typeof selected !== 'string' || !ID_PATTERN.test(selected))) {
      throw new HttpError(400, 'invalid_body', '"selectedWidgetId" must be a widget id.');
    }
    const disconnected = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => disconnected.abort(), { once: true });
    try {
      const result = await options.assistant.chat({
        teamId,
        draft: body.draft,
        messages: messages as ChatMessage[],
        selectedWidgetId: typeof selected === 'string' ? selected : undefined,
        signal: disconnected.signal,
      });
      metrics?.assistantTurns.inc({ outcome: result.changed ? 'changed' : 'unchanged' });
      return c.json(result);
    } catch (error) {
      if (error instanceof AssistantDeclinedError) {
        metrics?.assistantTurns.inc({ outcome: 'declined' });
        throw new HttpError(422, 'assistant_declined', 'The assistant declined this request. Try rephrasing it.');
      }
      if (disconnected.signal.aborted) throw error;
      metrics?.assistantTurns.inc({ outcome: 'error' });
      logger.warn('assistant turn failed', { requestId: c.get('requestId'), error });
      throw new HttpError(502, 'assistant_failed', 'The assistant could not finish this request. Try again.');
    }
  });

  if (options.platform) {
    registerPlatformRoutes(app, { services: options.platform, store, logger, metrics, now, editor: editor as never, readJson });
  }

  const uploads = sources.uploads;
  app.post(
    UPLOAD_PATH,
    editor,
    limit('uploads'),
    bodyLimit({ maxSize: (uploads?.maxBytes ?? 0) + 1024 * 1024, onError: tooLarge }), // + multipart framing
    async (c) => {
      if (!uploads) throw new HttpError(503, 'engine_unavailable', 'File uploads are not enabled on this server.');
      const { teamId, subject } = c.get('principal');
      if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
        throw new HttpError(400, 'invalid_body', 'Send the file as multipart/form-data in a field named "file".');
      }
      let form: Record<string, unknown>;
      try {
        form = await c.req.parseBody();
      } catch {
        throw new HttpError(400, 'invalid_body', 'The multipart body could not be parsed.');
      }
      const file = form.file;
      if (!(file instanceof File)) throw new HttpError(400, 'missing_file', 'Send the file in a multipart field named "file".');
      if (file.size > uploads.maxBytes) {
        throw new HttpError(413, 'file_too_large', `Uploads are limited to ${Math.round(uploads.maxBytes / 1024 / 1024)} MB.`);
      }
      try {
        const result = await uploads.upload({ teamId, subject, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        return c.json(result, 201);
      } catch (error) {
        if (error instanceof UploadError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
    },
  );

  return app;
}

export type App = ReturnType<typeof createApp>;
