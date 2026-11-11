import { stableStringify, type ApiErrorBody, type Cell, type DataResponseLine, type QueryResult, type RuntimeFilter, type StoredDashboard } from '@yourorg/bi-spec';

/**
 * A per-request variant of a saved query (spec 1.3): cross-filters from another widget's selection,
 * or a drill-down step. The server only accepts what the dashboard declares (see runtimeFilters and
 * drillQuery in the spec package).
 */
export interface QueryRuntime {
  filters?: RuntimeFilter[];
  drill?: { widget: string; level: number; path: Cell[] };
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Response key of a request: the query id, or "<queryId>~<hash>" for a variant. */
export function requestKey(queryId: string, runtime?: QueryRuntime): string {
  if (!runtime || (!runtime.filters?.length && !runtime.drill)) return queryId;
  return `${queryId}~${hash(stableStringify(runtime))}`;
}
import { readNdjson } from './ndjson';

export interface QueryRequest {
  dashboardId: string;
  version: number;
  queryId: string;
  /** All effective param values; sent to the backend, which applies the bound ones. */
  params: Record<string, unknown>;
  /** Only the params this query depends on: keys the session cache, so unrelated changes don't refetch. */
  cacheParams: Record<string, unknown>;
  /** Spec 1.3: cross-filters / drill for this widget's copy of the query. */
  runtime?: QueryRuntime;
  /**
   * Cancels this caller's interest (params changed, widget unmounted). The HTTP request itself is
   * only aborted once no caller still wants any query in it.
   */
  signal?: AbortSignal;
}

/** Everything the renderer needs from the backend. Swap it out in tests or custom transports. */
export interface DataClient {
  getDashboard(id: string, version?: number): Promise<StoredDashboard>;
  fetchQuery(request: QueryRequest): Promise<QueryResult>;
}

export class BIRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpDataClientOptions {
  apiUrl: string;
  /** A token, or a function returning a fresh one (called before every request). */
  token: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  /** Session cache lifetime for query results. Default 60 s. */
  cacheTtlMs?: number;
  /** Most query results kept in the session cache (least recently used are evicted). Default 200. */
  maxCacheEntries?: number;
  /** Retries after a network error or 5xx (never 4xx: those won't fix themselves). Default 2. */
  retries?: number;
  /** First retry delay; doubles each attempt, with jitter. Default 300 ms. */
  retryDelayMs?: number;
  /** Pass AbortSignals to `fetch`. Default: detected (true in browsers). */
  passSignalToFetch?: boolean;
}

export function abortError(): Error {
  return typeof DOMException === 'function' ? new DOMException('The request was cancelled.', 'AbortError') : Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

/**
 * Whether this runtime's fetch accepts our AbortSignal. Mixed environments (jsdom's AbortController
 * with Node's fetch, some polyfills) reject foreign signals outright; there we still drop
 * cancelled waiters, we just can't stop the bytes already on the wire.
 */
let signalSupport: boolean | undefined;
function fetchAcceptsSignal(signal: AbortSignal): boolean {
  if (signalSupport === undefined) {
    try {
      if (typeof Request !== 'function') signalSupport = true;
      else {
        new Request('http://localhost/', { signal });
        signalSupport = true;
      }
    } catch {
      signalSupport = false;
    }
  }
  return signalSupport;
}

interface Waiter {
  resolve(result: QueryResult): void;
  reject(error: Error): void;
}

interface PendingBatch {
  dashboardId: string;
  version: number;
  params: Record<string, unknown>;
  waiters: Map<string, Waiter[]>;
  /** What each response key asks for (a plain query id, or a variant). */
  specs: Map<string, { query: string; runtime?: QueryRuntime }>;
  controller: AbortController;
}

interface CacheEntry {
  /** Set when the result lands; TTL counts from then. In-flight entries never expire. */
  settledAt?: number;
  promise: Promise<QueryResult>;
  /** Callers still interested; at zero (before settling) the underlying request is cancelled. */
  subscribers: number;
  cancel(): void;
}

/**
 * HTTP data client.
 * - batches every query requested in the same tick into one POST (one round-trip per load)
 * - dedupes identical requests and caches results in memory for the session (LRU-bounded)
 * - reads the NDJSON response as a stream, so each widget gets its data as soon as it lands
 * - cancels work nobody is waiting for, and retries transient failures with backoff
 */
export class HttpDataClient implements DataClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingBatch>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly retries: number;
  private readonly retryDelay: number;
  private readonly apiUrl: string;

  constructor(private readonly options: HttpDataClientOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.ttl = options.cacheTtlMs ?? 60_000;
    this.maxEntries = Math.max(1, options.maxCacheEntries ?? 200);
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelay = options.retryDelayMs ?? 300;
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
  }

  private async headers(json: boolean): Promise<Record<string, string>> {
    const token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
    return { Authorization: `Bearer ${token}`, Accept: json ? 'application/json' : 'application/x-ndjson', ...(json ? {} : { 'Content-Type': 'application/json' }) };
  }

  private async fail(response: Response): Promise<never> {
    let code = 'http_error';
    let message = `Request failed with status ${response.status}.`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body?.error) ({ code, message } = body.error);
    } catch {
      /* not JSON */
    }
    throw new BIRequestError(response.status, code, message);
  }

  async getDashboard(id: string, version?: number): Promise<StoredDashboard> {
    const url = `${this.apiUrl}/v1/dashboards/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`;
    const response = await this.withRetry(async () => {
      const r = await this.fetchImpl(url, { headers: await this.headers(true) });
      if (!r.ok) await this.fail(r);
      return r;
    });
    return (await response.json()) as StoredDashboard;
  }

  fetchQuery(request: QueryRequest): Promise<QueryResult> {
    if (request.signal?.aborted) return Promise.reject(abortError());
    const key = `${request.dashboardId}@${request.version}:${requestKey(request.queryId, request.runtime)}:${stableStringify(request.cacheParams)}:${request.runtime ? stableStringify(request.runtime) : ''}`;
    let entry = this.cache.get(key);
    if (entry && entry.settledAt !== undefined && Date.now() - entry.settledAt >= this.ttl) {
      this.cache.delete(key);
      entry = undefined;
    }
    if (entry) {
      // Re-insert so Map order stays least-recently-used first.
      this.cache.delete(key);
      this.cache.set(key, entry);
    } else {
      entry = this.start(key, request);
    }
    return this.subscribe(entry, request.signal);
  }

  private start(key: string, request: QueryRequest): CacheEntry {
    let remove: () => void = () => {};
    const promise = new Promise<QueryResult>((resolve, reject) => {
      remove = this.enqueue(request, { resolve, reject });
    });
    const entry: CacheEntry = {
      promise,
      subscribers: 0,
      cancel: () => {
        if (this.cache.get(key) === entry) this.cache.delete(key);
        remove();
      },
    };
    promise.then(
      () => {
        entry.settledAt = Date.now();
      },
      () => {
        if (this.cache.get(key) === entry) this.cache.delete(key); // never cache failures
      },
    );
    this.cache.set(key, entry);
    this.evict();
    return entry;
  }

  private subscribe(entry: CacheEntry, signal: AbortSignal | undefined): Promise<QueryResult> {
    entry.subscribers++;
    // Callers without a signal can never lose interest, so their subscription is permanent.
    if (!signal || entry.settledAt !== undefined) return entry.promise;
    return new Promise<QueryResult>((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        reject(abortError());
        entry.subscribers--;
        // Deferred: React runs an effect's cleanup right before the next effect, which usually
        // re-subscribes to the same (unchanged) query. Only cancel if nobody came back.
        queueMicrotask(() => {
          if (entry.subscribers === 0 && entry.settledAt === undefined) entry.cancel();
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (result) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /** Bound the cache: drop least-recently-used settled results; in-flight ones are dedupe targets. */
  private evict() {
    if (this.cache.size <= this.maxEntries) return;
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.maxEntries) break;
      if (entry.settledAt !== undefined) this.cache.delete(key);
    }
  }

  /** Drops cached results, e.g. after the host knows data changed. */
  clearCache(): void {
    for (const [key, entry] of this.cache) if (entry.settledAt !== undefined) this.cache.delete(key);
  }

  /** Number of cached (or in-flight) results; exposed for tests and diagnostics. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Queues a request into this tick's batch; returns a function that withdraws it. */
  private enqueue(request: QueryRequest, waiter: Waiter): () => void {
    const batchKey = `${request.dashboardId}@${request.version}:${stableStringify(request.params)}`;
    let batch = this.pending.get(batchKey);
    if (!batch) {
      const created: PendingBatch = {
        dashboardId: request.dashboardId,
        version: request.version,
        params: request.params,
        waiters: new Map(),
        specs: new Map(),
        controller: new AbortController(),
      };
      batch = created;
      this.pending.set(batchKey, created);
      queueMicrotask(() => {
        this.pending.delete(batchKey);
        if (created.waiters.size > 0) void this.flush(created);
      });
    }
    const rkey = requestKey(request.queryId, request.runtime);
    const list = batch.waiters.get(rkey) ?? [];
    list.push(waiter);
    batch.waiters.set(rkey, list);
    batch.specs.set(rkey, { query: request.queryId, ...(rkey !== request.queryId ? { runtime: request.runtime } : {}) });
    const b = batch;
    return () => {
      const current = b.waiters.get(rkey);
      if (!current) return;
      const rest = current.filter((w) => w !== waiter);
      if (rest.length) b.waiters.set(rkey, rest);
      else b.waiters.delete(rkey);
      waiter.reject(abortError());
      // Nobody wants anything from this request any more: stop the server work too.
      if (b.waiters.size === 0) b.controller.abort();
    };
  }

  private isRetryable(error: unknown): boolean {
    if (isAbortError(error)) return false;
    if (error instanceof BIRequestError) return error.status >= 500;
    return true; // fetch rejects with TypeError on network failure; a broken stream throws too
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  private backoff(attempt: number): number {
    // Exponential with ±25% jitter, so many dashboards retrying after a blip don't stampede.
    return this.retryDelay * 2 ** attempt * (0.75 + Math.random() * 0.5);
  }

  private async withRetry<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (signal?.aborted || attempt >= this.retries || !this.isRetryable(error)) throw error;
        await this.sleep(this.backoff(attempt), signal);
      }
    }
  }

  private async flush(batch: PendingBatch) {
    const settle = (id: string, fn: (w: Waiter) => void) => {
      batch.waiters.get(id)?.forEach(fn);
      batch.waiters.delete(id);
    };
    const signal = batch.controller.signal;
    try {
      // A retry asks only for the queries still unanswered (a stream may break part-way).
      await this.withRetry(async () => {
        const response = await this.fetchImpl(`${this.apiUrl}/v1/dashboards/${encodeURIComponent(batch.dashboardId)}/data`, {
          method: 'POST',
          headers: await this.headers(false),
          body: JSON.stringify({
            version: batch.version,
            queries: [...batch.waiters.keys()].map((k) => {
              const spec = batch.specs.get(k);
              return spec?.runtime ? { query: spec.query, key: k, ...spec.runtime } : (spec?.query ?? k);
            }),
            params: batch.params,
          }),
          ...((this.options.passSignalToFetch ?? fetchAcceptsSignal(signal)) ? { signal } : {}),
        });
        if (!response.ok) await this.fail(response);
        for await (const raw of readNdjson(response)) {
          const line = raw as DataResponseLine;
          if (line.ok) settle(line.id, (w) => w.resolve(line.result));
          else settle(line.id, (w) => w.reject(new BIRequestError(200, line.error.code, line.error.message)));
        }
      }, signal);
      for (const id of [...batch.waiters.keys()]) {
        settle(id, (w) => w.reject(new BIRequestError(200, 'missing_result', `The server sent no result for "${id}".`)));
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const id of [...batch.waiters.keys()]) settle(id, (w) => w.reject(err));
    }
  }
}

export function createHttpDataClient(options: HttpDataClientOptions): HttpDataClient {
  return new HttpDataClient(options);
}
