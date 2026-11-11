import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { DataResponseLine, QueryResult, SourceProfile, SourceSummary, UploadResponse } from '@yourorg/bi-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { createApp, DEV_TOKENS, MemoryDashboardStore, StaticTokenVerifier, type App } from '../src';
import { createDataLayer, type DataLayer } from '../src/data';
import { generateOrders } from '../src/data/sample/orders';

const NOW = new Date('2026-11-09T15:30:00Z');
const TEAM_A = 'dev-token-team-a';
const TEAM_B = 'dev-token-team-b';

let dataDir: string;
let layer: DataLayer;
let app: App;

function makeApp(dir: string, maxUploadBytes?: number) {
  layer = createDataLayer({ now: () => NOW, dataDir: dir, maxUploadBytes });
  app = createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: layer.engines,
    sources: layer.sources,
    now: () => NOW,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'bi-sources-'));
  makeApp(dataDir);
});

afterEach(async () => {
  await layer.close();
  await rm(dataDir, { recursive: true, force: true });
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function upload(name: string, content: string | Uint8Array, { token = TEAM_A, field = 'file' } = {}) {
  const form = new FormData();
  form.append(field, new File([content], name));
  return app.request('/v1/sources/files', { method: 'POST', headers: auth(token), body: form });
}

function get(path: string, token = TEAM_A) {
  return app.request(path, { headers: auth(token) });
}

function post(path: string, body: unknown, token = TEAM_A) {
  return app.request(path, { method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function lines(res: Response): Promise<Record<string, DataResponseLine>> {
  const text = await res.text();
  return Object.fromEntries(text.trim().split('\n').map((l) => JSON.parse(l) as DataResponseLine).map((l) => [l.id, l]));
}

const ok = (line: DataResponseLine | undefined): QueryResult => {
  if (!line?.ok) throw new Error(`expected ok, got ${JSON.stringify(line)}`);
  return line.result;
};

const CSV = [
  'day,region,amount,units,refunded,note',
  '2026-01-05,EU,100.50,1,false,first order',
  '2026-01-20,EU,50.25,2,false,',
  '2026-02-03,NA,200,3,true,"quoted, with comma"',
  '2026-02-04,,10,1,false,',
  '',
].join('\n');

/** A one-widget dashboard over a source, used for saved and draft (preview) runs. */
function fileDashboard(ref: string, id = 'dash_file') {
  return {
    specVersion: '1.0',
    id,
    title: 'From a file',
    dataSources: { upload: { type: 'file', ref } },
    queries: {
      q_by_region: {
        source: 'upload',
        dimensions: [{ field: 'region' }],
        measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: '*', agg: 'count' }],
      },
      q_by_month: { source: 'upload', dimensions: [{ field: 'day', grain: 'month' }], measures: [{ field: 'units', agg: 'sum' }] },
    },
    widgets: { w_table: { type: 'table', query: 'q_by_region' } },
    layout: [{ i: 'w_table', x: 0, y: 0, w: 12, h: 4 }],
  };
}

describe('POST /v1/sources/files', () => {
  it('parses a CSV once into Parquet, profiles it, and returns UploadResponse', async () => {
    const res = await upload('../../etc/sales Q1.csv', CSV);
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponse;
    expect(body.summary).toEqual({
      source: { type: 'file', ref: expect.stringMatching(/^file_[0-9a-f]{24}$/) },
      name: 'sales Q1.csv', // directories stripped
      rowCount: 4,
      createdAt: NOW.toISOString(),
    });
    const ref = body.summary.source.ref;
    expect(body.profile).toMatchObject({ source: { type: 'file', ref }, rowCount: 4, sampled: false, timeColumns: ['day'], measureCandidates: ['amount', 'units'] });
    expect(body.profile.columns.map((c) => [c.name, c.physicalType])).toEqual([
      ['day', 'time'],
      ['region', 'string'],
      ['amount', 'number'],
      ['units', 'number'],
      ['refunded', 'boolean'],
      ['note', 'string'],
    ]);
    expect(body.profile.columns.find((c) => c.name === 'region')).toMatchObject({ nullRate: 0.25, distinctCount: 2, sampleValues: ['EU', 'NA'] });

    // Only the columnar copy is kept; the original bytes are gone.
    expect(existsSync(join(dataDir, 'files', `${ref}.parquet`))).toBe(true);
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
  });

  it('accepts .xlsx workbooks (dates, numbers, booleans, formulas)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['when', 'team', 'score', 'active', 'double']);
    ws.addRow([new Date(Date.UTC(2026, 0, 5)), 'Red', 10.5, true, { formula: 'C2*2', result: 21 }]);
    ws.addRow([new Date(Date.UTC(2026, 1, 9)), 'Blue, Inc', 7, false, { formula: 'C3*2', result: 14 }]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const res = await upload('scores.xlsx', bytes);
    expect(res.status).toBe(201);
    const { summary, profile } = (await res.json()) as UploadResponse;
    expect(summary.rowCount).toBe(2);
    expect(profile.columns.map((c) => [c.name, c.physicalType])).toEqual([
      ['when', 'time'],
      ['team', 'string'],
      ['score', 'number'],
      ['active', 'boolean'],
      ['double', 'number'],
    ]);
    expect(profile.columns[0]).toMatchObject({ min: '2026-01-05', max: '2026-02-09', format: 'date' });
  });

  it('validates extension, content, size and the form field', async () => {
    const code = async (res: Response) => [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    expect(await code(await upload('data.txt', 'a,b\n1,2\n'))).toEqual([415, 'unsupported_file_type']);
    expect(await code(await upload('data.csv', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 1])))).toEqual([415, 'invalid_file_content']);
    expect(await code(await upload('data.xlsx', 'a,b\n1,2\n'))).toEqual([415, 'invalid_file_content']);
    expect(await code(await upload('data.csv', ''))).toEqual([422, 'empty_file']);
    expect(await code(await upload('data.csv', 'a,b\n1,2\n', { field: 'upload' }))).toEqual([400, 'missing_file']);
    const notMultipart = await app.request('/v1/sources/files', { method: 'POST', headers: { ...auth(TEAM_A), 'Content-Type': 'text/csv' }, body: 'a\n1\n' });
    expect(await code(notMultipart)).toEqual([400, 'invalid_body']);
    expect((await app.request('/v1/sources/files', { method: 'POST', body: new FormData() })).status).toBe(401);

    await layer.close();
    makeApp(dataDir, 1024);
    expect(await code(await upload('big.csv', `a\n${'1\n'.repeat(1000)}`))).toEqual([413, 'file_too_large']);
  });
});

describe('GET /v1/sources and /v1/sources/profile', () => {
  it('lists sample datasets plus this team’s uploads only', async () => {
    const { summary } = (await (await upload('mine.csv', CSV)).json()) as UploadResponse;
    const a = (await (await get('/v1/sources')).json()) as { sources: SourceSummary[] };
    expect(a.sources).toEqual([
      { source: { type: 'sample', ref: 'orders' }, name: 'orders', rowCount: expect.any(Number) },
      summary,
    ]);
    const b = (await (await get('/v1/sources', TEAM_B)).json()) as { sources: SourceSummary[] };
    expect(b.sources.map((s) => s.source.type)).toEqual(['sample']);
  });

  it('profiles a source the team can see, and 404s otherwise', async () => {
    const { summary } = (await (await upload('mine.csv', CSV)).json()) as UploadResponse;
    const ref = summary.source.ref;
    expect((await get(`/v1/sources/profile?type=file&ref=${ref}`)).status).toBe(200);
    expect((await get(`/v1/sources/profile?type=file&ref=${ref}`, TEAM_B)).status).toBe(404);
    expect((await get('/v1/sources/profile?type=file&ref=file_000000000000000000000000')).status).toBe(404);
    expect((await get('/v1/sources/profile?type=file&ref=../../manifest')).status).toBe(404);
    expect((await get('/v1/sources/profile?type=snowflake&ref=A.B.C')).status).toBe(404); // not configured
    expect((await get('/v1/sources/profile?type=mysql&ref=x')).status).toBe(400);
    expect((await get('/v1/sources/profile?type=file')).status).toBe(400);
  });

  it('profiles the sample orders dataset', async () => {
    const profile = (await (await get('/v1/sources/profile?type=sample&ref=orders')).json()) as SourceProfile;
    expect(profile).toMatchObject({
      source: { type: 'sample', ref: 'orders' },
      sampled: false,
      timeColumns: ['order_date'],
      measureCandidates: ['quantity', 'amount'],
      dimensionCandidates: ['region', 'category', 'channel', 'status'],
      keyCandidates: ['order_id', 'customer_id'],
    });
    const byName = Object.fromEntries(profile.columns.map((c) => [c.name, c]));
    expect(byName.region).toMatchObject({ semanticType: 'geo', role: 'dimension', cardinality: 'low', distinctCount: 4, nullRate: 0 });
    expect(byName.amount).toMatchObject({ physicalType: 'number', semanticType: 'numeric', format: 'currency' });
    expect(byName.order_id).toMatchObject({ semanticType: 'id', role: 'key', cardinality: 'unique' });
    expect(byName.order_date).toMatchObject({ physicalType: 'time', semanticType: 'temporal', format: 'date', max: '2026-11-09' });
    for (const c of profile.columns) expect(c.sampleValues.length).toBeLessThanOrEqual(5);
  });

  it('profiles the same data identically whether it is sample or an uploaded file', async () => {
    const orders = generateOrders(NOW);
    const fields = [...orders.fields];
    const csv = [fields.join(','), ...orders.rows.map((r) => fields.map((f) => String(r[f] ?? '')).join(','))].join('\n');
    const { profile: fromFile } = (await (await upload('orders.csv', csv)).json()) as UploadResponse;
    const fromSample = (await (await get('/v1/sources/profile?type=sample&ref=orders')).json()) as SourceProfile;
    const strip = ({ source: _s, profiledAt: _p, ...rest }: SourceProfile) => rest;
    expect(strip(fromFile)).toEqual(strip(fromSample));
  });
});

describe('querying uploaded files', () => {
  it('serves saved dashboards over a file source, scoped to the uploading team', async () => {
    const { summary } = (await (await upload('mine.csv', CSV)).json()) as UploadResponse;
    const spec = fileDashboard(summary.source.ref);
    for (const token of [TEAM_A, TEAM_B]) {
      const put = await app.request('/v1/dashboards/dash_file', { method: 'PUT', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }) });
      expect(put.status).toBe(201);
    }
    const a = await lines(await post('/v1/dashboards/dash_file/data', { queries: ['q_by_region', 'q_by_month'] }));
    expect(ok(a.q_by_region).rows).toEqual([
      { region: 'EU', revenue: 150.75, count: 2 },
      { region: 'NA', revenue: 200, count: 1 },
      { region: null, revenue: 10, count: 1 },
    ]);
    expect(ok(a.q_by_month)).toEqual({
      columns: [{ name: 'day', type: 'time', grain: 'month' }, { name: 'sum_units', type: 'number' }],
      rows: [{ day: '2026-01-01', sum_units: 3 }, { day: '2026-02-01', sum_units: 4 }],
      truncated: false,
      asOf: NOW.toISOString(),
    });
    // Team B saved the same spec, but the ref is team A's: not found, exactly like a missing ref.
    const b = await lines(await post('/v1/dashboards/dash_file/data', { queries: ['q_by_region'] }, TEAM_B));
    expect(b.q_by_region).toMatchObject({ ok: false, error: { code: 'unknown_source' } });
  });

  it('survives a restart (the JSON manifest is reloaded)', async () => {
    const { summary } = (await (await upload('mine.csv', CSV)).json()) as UploadResponse;
    await layer.close();
    makeApp(dataDir);
    const sources = (await (await get('/v1/sources')).json()) as { sources: SourceSummary[] };
    expect(sources.sources).toContainEqual(summary);
    const res = await post('/v1/preview/data', { spec: fileDashboard(summary.source.ref), queries: ['q_by_region'] });
    expect(ok((await lines(res)).q_by_region).rows).toHaveLength(3);
  });
});

describe('POST /v1/preview/data', () => {
  it('runs queries of an unsaved draft, streamed as NDJSON', async () => {
    const res = await post('/v1/preview/data', { spec: salesOverview, queries: ['q_totals', 'q_rev_by_region'], params: { dateRange: 'last_30d' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');
    const byId = await lines(res);
    expect(ok(byId.q_totals).rows).toHaveLength(1);
    expect(ok(byId.q_rev_by_region).rows.length).toBeGreaterThan(0);
    // Nothing was saved.
    expect((await get('/v1/dashboards/dash_9f2a')).status).toBe(404);
  });

  it('refuses drafts that do not validate (422) and bad requests (400)', async () => {
    const broken = structuredClone(salesOverview) as Record<string, any>;
    broken.queries.q_totals.measures[0].field = '*';
    broken.queries.q_totals.measures[0].agg = 'sum';
    const res = await post('/v1/preview/data', { spec: broken, queries: ['q_totals'] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_spec');
    expect((await post('/v1/preview/data', { queries: ['q_totals'] })).status).toBe(400);
    expect((await post('/v1/preview/data', { spec: salesOverview, queries: [] })).status).toBe(400);
    expect((await post('/v1/preview/data', { spec: salesOverview, queries: ['q_totals'], params: { nope: 1 } })).status).toBe(400);
    expect((await app.request('/v1/preview/data', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});
