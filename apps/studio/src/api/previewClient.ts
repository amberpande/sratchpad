import { createHttpDataClient, type DataClient, type HttpDataClient, type QueryRequest } from '@yourorg/bi-renderer';
import { stableStringify, type ApiErrorBody, type DataResponseLine, type Issue, type PreviewRequestBody, type QueryResult, type StoredDashboard } from '@yourorg/bi-spec';
import { queryFingerprint } from '../draft/renderable';
import { readNdjson } from './ndjson';

/**
 * Live preview of an UNSAVED draft: a DataClient whose fetchQuery posts the draft spec to
 * POST /v1/preview/data. Like the SDK's HTTP client it batches every query requested in one tick
 * into one request, dedupes and caches per session, and streams NDJSON.
 *
 * Results are cached by what they depend on (query body, source, bound params and values), so
 * dragging or retitling a widget never refetches; editing a query refetches only that query.
 *
 * If the backend has no preview route (404), mode flips to "unsupported" and queries that are
 * unchanged since the last save are fetched from the saved version instead.
 */

export type PreviewMode = 'unknown' | 'live' | 'unsupported';

export interface SavedRef {
  id: string;
  version: number;
  spec: unknown;
}

export class PreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Waiter {
  request: QueryRequest;
  resolve(result: QueryResult): void;
  reject(error: Error): void;
}

interface Batch {
  spec: unknown;
  saved: SavedRef | null;
  params: Record<string, unknown>;
  waiters: Map<string, Waiter[]>;
}

export interface PreviewClientOptions {
  apiUrl: string;
  token: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  cacheTtlMs?: number;
  onModeChange?: (mode: PreviewMode) => void;
}

export class PreviewDataClient {
  private readonly cache = new Map<string, { at: number; promise: Promise<QueryResult> }>();
  private readonly pending = new Map<string, Batch>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly apiUrl: string;
  private readonly saved: HttpDataClient;
  private modeValue: PreviewMode = 'unknown';

  constructor(private readonly options: PreviewClientOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.ttl = options.cacheTtlMs ?? 60_000;
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    // Fallback path reuses the SDK's own client against the saved dashboard.
    this.saved = createHttpDataClient({ apiUrl: options.apiUrl, token: options.token, fetch: options.fetch });
  }

  get mode(): PreviewMode {
    return this.modeValue;
  }

  private setMode(mode: PreviewMode) {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    this.options.onModeChange?.(mode);
  }

  /** A DataClient bound to one draft snapshot (and the last saved version, for the fallback). */
  forDraft(spec: unknown, saved: SavedRef | null): DataClient {
    return {
      getDashboard: (): Promise<StoredDashboard> => Promise.reject(new PreviewError('unsupported', 'The preview client only runs draft queries.')),
      fetchQuery: (request) => this.fetchQuery(spec, saved, request),
    };
  }

  clearCache(): void {
    this.cache.clear();
    this.saved.clearCache();
  }

  private fetchQuery(spec: unknown, saved: SavedRef | null, request: QueryRequest): Promise<QueryResult> {
    if (this.modeValue === 'unsupported') return this.fromSaved(spec, saved, request);
    const key = `preview:${queryFingerprint(spec, request.queryId)}:${stableStringify(request.cacheParams)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.promise;
    const promise = new Promise<QueryResult>((resolve, reject) => this.enqueue(spec, saved, { request, resolve, reject }));
    this.cache.set(key, { at: Date.now(), promise });
    promise.catch(() => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key); // never cache failures
    });
    return promise;
  }

  private enqueue(spec: unknown, saved: SavedRef | null, waiter: Waiter) {
    // One batch per draft snapshot; all widgets render from the same param values, so merge them.
    const batchKey = stableStringify(spec);
    let batch = this.pending.get(batchKey);
    if (!batch) {
      batch = { spec, saved, params: {}, waiters: new Map() };
      this.pending.set(batchKey, batch);
      queueMicrotask(() => {
        this.pending.delete(batchKey);
        void this.flush(batch!);
      });
    }
    Object.assign(batch.params, waiter.request.params);
    const list = batch.waiters.get(waiter.request.queryId) ?? [];
    list.push(waiter);
    batch.waiters.set(waiter.request.queryId, list);
  }

  private async flush(batch: Batch) {
    const settle = (id: string, fn: (w: Waiter) => void) => {
      batch.waiters.get(id)?.forEach(fn);
      batch.waiters.delete(id);
    };
    try {
      const token = typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
      const body: PreviewRequestBody = { spec: batch.spec, queries: [...batch.waiters.keys()], params: batch.params };
      const response = await this.fetchImpl(`${this.apiUrl}/v1/preview/data`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        this.setMode('unsupported');
        for (const id of [...batch.waiters.keys()]) {
          settle(id, (w) => this.fromSaved(batch.spec, batch.saved, w.request).then(w.resolve, w.reject));
        }
        return;
      }
      if (!response.ok) throw await this.toError(response);
      this.setMode('live');
      for await (const raw of readNdjson(response)) {
        const line = raw as DataResponseLine;
        if (line.ok) settle(line.id, (w) => w.resolve(line.result));
        else settle(line.id, (w) => w.reject(new PreviewError(line.error.code, line.error.message)));
      }
      for (const id of [...batch.waiters.keys()]) settle(id, (w) => w.reject(new PreviewError('missing_result', `The server sent no result for "${id}".`)));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const id of [...batch.waiters.keys()]) settle(id, (w) => w.reject(err));
    }
  }

  private async toError(response: Response): Promise<PreviewError> {
    try {
      const { error } = (await response.json()) as ApiErrorBody;
      const issues = (error.details as { errors?: Issue[] } | undefined)?.errors;
      const detail = issues?.length ? ` (${issues[0]!.path}: ${issues[0]!.message})` : '';
      return new PreviewError(error.code, `${error.message}${detail}`);
    } catch {
      return new PreviewError('http_error', `Preview failed with status ${response.status}.`);
    }
  }

  /** Fallback when the backend can't preview drafts: run the saved version's identical query. */
  private fromSaved(spec: unknown, saved: SavedRef | null, request: QueryRequest): Promise<QueryResult> {
    if (!saved) {
      return Promise.reject(new PreviewError('preview_unavailable', 'This backend can’t preview unsaved drafts yet. Save the dashboard to see data.'));
    }
    if (queryFingerprint(spec, request.queryId) !== queryFingerprint(saved.spec, request.queryId)) {
      return Promise.reject(new PreviewError('preview_unavailable', 'Changed since the last save. This backend can’t preview drafts; save to see data.'));
    }
    return this.saved.fetchQuery({ ...request, dashboardId: saved.id, version: saved.version });
  }
}
