import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuerySchema, sqlHasMultipleStatements, validateDashboard, type DataResponseLine, type QueryInput } from '@yourorg/bi-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, StaticTokenVerifier } from '../src';
import { DuckDBFileEngine } from '../src/data/duckdb/engine';
import { DuckDBRuntime } from '../src/data/duckdb/runtime';
import type { EngineError } from '../src/data/engine';
import { MemoryFileSourceRegistry } from '../src/data/files/registry';
import { FileSources } from '../src/data/files/service';
import type { BindValue } from '../src/data/sql/compile';
import { compileCustomSql, mentionedSources, type SqlQuery } from '../src/data/sql/custom';
import { duckdb, snowflake } from '../src/data/sql/dialect';
import type { SnowflakeConfig } from '../src/data/snowflake/config';
import type { SnowflakeDriver } from '../src/data/snowflake/driver';
import { SnowflakeEngine } from '../src/data/snowflake/engine';

// Custom SQL queries (spec 1.4, D-070): spec checks, the wrapping compiler, the DuckDB sandbox,
// the request path (flag, row-level security) and the Snowflake path (fake driver; not verified live).
const NOW = new Date('2026-11-09T15:30:00Z');

const SQL = 'SELECT region, SUM(amount) AS revenue FROM orders GROUP BY region';

function spec(query: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    specVersion: '1.4',
    id: 'd_sql',
    title: 'SQL',
    dataSources: { orders: { type: 'sample', ref: 'orders' } },
    queries: { q: { source: 'orders', ...query } },
    widgets: {},
    layout: [],
    ...extra,
  };
}

const columns = [
  { name: 'region', role: 'dimension' },
  { name: 'revenue', role: 'measure' },
];

describe('spec: custom SQL queries', () => {
  it('accepts sql + columns and exposes the columns to widgets', () => {
    const r = validateDashboard(
      spec(
        { sql: SQL, columns },
        { widgets: { w: { type: 'bar-chart', query: 'q', encoding: { x: 'region', y: ['revenue'] } } }, layout: [{ i: 'w', x: 0, y: 0, w: 6, h: 4 }] },
      ),
    );
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('needs spec 1.4', () => {
    const r = validateDashboard({ ...spec({ sql: SQL, columns }), specVersion: '1.3' });
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toContain('field_too_new');
  });

  it('refuses mixing SQL with visual query fields, two statements, and filters on undeclared columns', () => {
    const r = validateDashboard(
      spec({ sql: `${SQL}; DROP TABLE x`, columns, dimensions: [{ field: 'region' }], filters: [{ field: 'channel', op: 'eq', value: 'web' }] }),
    );
    const codes = (r.ok ? [] : r.errors).map((e) => `${e.path}:${e.code}`);
    expect(codes).toContain('queries.q.dimensions:invalid_value');
    expect(codes).toContain('queries.q.sql:invalid_sql');
    expect(codes).toContain('queries.q.filters.0.field:unknown_column');
  });

  it('warns when no columns are declared (Studio fills them by running the SQL)', () => {
    const r = validateDashboard(spec({ sql: SQL }));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('missing_columns');
  });

  it('finds a second statement only outside strings and comments', () => {
    expect(sqlHasMultipleStatements('SELECT 1;')).toBe(false);
    expect(sqlHasMultipleStatements('SELECT 1; -- done')).toBe(false);
    expect(sqlHasMultipleStatements("SELECT ';' AS a, \"x;y\" FROM t /* ; */")).toBe(false);
    expect(sqlHasMultipleStatements('SELECT 1; SELECT 2')).toBe(true);
    expect(sqlHasMultipleStatements('SELECT 1) q; DROP TABLE t; SELECT * FROM (SELECT 1')).toBe(true);
    // DuckDB: "//" is division and backslashes do not escape, so these hide nothing.
    expect(sqlHasMultipleStatements('SELECT 5 // 2; DROP TABLE t', 'duckdb')).toBe(true);
    expect(sqlHasMultipleStatements("SELECT 'a\\'; DROP TABLE t; --'", 'duckdb')).toBe(true);
  });
});

describe('compileCustomSql', () => {
  const q = (input: Omit<QueryInput, 'source'>) => QuerySchema.parse({ source: 'orders', ...input }) as SqlQuery;

  it('wraps the SQL: source CTEs, declared columns, filters as binds, order, limit + 1', () => {
    const c = compileCustomSql(
      q({ sql: `${SQL};`, columns: columns as never, filters: [{ field: 'region', op: 'eq', value: "EU' OR 1=1 --" }], orderBy: [{ field: 'revenue', dir: 'desc' }], limit: 50 }),
      { dialect: duckdb, sources: [{ name: 'orders', relation: { sql: 'read_parquet(?)', params: ['/data/files/f.parquet'] } }] },
    );
    expect(c.sql).toBe(
      [
        'WITH "orders" AS (SELECT * FROM read_parquet(?))',
        `SELECT "region", "revenue" FROM (\n${SQL}\n) AS "sratchpad_q"`,
        'WHERE ("region" = ?)',
        'ORDER BY "revenue" DESC NULLS LAST',
        'LIMIT 51',
      ].join('\n'),
    );
    expect(c.params).toEqual(['/data/files/f.parquet', "EU' OR 1=1 --"]);
    expect(c.columns).toEqual([
      { name: 'region', type: 'string' },
      { name: 'revenue', type: 'number' },
    ]);
  });

  it('names Snowflake CTEs in upper case so unquoted names resolve', () => {
    const c = compileCustomSql(q({ sql: SQL }), { dialect: snowflake, sources: [{ name: 'orders', relation: { sql: '"S"."P"."T"', params: [] } }] });
    expect(c.sql.startsWith('WITH "ORDERS" AS (SELECT * FROM "S"."P"."T")\nSELECT * FROM (')).toBe(true);
  });

  it('refuses a second statement on the server too', () => {
    expect(() => compileCustomSql(q({ sql: 'SELECT 1) q; DELETE FROM t; SELECT * FROM (SELECT 1' }), { dialect: duckdb, sources: [] })).toThrow(
      expect.objectContaining({ code: 'invalid_sql' }),
    );
  });

  it('finds the sources the SQL mentions as whole words', () => {
    expect(mentionedSources('select * from Orders o join targets t using (id)', ['orders', 'targets', 'ord', 'other-src'])).toEqual(['orders', 'targets']);
  });
});

// ── the request path: sample data in the DuckDB sandbox ──

function app(queryServices?: Parameters<typeof createApp>[0]['queryServices']) {
  return createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: defaultEngines(() => NOW),
    now: () => NOW,
    queryServices,
  });
}

async function preview(a: ReturnType<typeof app>, body: unknown, token = 'dev-token-team-a') {
  const res = await a.request('/v1/preview/data', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, line: res.status === 200 ? (JSON.parse((await res.text()).trim().split('\n')[0]!) as DataResponseLine) : null };
}

describe('custom SQL through runQuery (sample data)', () => {
  it('runs the SQL over the sample source and returns the declared columns', async () => {
    const { line } = await preview(app(), { spec: spec({ sql: SQL, columns, orderBy: [{ field: 'region', dir: 'asc' }] }), queries: ['q'] });
    expect(line?.ok, JSON.stringify(line)).toBe(true);
    if (!line?.ok) return;
    expect(line.result.columns).toEqual([
      { name: 'region', type: 'string' },
      { name: 'revenue', type: 'number' },
    ]);
    expect(line.result.rows.map((r) => r.region)).toEqual(['APAC', 'Europe', 'LATAM', 'North America']);
    expect(line.result.rows.every((r) => typeof r.revenue === 'number' && r.revenue > 0)).toBe(true);
  });

  it('without declared columns returns every column, typed (the Studio "detect columns" run)', async () => {
    const { line } = await preview(app(), {
      spec: spec({ sql: "SELECT date_trunc('month', order_date) AS month, count(*) AS orders, true AS flag FROM orders GROUP BY 1 ORDER BY 1", limit: 3 }),
      queries: ['q'],
    });
    expect(line?.ok, JSON.stringify(line)).toBe(true);
    if (!line?.ok) return;
    expect(line.result.columns).toEqual([
      { name: 'month', type: 'time' },
      { name: 'orders', type: 'number' },
      { name: 'flag', type: 'boolean' },
    ]);
    expect(line.result.truncated).toBe(true);
    expect(String(line.result.rows[0]!.month)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('applies a bound date range param as a filter on the declared time column', async () => {
    const s = spec(
      { sql: 'SELECT order_date, amount FROM orders', columns: [{ name: 'order_date', role: 'dimension', type: 'time' }, { name: 'amount', role: 'measure' }], limit: 10_000 },
      { params: { range: { type: 'daterange', default: { from: '2026-10-01', to: '2026-10-31' }, bind: ['q.filters'] } } },
    );
    const { line } = await preview(app(), { spec: s, queries: ['q'] });
    expect(line?.ok, JSON.stringify(line)).toBe(true);
    if (!line?.ok) return;
    expect(line.result.rows.length).toBeGreaterThan(0);
    expect(line.result.rows.every((r) => String(r.order_date) >= '2026-10-01' && String(r.order_date) < '2026-11-01')).toBe(true);
  });

  it('cannot read files, change settings or run a second statement (sandbox)', async () => {
    const a = app();
    for (const sql of ["SELECT * FROM read_csv('/etc/hosts')", "SELECT * FROM glob('/*')", 'SELECT 1) q; SET enable_external_access = true; SELECT * FROM (SELECT 1']) {
      const { status, line } = await preview(a, { spec: spec({ sql }), queries: ['q'] });
      // Two statements are already a validation error (the draft is refused); the others fail in the sandbox.
      if (status !== 200) {
        expect(sql).toContain(';');
        continue;
      }
      expect(line, sql).toMatchObject({ ok: false });
      if (line && !line.ok) {
        expect(['sql_error', 'invalid_sql']).toContain(line.error.code);
        expect(line.error.message).not.toContain('/etc/hosts');
      }
    }
  });

  it('can be turned off (BI_CUSTOM_SQL=off)', async () => {
    const { line } = await preview(app({ customSql: false }), { spec: spec({ sql: SQL, columns }), queries: ['q'] });
    expect(line).toMatchObject({ ok: false, error: { code: 'custom_sql_disabled' } });
  });

  it('is refused when row-level security applies to the team (fail closed), allowed for "*" principals', async () => {
    const rls = { 'team-a': [{ field: 'region', attribute: 'region' }] };
    const { line } = await preview(app({ rls }), { spec: spec({ sql: SQL, columns }), queries: ['q'] });
    expect(line).toMatchObject({ ok: false, error: { code: 'rls_denied' } });
  });
});

// ── uploads: the sandbox reads only the team's own referenced uploads ──

describe('custom SQL over uploads (DuckDB sandbox)', () => {
  let dataDir: string;
  let runtime: DuckDBRuntime;
  let engine: DuckDBFileEngine;
  let mine: string;
  let theirs: string;
  const ctx = (teamId: string) => ({ teamId, signal: new AbortController().signal });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bi-sql-'));
    runtime = new DuckDBRuntime();
    const files = new FileSources({ runtime, registry: new MemoryFileSourceRegistry(), dataDir, now: () => NOW });
    engine = new DuckDBFileEngine(files, runtime);
    const up = async (teamId: string, csv: string) => (await files.upload({ teamId, subject: 'u', fileName: 'f.csv', bytes: new TextEncoder().encode(csv) })).summary.source.ref;
    mine = await up('t', 'region,amount\nEU,10\nEU,5\nNA,7\n');
    theirs = await up('other', 'secret\n42\n');
  });
  afterAll(async () => {
    await runtime?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const run = (teamId: string, sql: string, sources: Array<[string, string]>) =>
    engine.execute(
      { type: 'file', ref: sources[0]![1] },
      { ...QuerySchema.parse({ source: 'u', sql, orderBy: [] }), sqlSources: sources.map(([id, ref]) => ({ id, source: { type: 'file', ref } })) } as SqlQuery,
      ctx(teamId),
    );

  it('reads the team upload by its source id', async () => {
    const r = await run('t', 'SELECT region, sum(amount) AS total FROM u GROUP BY 1 ORDER BY 1', [['u', mine]]);
    expect(r.rows).toEqual([
      { region: 'EU', total: 15 },
      { region: 'NA', total: 7 },
    ]);
  });

  it("cannot reach another team's upload, by source or by file path", async () => {
    await expect(run('t', 'SELECT * FROM x', [['x', theirs]])).rejects.toMatchObject({ code: 'unknown_source' });
    const path = join(dataDir, 'files', `${theirs}.parquet`);
    const error = (await run('t', `SELECT * FROM read_parquet('${path}')`, [['u', mine]]).catch((e: EngineError) => e)) as EngineError;
    expect(error.code).toBe('sql_error');
    expect(error.message).not.toContain(dataDir);
  });
});

// ── Snowflake: fake driver (not verified against a live account) ──

describe('custom SQL on Snowflake (fake driver)', () => {
  type Call = { teamId: string; sql: string; binds: BindValue[] };
  const calls: Call[] = [];
  const driver: SnowflakeDriver = {
    async execute(teamId, sql, binds) {
      calls.push({ teamId, sql, binds });
      if (sql.includes('INFORMATION_SCHEMA"."COLUMNS"')) return teamId === 'team-a' ? [{ COLUMN_NAME: 'REGION', DATA_TYPE: 'TEXT', NUMERIC_SCALE: null }] : [];
      return [
        { REGION: 'EU', REVENUE: 10.5, DAY: new Date('2026-11-01T00:00:00Z') },
        { REGION: 'NA', REVENUE: '7', DAY: new Date('2026-11-02T10:00:00Z') },
      ];
    },
    async close() {},
  };
  const config: SnowflakeConfig = {
    account: 'a',
    username: 'u',
    password: 'p',
    teams: { 'team-a': { role: 'A_ROLE' }, 'team-b': { role: 'B_ROLE' } },
    statementTimeoutSeconds: 60,
    poolMax: 1,
    profileSampleRows: 100,
  } as SnowflakeConfig;
  const engine = new SnowflakeEngine(driver, config);
  const query = (sources: Array<[string, string]>, cols?: unknown) =>
    ({
      ...QuerySchema.parse({ source: 'orders', sql: 'select region, sum(amount) as revenue, day from orders group by 1, 3', ...(cols ? { columns: cols } : {}) }),
      sqlSources: sources.map(([id, ref]) => ({ id, source: { type: 'snowflake', ref } })),
    }) as SqlQuery;

  it('runs under the team role with the source as an upper-case CTE and maps upper-case result names', async () => {
    const r = await engine.execute(
      { type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' },
      query([['orders', 'SALES.PUBLIC.ORDERS']], [{ name: 'REGION', role: 'dimension' }, { name: 'REVENUE', role: 'measure' }, { name: 'DAY', role: 'dimension' }]),
      { teamId: 'team-a', signal: new AbortController().signal },
    );
    const last = calls.at(-1)!;
    expect(last.teamId).toBe('team-a');
    expect(last.sql).toContain('WITH "ORDERS" AS (SELECT * FROM "SALES"."PUBLIC"."ORDERS")');
    expect(r.columns).toEqual([
      { name: 'REGION', type: 'string' },
      { name: 'REVENUE', type: 'number' },
      { name: 'DAY', type: 'time' },
    ]);
    expect(r.rows).toEqual([
      { REGION: 'EU', REVENUE: 10.5, DAY: '2026-11-01' },
      { REGION: 'NA', REVENUE: 7, DAY: '2026-11-02T10:00:00' },
    ]);
  });

  it('refuses a source table the team role cannot see', async () => {
    await expect(
      engine.execute({ type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, query([['orders', 'SALES.PUBLIC.ORDERS']]), { teamId: 'team-b', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'unknown_source' });
  });
});

describe('assistant and custom SQL', () => {
  it('rejects edits that add or change a query\'s SQL, allows removing one', async () => {
    const { sqlChanged } = await import('../src/ai/assistant');
    const base = { queries: { a: { source: 's', sql: 'SELECT 1 AS x', columns: [{ name: 'x', role: 'measure' }] }, b: { source: 's', measures: [] } } };
    expect(sqlChanged(base, structuredClone(base))).toBe(false);
    expect(sqlChanged(base, { queries: { ...base.queries, a: { ...base.queries.a, sql: 'SELECT 2 AS x' } } })).toBe(true);
    expect(sqlChanged(base, { queries: { ...base.queries, b: { source: 's', sql: 'SELECT 1' } } })).toBe(true);
    expect(sqlChanged(base, { queries: { b: base.queries.b } })).toBe(false);
  });
});

describe('dashboard filters bound to a SQL query', () => {
  it('must target a declared column', () => {
    const params = { range: { type: 'daterange', field: 'order_date', default: 'all', bind: ['q.filters'] } };
    const bad = validateDashboard(spec({ sql: SQL, columns }, { params }));
    expect(bad.ok ? [] : bad.errors.map((e) => `${e.path}:${e.code}`)).toContain('params.range.bind.0:unknown_column');
    const good = validateDashboard(spec({ sql: 'SELECT order_date, amount FROM orders', columns: [{ name: 'order_date', role: 'dimension', type: 'time' }, { name: 'amount', role: 'measure' }] }, { params }));
    expect(good.ok ? [] : good.errors).toEqual([]);
  });
});

describe('custom SQL on Snowflake: role guard', () => {
  const driver: SnowflakeDriver = { execute: async () => [], close: async () => {} };
  const base = { account: 'a', username: 'u', password: 'p', statementTimeoutSeconds: 60, poolMax: 1, profileSampleRows: 100 };
  const q = { ...QuerySchema.parse({ source: 'o', sql: 'SELECT 1 AS x' }), sqlSources: [] } as SqlQuery;
  const ctx = { teamId: 'team-a', signal: new AbortController().signal };
  const src = { type: 'snowflake', ref: 'A.B.C' };

  it('refuses when the team has no explicit role, or runs under an app role', async () => {
    const noRole = new SnowflakeEngine(driver, { ...base, teams: {} } as SnowflakeConfig, { customSql: { privilegedRoles: [] } });
    await expect(noRole.execute(src, q, ctx)).rejects.toMatchObject({ code: 'custom_sql_unavailable' });
    const appRole = new SnowflakeEngine(driver, { ...base, role: 'BI_APP_ROLE', teams: {} } as SnowflakeConfig, { customSql: { privilegedRoles: ['bi_app_role'] } });
    await expect(appRole.execute(src, q, ctx)).rejects.toMatchObject({ code: 'custom_sql_unavailable' });
    const uploads = new SnowflakeEngine(driver, { ...base, role: 'UPLOADS', teams: {} } as SnowflakeConfig, { customSql: false });
    await expect(uploads.execute(src, q, ctx)).rejects.toMatchObject({ code: 'custom_sql_unavailable' });
  });

  it('runs under a separate team role', async () => {
    const ok = new SnowflakeEngine(driver, { ...base, role: 'BI_APP_ROLE', teams: { 'team-a': { role: 'A_READ' } } } as SnowflakeConfig, { customSql: { privilegedRoles: ['BI_APP_ROLE'] } });
    await expect(ok.execute(src, q, ctx)).resolves.toMatchObject({ rows: [] });
  });
});
