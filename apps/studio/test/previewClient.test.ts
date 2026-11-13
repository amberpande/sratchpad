import type { QueryRequest } from '@yourorg/bi-renderer';
import { describe, expect, it, vi } from 'vitest';
import { PreviewDataClient } from '../src/api/previewClient';
import { add, blank } from './helpers';

const result = (n: number) => ({ columns: [{ name: 'v', type: 'number' as const }], rows: [{ v: n }], truncated: false });
const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
const req = (queryId: string, params: Record<string, unknown> = {}): QueryRequest => ({ dashboardId: 'dash_test', version: 0, queryId, params, cacheParams: params });

function spec() {
  return add(add(blank(), 'kpi').draft, 'line-chart').draft;
}

describe('preview data client', () => {
  it('sends cross-filter variants as their own entries (click-to-filter in the Studio, D-087)', async () => {
    const bodies: Array<{ queries: Array<string | { query: string; key: string; filters?: unknown[] }> }> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as (typeof bodies)[number];
      bodies.push(body);
      return ndjson(body.queries.map((q, i) => ({ id: typeof q === 'string' ? q : q.key, ok: true, result: result(i) })));
    });
    const view = new PreviewDataClient({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch }).forDraft(spec(), null);
    const runtime = { filters: [{ field: 'region', op: 'in' as const, values: ['Europe'] }] };
    const [plain, filtered] = await Promise.all([view.fetchQuery(req('q_kpi')), view.fetchQuery({ ...req('q_kpi'), runtime })]);
    expect(bodies[0]!.queries[0]).toBe('q_kpi');
    expect(bodies[0]!.queries[1]).toMatchObject({ query: 'q_kpi', filters: runtime.filters });
    expect(plain.rows[0]!.v).toBe(0);
    expect(filtered.rows[0]!.v).toBe(1);
  });

  it('batches one tick of requests into one POST of the draft and caches by query content', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { queries: string[]; spec: { id: string } };
      expect(body.spec.id).toBe('dash_test');
      return ndjson(body.queries.map((id, i) => ({ id, ok: true, result: result(i) })));
    });
    const client = new PreviewDataClient({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch });
    const draft = spec();
    const view = client.forDraft(draft, null);
    const [a, b] = await Promise.all([view.fetchQuery(req('q_kpi')), view.fetchQuery(req('q_line-chart'))]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/bi-api/v1/preview/data');
    expect(a.rows[0]!.v).toBe(0);
    expect(b.rows[0]!.v).toBe(1);
    expect(client.mode).toBe('live');

    // Moving a widget doesn't change its query: served from cache.
    const moved = { ...draft, layout: draft.layout.map((it) => ({ ...it, y: it.y + 5 })) };
    await client.forDraft(moved, null).fetchQuery(req('q_kpi'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('on a backend without the preview route, falls back to saved data for unchanged queries', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/v1/preview/data')) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such route.' } }), { status: 404 });
      const body = JSON.parse(String(init!.body)) as { queries: string[]; version: number };
      expect(body.version).toBe(3);
      return ndjson(body.queries.map((id) => ({ id, ok: true, result: result(42) })));
    });
    const modes: string[] = [];
    const client = new PreviewDataClient({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch, onModeChange: (m) => modes.push(m) });
    const saved = spec();
    const edited = { ...saved, queries: { ...saved.queries, q_kpi: { source: 'orders', measures: [{ field: 'quantity', agg: 'sum' as const }] } } };
    const view = client.forDraft(edited, { id: 'dash_test', version: 3, spec: saved });
    const [unchanged, changed] = await Promise.allSettled([view.fetchQuery(req('q_line-chart')), view.fetchQuery(req('q_kpi'))]);
    expect(modes).toEqual(['unsupported']);
    expect(unchanged).toMatchObject({ status: 'fulfilled', value: { rows: [{ v: 42 }] } });
    expect(changed).toMatchObject({ status: 'rejected', reason: { code: 'preview_unavailable' } });
    expect(calls).toEqual(['/bi-api/v1/preview/data', '/bi-api/v1/dashboards/dash_test/data']);

    // Unsaved dashboards say so clearly.
    await expect(client.forDraft(edited, null).fetchQuery(req('q_line-chart'))).rejects.toMatchObject({ code: 'preview_unavailable' });
  });

  it('surfaces a 422 from the server as a readable error', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'invalid_spec', message: 'Bad draft.', details: { errors: [{ path: 'queries.q.source', message: 'nope' }] } } }), { status: 422 }));
    const client = new PreviewDataClient({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.forDraft(spec(), null).fetchQuery(req('q_kpi'))).rejects.toThrow('Bad draft. (queries.q.source: nope)');
  });
});
