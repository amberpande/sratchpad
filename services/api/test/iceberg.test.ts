import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataResponseLine, UploadResponse } from '@yourorg/bi-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, DEV_TOKENS, MemoryDashboardStore, StaticTokenVerifier, type App } from '../src';
import { loadConfig } from '../src/config';
import { createDataLayer, type DataLayer } from '../src/data';
import { icebergType, SnowflakeIcebergLoader, tableName } from '../src/data/files/iceberg';
import type { BindValue } from '../src/data/sql/compile';
import type { SnowflakeConfig } from '../src/data/snowflake/config';
import type { SnowflakeDriver } from '../src/data/snowflake/driver';

/**
 * No Snowflake account here: a fake driver records every statement. What is verified: the exact
 * load statements, the exported CSV (what Snowflake will read), local cleanup, the registry record,
 * query routing to the Iceberg table and team isolation. Not verified: a live Snowflake round trip.
 */

type Call = { key: string; sql: string; binds: BindValue[] };

class FakeDriver implements SnowflakeDriver {
  calls: Call[] = [];
  /** The CSV content at PUT time (read before the service deletes it). */
  putContent: string | null = null;
  failOn: RegExp | null = null;
  async execute(key: string, sql: string, binds: BindValue[]) {
    this.calls.push({ key, sql, binds });
    if (this.failOn?.test(sql)) throw new Error('SQL compilation error: something broke');
    if (sql.startsWith('PUT ')) {
      const path = /^PUT 'file:\/\/([^']+)'/.exec(sql)![1]!;
      this.putContent = await readFile(path, 'utf8');
      return [];
    }
    if (sql.includes('INFORMATION_SCHEMA"."COLUMNS"')) {
      return [
        { COLUMN_NAME: 'region', DATA_TYPE: 'TEXT', NUMERIC_SCALE: null },
        { COLUMN_NAME: 'amount', DATA_TYPE: 'FLOAT', NUMERIC_SCALE: null },
      ];
    }
    if (sql.startsWith('SELECT') && sql.includes('"FILE_')) return [{ region: 'EU', total: 12.5 }];
    return [];
  }
  async close() {}
}

const connection: SnowflakeConfig = {
  account: 'acme',
  username: 'svc',
  password: 'x',
  warehouse: 'TEAM_WH',
  role: 'TEAM_ROLE',
  teams: {},
  statementTimeoutSeconds: 60,
  poolMax: 2,
  profileSampleRows: 1000,
};
const uploadsConfig = { database: 'BI_APP', schema: 'UPLOADS', warehouse: 'BI_APP_WH', role: 'BI_APP_ROLE' };

describe('Iceberg load statements', () => {
  const loader = new SnowflakeIcebergLoader(new FakeDriver(), uploadsConfig);
  const id = 'file_0123456789abcdef01234567';

  it('maps inferred kinds to Iceberg-compatible Snowflake types', () => {
    expect(['integer', 'number', 'boolean', 'date', 'timestamp', 'string', 'other'].map((k) => icebergType(k as never))).toEqual([
      'NUMBER(19,0)',
      'FLOAT',
      'BOOLEAN',
      'DATE',
      'TIMESTAMP_NTZ(6)',
      'VARCHAR',
      'VARCHAR',
    ]);
    expect(tableName(id)).toBe('FILE_0123456789ABCDEF01234567');
    expect(() => tableName('file_x"; DROP')).toThrow();
  });

  it('creates a Snowflake-managed Iceberg table with explicit casts, in column order', () => {
    const s = loader.statements({
      id,
      csvPath: "/data/tmp/it's.csv",
      columns: [
        { name: 'Order Date', kind: 'date' },
        { name: 'amount', kind: 'number' },
        { name: 'weird "name"', kind: 'string' },
      ],
    });
    expect(s.table).toBe('BI_APP.UPLOADS.FILE_0123456789ABCDEF01234567');
    expect(s.put).toBe(`PUT 'file:///data/tmp/it''s.csv' @"BI_APP"."UPLOADS"."BI_UPLOADS_STAGE" AUTO_COMPRESS = TRUE PARALLEL = 4`);
    expect(s.create).toBe(
      `CREATE ICEBERG TABLE "BI_APP"."UPLOADS"."FILE_0123456789ABCDEF01234567" CATALOG = 'SNOWFLAKE' EXTERNAL_VOLUME = 'SNOWFLAKE_MANAGED' ` +
        `BASE_LOCATION = '${id}' AS SELECT $1::DATE AS "Order Date", $2::FLOAT AS "amount", $3::VARCHAR AS "weird ""name""" ` +
        `FROM @"BI_APP"."UPLOADS"."BI_UPLOADS_STAGE"/${id}.csv.gz (FILE_FORMAT => 'BI_APP.UPLOADS.BI_UPLOAD_CSV')`,
    );
    expect(s.remove).toBe(`REMOVE @"BI_APP"."UPLOADS"."BI_UPLOADS_STAGE"/${id}.csv.gz`);
  });
});

describe('uploads stored in Snowflake', () => {
  let dataDir: string;
  let layer: DataLayer;
  let app: App;
  let driver: FakeDriver;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bi-iceberg-'));
    driver = new FakeDriver();
    layer = createDataLayer({ dataDir, snowflake: connection, snowflakeUploads: uploadsConfig, snowflakeUploadsDriver: driver });
    app = createApp({ store: new MemoryDashboardStore(), auth: StaticTokenVerifier.parse(DEV_TOKENS), engines: layer.engines, sources: layer.sources });
  });
  afterEach(async () => {
    await layer.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const upload = (name: string, content: string, token = 'dev-token-team-a') => {
    const form = new FormData();
    form.append('file', new File([content], name));
    return app.request('/v1/sources/files', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  };

  const CSV = [
    'region,amount,qty,day,at,active,note',
    'EU,12.5,3,2026-01-02,2026-01-02 03:04:05,true,"comma, inside"',
    'US,7,1,2026-01-03,2026-01-03 10:00:00,false,"say ""hi"""',
    'APAC,,2,2026-01-04,2026-01-04 11:30:00,true,"two',
    'lines"',
    'EU,1.25,5,2026-01-05,2026-01-05 00:00:00,false,C:\\path\\x',
    '',
  ].join('\n');

  it('loads into an Iceberg table, keeps the profile, and leaves nothing on local disk', async () => {
    const res = await upload('sales.csv', CSV);
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponse;
    const id = body.summary.source.ref;
    expect(body.summary.rowCount).toBe(4);
    expect(body.profile.columns.map((c) => c.name)).toEqual(['region', 'amount', 'qty', 'day', 'at', 'active', 'note']);

    const sqls = driver.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('CREATE SCHEMA IF NOT EXISTS "BI_APP"."UPLOADS"');
    expect(sqls[1]).toMatch(/^CREATE FILE FORMAT IF NOT EXISTS .*ESCAPE_UNENCLOSED_FIELD = NONE SKIP_HEADER = 1/);
    expect(sqls[2]).toMatch(/^CREATE STAGE IF NOT EXISTS "BI_APP"."UPLOADS"."BI_UPLOADS_STAGE"/);
    expect(sqls[3]).toMatch(/^PUT 'file:\/\//);
    expect(sqls[4]).toContain(
      `AS SELECT $1::VARCHAR AS "region", $2::FLOAT AS "amount", $3::NUMBER(19,0) AS "qty", $4::DATE AS "day", $5::TIMESTAMP_NTZ(6) AS "at", $6::BOOLEAN AS "active", $7::VARCHAR AS "note"`,
    );
    expect(sqls[5]).toMatch(/^REMOVE /);
    expect(driver.calls.every((c) => c.key === 'uploads')).toBe(true);

    // What Snowflake reads: ISO dates, microsecond timestamps, true/false, NULL as an empty field,
    // "" inside quoted fields, the embedded newline quoted, the backslash untouched.
    const lines = driver.putContent!.trimEnd().split('\n');
    expect(lines[0]).toBe('region,amount,qty,day,at,active,note');
    expect(lines[1]).toBe('EU,12.5,3,2026-01-02,2026-01-02 03:04:05.000000,true,"comma, inside"');
    expect(lines[2]).toBe('US,7.0,1,2026-01-03,2026-01-03 10:00:00.000000,false,"say ""hi"""');
    expect(lines[3]).toBe('APAC,,2,2026-01-04,2026-01-04 11:30:00.000000,true,"two');
    expect(lines[5]).toBe('EU,1.25,5,2026-01-05,2026-01-05 00:00:00.000000,false,C:\\path\\x');

    // Nothing left locally: no Parquet copy, no export.
    for (const sub of ['files', 'tmp']) {
      const dir = join(dataDir, sub);
      if (existsSync(dir)) expect(await readdir(dir)).toEqual([]);
    }
    const record = await layer.files.find('team-a', id);
    expect(record).toMatchObject({ storage: 'snowflake', table: `BI_APP.UPLOADS.${id.toUpperCase()}` });
    // The stored profile still answers without touching Snowflake.
    const calls = driver.calls.length;
    expect((await app.request(`/v1/sources/profile?type=file&ref=${id}`, { headers: { Authorization: 'Bearer dev-token-team-a' } })).status).toBe(200);
    expect(driver.calls.length).toBe(calls);
  });

  it('runs queries on the Iceberg table under the uploads role, scoped by team', async () => {
    const id = ((await (await upload('sales.csv', CSV)).json()) as UploadResponse).summary.source.ref;
    const spec = {
      specVersion: '1.1',
      id: 'd',
      title: 'D',
      dataSources: { src: { type: 'file', ref: id } },
      queries: { q: { source: 'src', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'total' }] } },
      widgets: {},
      layout: [],
    };
    const preview = (token: string) =>
      app.request('/v1/preview/data', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, queries: ['q'] }),
      });
    const line = JSON.parse((await (await preview('dev-token-team-a')).text()).trim()) as DataResponseLine;
    expect(line).toMatchObject({ ok: true, result: { rows: [{ region: 'EU', total: 12.5 }] } });
    const select = driver.calls.find((c) => c.sql.startsWith('SELECT') && c.sql.includes('"FILE_'))!;
    expect(select.sql).toContain(`FROM "BI_APP"."UPLOADS"."${id.toUpperCase()}"`);
    expect(select.key).toBe('team-a'); // pool / query tag per team, uploads role for all

    const before = driver.calls.length;
    const other = JSON.parse((await (await preview('dev-token-team-b')).text()).trim()) as DataResponseLine;
    expect(other).toMatchObject({ ok: false, error: { code: 'unknown_source' } });
    expect(driver.calls.length).toBe(before); // never reached Snowflake
  });

  it('a failed load is a 502, registers nothing and cleans up', async () => {
    driver.failOn = /^CREATE ICEBERG TABLE/;
    const res = await upload('sales.csv', CSV);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'load_failed' } });
    expect(driver.calls.some((c) => c.sql.startsWith('REMOVE '))).toBe(true);
    expect(await layer.files.list('team-a')).toEqual([]);
    for (const sub of ['files', 'tmp']) {
      const dir = join(dataDir, sub);
      if (existsSync(dir)) expect(await readdir(dir)).toEqual([]);
    }
  });
});

describe('config', () => {
  const sf = { SNOWFLAKE_ACCOUNT: 'a', SNOWFLAKE_USER: 'u', SNOWFLAKE_PASSWORD: 'p', SNOWFLAKE_WAREHOUSE: 'WH' };
  it('defaults uploads to Snowflake with the Snowflake store, into <app db>.UPLOADS', () => {
    const c = loadConfig({ ...sf, BI_STORE: 'snowflake', SNOWFLAKE_APP_DATABASE: 'BI_APP', SNOWFLAKE_APP_ROLE: 'BI_APP_ROLE' });
    expect(c.uploads).toBe('snowflake');
    expect(c.snowflakeUploads).toEqual({ database: 'BI_APP', schema: 'UPLOADS', warehouse: 'WH', role: 'BI_APP_ROLE' });
    expect(loadConfig({}).uploads).toBe('local');
    expect(() => loadConfig({ BI_UPLOADS: 'snowflake' })).toThrow(/BI_UPLOADS=snowflake needs/);
  });
});
