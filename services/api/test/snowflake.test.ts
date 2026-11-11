import { QuerySchema, type QueryInput } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { createDataLayer } from '../src/data';
import type { EngineError } from '../src/data/engine';
import type { BindValue } from '../src/data/sql/compile';
import { loadSnowflakeConfig, teamSettings, type SnowflakeConfig } from '../src/data/snowflake/config';
import type { SnowflakeDriver } from '../src/data/snowflake/driver';
import { parseTableRef, SnowflakeEngine } from '../src/data/snowflake/engine';
import { attachJoinSources } from '../src/data/sql/joins';

/**
 * No Snowflake account exists in this environment, so the engine runs against a fake driver that
 * records every statement and answers from canned metadata. What is verified: the SQL pushed down,
 * team scoping, sampling in the profiler, result conversion. Not verified: a live round trip.
 */

type Call = { teamId: string; sql: string; binds: BindValue[] };

class FakeDriver implements SnowflakeDriver {
  calls: Call[] = [];
  constructor(private readonly answer: (call: Call) => Array<Record<string, unknown>>) {}
  async execute(teamId: string, sql: string, binds: BindValue[]) {
    const call = { teamId, sql, binds };
    this.calls.push(call);
    return this.answer(call);
  }
  async close() {}
}

const config: SnowflakeConfig = {
  account: 'acme-xy123',
  username: 'BI_SERVICE',
  password: 'x',
  warehouse: 'BI_WH',
  role: 'BI_READER',
  teams: { 'team-a': { warehouse: 'A_WH', role: 'A_ROLE', database: 'SALES' } },
  statementTimeoutSeconds: 60,
  poolMax: 4,
  profileSampleRows: 10_000,
};

const ORDERS_COLUMNS = [
  { COLUMN_NAME: 'ORDER_DATE', DATA_TYPE: 'DATE', NUMERIC_SCALE: null },
  { COLUMN_NAME: 'REGION', DATA_TYPE: 'TEXT', NUMERIC_SCALE: null },
  { COLUMN_NAME: 'AMOUNT', DATA_TYPE: 'NUMBER', NUMERIC_SCALE: 2 },
  { COLUMN_NAME: 'ORDER_ID', DATA_TYPE: 'NUMBER', NUMERIC_SCALE: 0 },
];

/** team-a's role can see SALES.PUBLIC.ORDERS; nobody else can see anything. */
function answer(call: Call): Array<Record<string, unknown>> {
  if (call.sql.includes('INFORMATION_SCHEMA"."COLUMNS"')) {
    return call.teamId === 'team-a' && call.sql.includes('"SALES"') && call.binds[0] === 'PUBLIC' && call.binds[1] === 'ORDERS' ? ORDERS_COLUMNS : [];
  }
  if (call.sql.startsWith('SHOW OBJECTS')) {
    return [
      { database_name: 'SALES', schema_name: 'PUBLIC', name: 'ORDERS', kind: 'TABLE', rows: 1200000, created_on: new Date('2026-01-01T00:00:00Z') },
      { database_name: 'SALES', schema_name: 'PUBLIC', name: 'ORDERS_V', kind: 'VIEW', rows: null, created_on: new Date('2026-01-02T00:00:00Z') },
      { database_name: 'SALES', schema_name: 'INFORMATION_SCHEMA', name: 'TABLES', kind: 'VIEW', rows: null },
      { database_name: 'SALES', schema_name: 'PUBLIC', name: 'LOAD_STAGE', kind: 'STAGE', rows: null },
    ];
  }
  if (call.sql.includes('INFORMATION_SCHEMA"."TABLES"')) return [{ ROW_COUNT: 1200000 }];
  if (call.sql.includes('UNION ALL')) {
    return [
      { i: 1, v: 'EU', c: 4000 },
      { i: 1, v: 'NA', c: 6000 },
      { i: 2, v: '19.99', c: 30 },
      { i: 0, v: '2026-03-01', c: 40 },
    ];
  }
  if (call.sql.includes('count(*) AS "r"')) {
    return [{ r: 10000, n0: 10000, d0: 700, lo0: '2024-01-01', hi0: '2026-11-08', n1: 9900, d1: 2, n2: 10000, d2: 8000, lo2: 1.5, hi2: 999.5, n3: 10000, d3: 10050, lo3: 1, hi3: 1200000 }];
  }
  // A compiled query: DATE_TRUNC result as a string, NUMBER as a JS number, COUNT as a string.
  return [
    { ORDER_DATE: '2026-10-01', revenue: 1234.5, count: '7' },
    { ORDER_DATE: '2026-11-01', revenue: null, count: '0' },
    { ORDER_DATE: '2026-12-01', revenue: 1, count: '1' },
  ];
}

const ctx = (teamId: string) => ({ teamId, signal: new AbortController().signal });
const query = (q: Omit<QueryInput, 'source'>) => QuerySchema.parse({ source: 's', ...q });

describe('Snowflake engine (fake driver)', () => {
  it('pushes the compiled query down under the caller team and converts the result', async () => {
    const driver = new FakeDriver(answer);
    const engine = new SnowflakeEngine(driver, config);
    const result = await engine.execute(
      { type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' },
      query({ dimensions: [{ field: 'ORDER_DATE', grain: 'month' }], measures: [{ field: 'AMOUNT', agg: 'sum', as: 'revenue' }, { field: '*', agg: 'count' }], limit: 2 }),
      ctx('team-a'),
    );
    expect(result).toEqual({
      columns: [
        { name: 'ORDER_DATE', type: 'time', grain: 'month' },
        { name: 'revenue', type: 'number' },
        { name: 'count', type: 'number' },
      ],
      rows: [
        { ORDER_DATE: '2026-10-01', revenue: 1234.5, count: 7 },
        { ORDER_DATE: '2026-11-01', revenue: null, count: 0 },
      ],
      truncated: true,
    });
    const sql = driver.calls.at(-1)!;
    expect(sql.teamId).toBe('team-a');
    expect(sql.sql).toBe(
      [
        `SELECT TO_CHAR(DATE_TRUNC('MONTH', "ORDER_DATE"), 'YYYY-MM-DD') AS "ORDER_DATE", round(CAST(sum("AMOUNT") AS DOUBLE), 6) AS "revenue", count(*) AS "count"`,
        'FROM "SALES"."PUBLIC"."ORDERS"',
        'GROUP BY 1',
        'ORDER BY 1 ASC NULLS LAST',
        'LIMIT 3',
      ].join('\n'),
    );
  });

  it('treats tables the team role cannot see as not found', async () => {
    const engine = new SnowflakeEngine(new FakeDriver(answer), config);
    const q = query({ measures: [{ field: '*', agg: 'count' }] });
    for (const [team, ref] of [['team-b', 'SALES.PUBLIC.ORDERS'], ['team-a', 'SALES.PUBLIC.MISSING'], ['team-a', 'not-a-ref'], ['team-a', 'A.B"C.D']]) {
      const error = await engine.execute({ type: 'snowflake', ref: ref! }, q, ctx(team!)).catch((e: EngineError) => e);
      expect((error as EngineError).code).toBe('unknown_source');
    }
    expect(await engine.profile('team-b', 'SALES.PUBLIC.ORDERS')).toBeNull();
  });

  it('1.3 joins: every joined table is resolved under the team role; unseen tables are not found', async () => {
    const driver = new FakeDriver((call) =>
      call.sql.includes('INFORMATION_SCHEMA"."COLUMNS"') && call.binds[1] === 'TARGETS' && call.teamId === 'team-a'
        ? [{ COLUMN_NAME: 'REGION', DATA_TYPE: 'TEXT', NUMERIC_SCALE: null }, { COLUMN_NAME: 'TARGET', DATA_TYPE: 'NUMBER', NUMERIC_SCALE: 0 }]
        : answer(call),
    );
    const engine = new SnowflakeEngine(driver, config);
    const q = attachJoinSources(
      query({ joins: [{ source: 't', type: 'left', on: [{ left: 'REGION', right: 'REGION' }] }], dimensions: [{ field: 'REGION' }], measures: [{ field: 't.TARGET', agg: 'max', as: 'target' }] }),
      { s: { type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, t: { type: 'snowflake', ref: 'SALES.PUBLIC.TARGETS' } },
    );
    await engine.execute({ type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, q, ctx('team-a'));
    expect(driver.calls.at(-1)!.sql).toContain('FROM "SALES"."PUBLIC"."ORDERS" AS "t0" LEFT JOIN "SALES"."PUBLIC"."TARGETS" AS "t1" ON "t0"."REGION" = "t1"."REGION"');
    const hidden = attachJoinSources(q, { s: { type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, t: { type: 'snowflake', ref: 'SALES.PUBLIC.SECRET' } });
    await expect(engine.execute({ type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, hidden, ctx('team-a'))).rejects.toMatchObject({ code: 'unknown_source' });
  });

  it('caches schemas per team, not globally', async () => {
    const driver = new FakeDriver(answer);
    const engine = new SnowflakeEngine(driver, config);
    const q = query({ measures: [{ field: '*', agg: 'count' }] });
    await engine.execute({ type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, q, ctx('team-a'));
    await engine.execute({ type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, q, ctx('team-a'));
    expect(driver.calls.filter((c) => c.sql.includes('COLUMNS')).length).toBe(1);
    await engine.execute({ type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, q, ctx('team-b')).catch(() => {});
    expect(driver.calls.filter((c) => c.sql.includes('COLUMNS')).map((c) => c.teamId)).toEqual(['team-a', 'team-b']);
  });

  it('lists tables and views the role can see, scoped to the team database', async () => {
    const driver = new FakeDriver(answer);
    const engine = new SnowflakeEngine(driver, config);
    expect(await engine.list('team-a')).toEqual([
      { source: { type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' }, name: 'SALES.PUBLIC.ORDERS', rowCount: 1200000, createdAt: '2026-01-01T00:00:00.000Z' },
      { source: { type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS_V' }, name: 'SALES.PUBLIC.ORDERS_V', createdAt: '2026-01-02T00:00:00.000Z' },
    ]);
    expect(driver.calls[0]).toEqual({ teamId: 'team-a', sql: 'SHOW OBJECTS IN DATABASE "SALES" LIMIT 1000', binds: [] });
    await engine.list('team-b');
    expect(driver.calls[1]!.sql).toBe('SHOW OBJECTS IN ACCOUNT LIMIT 1000');
  });

  it('profiles a fixed-size sample, never a full scan, and never returns rows', async () => {
    const driver = new FakeDriver(answer);
    const engine = new SnowflakeEngine(driver, config, { now: () => new Date('2026-11-09T00:00:00Z') });
    const profile = await engine.profile('team-a', 'SALES.PUBLIC.ORDERS');
    const statsCalls = driver.calls.filter((c) => c.sql.startsWith('WITH t AS'));
    expect(statsCalls).toHaveLength(2);
    for (const call of statsCalls) expect(call.sql).toContain('WITH t AS (SELECT * FROM (SELECT * FROM "SALES"."PUBLIC"."ORDERS" SAMPLE (10000 ROWS)))');
    expect(statsCalls[0]!.sql).toContain('APPROX_COUNT_DISTINCT("REGION")');
    expect(profile).toMatchObject({
      source: { type: 'snowflake', ref: 'SALES.PUBLIC.ORDERS' },
      rowCount: 1200000, // from table metadata
      sampled: true,
      timeColumns: ['ORDER_DATE'],
      measureCandidates: ['AMOUNT'],
      dimensionCandidates: ['REGION'],
      keyCandidates: ['ORDER_ID'],
    });
    const region = profile!.columns.find((c) => c.name === 'REGION')!;
    expect(region).toMatchObject({ physicalType: 'string', semanticType: 'geo', role: 'dimension', nullRate: 0.01, distinctCount: 2, cardinality: 'low', sampleValues: ['NA', 'EU'] });
    const id = profile!.columns.find((c) => c.name === 'ORDER_ID')!;
    expect(id).toMatchObject({ semanticType: 'id', cardinality: 'unique', distinctCount: 10000 }); // HLL overshoot clamped
    expect(profile!.columns.find((c) => c.name === 'AMOUNT')).toMatchObject({ min: 1.5, max: 999.5, format: 'currency', sampleValues: [19.99] });
  });
});

describe('Snowflake configuration', () => {
  it('is absent without credentials, so the engine stays engine_unavailable', async () => {
    expect(loadSnowflakeConfig({})).toBeNull();
    expect(loadSnowflakeConfig({ SNOWFLAKE_ACCOUNT: 'a', SNOWFLAKE_USER: 'u' })).toBeNull();
    const layer = createDataLayer({ snowflake: loadSnowflakeConfig({}) });
    const error = await layer.engines.snowflake!.execute({ type: 'snowflake', ref: 'A.B.C' }, query({ measures: [{ field: '*', agg: 'count' }] }), ctx('t')).catch((e: EngineError) => e);
    expect((error as EngineError).code).toBe('engine_unavailable');
    expect(layer.sources.providers.map((p) => p.type)).toEqual(['sample', 'file']);
  });

  it('reads per-team overrides', () => {
    const cfg = loadSnowflakeConfig({
      SNOWFLAKE_ACCOUNT: 'acme',
      SNOWFLAKE_USER: 'svc',
      SNOWFLAKE_PASSWORD: 'pw',
      SNOWFLAKE_WAREHOUSE: 'WH',
      SNOWFLAKE_ROLE: 'R',
      SNOWFLAKE_TEAM_CONFIG: '{"team-a": {"warehouse": "A_WH", "role": "A_ROLE"}}',
      SNOWFLAKE_STATEMENT_TIMEOUT_S: '30',
    })!;
    expect(cfg.statementTimeoutSeconds).toBe(30);
    expect(teamSettings(cfg, 'team-a')).toEqual({ warehouse: 'A_WH', role: 'A_ROLE', database: undefined });
    expect(teamSettings(cfg, 'team-b')).toEqual({ warehouse: 'WH', role: 'R', database: undefined });
    expect(teamSettings(cfg, '__proto__')).toEqual({ warehouse: 'WH', role: 'R', database: undefined });
    expect(() => loadSnowflakeConfig({ SNOWFLAKE_ACCOUNT: 'a', SNOWFLAKE_USER: 'u', SNOWFLAKE_PASSWORD: 'p', SNOWFLAKE_TEAM_CONFIG: '{nope' })).toThrow(/JSON/);
  });

  it('parses DB.SCHEMA.TABLE refs strictly', () => {
    expect(parseTableRef('SALES.PUBLIC.ORDERS')).toEqual({ database: 'SALES', schema: 'PUBLIC', table: 'ORDERS' });
    expect(parseTableRef('SALES.ORDERS')).toBeNull();
    expect(parseTableRef('A.B.C.D')).toBeNull();
    expect(parseTableRef('A.B."C"')).toBeNull();
  });
});
