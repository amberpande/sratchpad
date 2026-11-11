import type { QueryResult } from '@yourorg/bi-spec';
import { describe, expect, it, vi } from 'vitest';
import { BIRequestError, createHttpDataClient, type QueryRequest } from '../src';

const result = (n: number): QueryResult => ({ columns: [{ name: 'n', type: 'number' }], rows: [{ n }], truncated: false });

/** A streamed NDJSON response, split into awkward chunks to exercise line reassembly. */
function ndjson(lines: unknown[], chunkSize = 7): Response {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

function serverFetch() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { queries: string[] };
    return ndjson(body.queries.map((id, i) => (id === 'q_bad' ? { id, ok: false, error: { code: 'unknown_field', message: 'nope' } } : { id, ok: true, result: result(i) })));
  });
}

const req = (queryId: string, params: Record<string, unknown> = {}, cacheParams = params): QueryRequest => ({
  dashboardId: 'd1',
  version: 3,
  queryId,
  params,
  cacheParams,
});

describe('HttpDataClient', () => {
  it('batches same-tick requests into one POST and dedupes identical ones', async () => {
    const fetch = serverFetch();
    const client = createHttpDataClient({ apiUrl: '/bi-api/', token: 't0k', fetch });
    const [a, b, a2] = await Promise.all([client.fetchQuery(req('q_a')), client.fetchQuery(req('q_b')), client.fetchQuery(req('q_a'))]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/bi-api/v1/dashboards/d1/data');
    expect(JSON.parse(String(init!.body))).toEqual({ version: 3, queries: ['q_a', 'q_b'], params: {} });
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer t0k');
    expect(a.rows[0]!.n).toBe(0);
    expect(b.rows[0]!.n).toBe(1);
    expect(a2).toBe(a);
  });

  it('serves repeat requests from the session cache, keyed by the params each query depends on', async () => {
    const fetch = serverFetch();
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch });
    await client.fetchQuery(req('q_a', { dateRange: 'last_30d', region: 'EU' }, { dateRange: 'last_30d' }));
    // region changed, but q_a doesn't depend on it → cache hit
    await client.fetchQuery(req('q_a', { dateRange: 'last_30d', region: 'NA' }, { dateRange: 'last_30d' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.fetchQuery(req('q_a', { dateRange: 'last_7d' }, { dateRange: 'last_7d' }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects only the query that failed and does not cache failures', async () => {
    const fetch = serverFetch();
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch });
    const [good, bad] = await Promise.allSettled([client.fetchQuery(req('q_a')), client.fetchQuery(req('q_bad'))]);
    expect(good.status).toBe('fulfilled');
    expect(bad).toMatchObject({ status: 'rejected', reason: { code: 'unknown_field', message: 'nope' } });
    await expect(client.fetchQuery(req('q_bad'))).rejects.toBeInstanceOf(BIRequestError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects queries the server never answered', async () => {
    const fetch = vi.fn(async () => ndjson([{ id: 'q_a', ok: true, result: result(1) }]));
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch });
    const [, missing] = await Promise.allSettled([client.fetchQuery(req('q_a')), client.fetchQuery(req('q_b'))]);
    expect(missing).toMatchObject({ status: 'rejected', reason: { code: 'missing_result' } });
  });

  it('surfaces API errors with their code', async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Dashboard "x" was not found.' } }), { status: 404 }),
    );
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: async () => 'fresh', fetch });
    await expect(client.getDashboard('x')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(client.fetchQuery(req('q_a'))).rejects.toMatchObject({ status: 404 });
  });
});

describe('HttpDataClient hardening', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('cancels a request when its only caller aborts, and aborts the HTTP request', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seenSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch, passSignalToFetch: true });
    const controller = new AbortController();
    const p = client.fetchQuery({ ...req('q_a'), signal: controller.signal });
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(seenSignal?.aborted).toBe(true);
    expect(client.cacheSize).toBe(0); // a cancelled request is never cached
  });

  it('keeps a deduped request alive while another caller still wants it', async () => {
    const fetch = serverFetch();
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch });
    const a = new AbortController();
    const first = client.fetchQuery({ ...req('q_a'), signal: a.signal });
    const second = client.fetchQuery({ ...req('q_a'), signal: new AbortController().signal });
    a.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({ rows: [{ n: 0 }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when a caller aborts and re-subscribes in the same tick (effect cleanup → re-run)', async () => {
    const fetch = serverFetch();
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch });
    const old = new AbortController();
    void client.fetchQuery({ ...req('q_a'), signal: old.signal }).catch(() => {});
    old.abort();
    const again = await client.fetchQuery({ ...req('q_a'), signal: new AbortController().signal });
    expect(again.rows[0]!.n).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('drops an aborted query from a batch that has not been sent yet', async () => {
    const fetch = serverFetch();
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch });
    const c = new AbortController();
    const a = client.fetchQuery({ ...req('q_a'), signal: c.signal });
    const b = client.fetchQuery(req('q_b'));
    c.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await b;
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).queries).toEqual(['q_b']);
  });

  it('retries network errors and 5xx with backoff, asking only for unanswered queries', async () => {
    let call = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      call++;
      if (call === 1) throw new TypeError('Failed to fetch');
      if (call === 2) return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'busy' } }), { status: 503 });
      const body = JSON.parse(String(init?.body)) as { queries: string[] };
      return ndjson(body.queries.map((id) => ({ id, ok: true, result: result(call) })));
    });
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch, retryDelayMs: 1 });
    const [a, b] = await Promise.all([client.fetchQuery(req('q_a')), client.fetchQuery(req('q_b'))]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(a.rows[0]!.n).toBe(3);
    expect(b.rows[0]!.n).toBe(3);
  });

  it('does not retry 4xx, and gives up after the retry budget', async () => {
    const fetch4 = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'no' } }), { status: 403 }));
    const c4 = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch: fetch4, retryDelayMs: 1 });
    await expect(c4.fetchQuery(req('q_a'))).rejects.toMatchObject({ status: 403 });
    expect(fetch4).toHaveBeenCalledTimes(1);

    const fetch5 = vi.fn(async () => new Response('oops', { status: 502 }));
    const c5 = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch: fetch5, retries: 2, retryDelayMs: 1 });
    await expect(c5.fetchQuery(req('q_a'))).rejects.toMatchObject({ status: 502 });
    expect(fetch5).toHaveBeenCalledTimes(3);
  });

  it('bounds the session cache with an LRU of maxCacheEntries', async () => {
    const fetch = serverFetch();
    const client = createHttpDataClient({ apiUrl: '/bi-api', token: 't', fetch, maxCacheEntries: 2 });
    await client.fetchQuery(req('q_a'));
    await client.fetchQuery(req('q_b'));
    await client.fetchQuery(req('q_a')); // touch: q_b is now least recently used
    expect(fetch).toHaveBeenCalledTimes(2);
    await client.fetchQuery(req('q_c')); // evicts q_b
    expect(client.cacheSize).toBe(2);
    await client.fetchQuery(req('q_a'));
    expect(fetch).toHaveBeenCalledTimes(3);
    await client.fetchQuery(req('q_b'));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
