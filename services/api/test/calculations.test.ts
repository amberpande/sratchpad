import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuerySchema, type Cell, type DataSource, type QueryInput } from '@yourorg/bi-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBFileEngine } from '../src/data/duckdb/engine';
import { DuckDBRuntime } from '../src/data/duckdb/runtime';
import { EngineError } from '../src/data/engine';
import { MemoryFileSourceRegistry } from '../src/data/files/registry';
import { FileSources } from '../src/data/files/service';
import { expandMetrics, validateMetricDefinition, type MetricDefinition } from '../src/data/metrics';
import { SampleEngine } from '../src/data/sample/engine';
import { runInMemoryQuery, type Row } from '../src/data/sample/execute';
import { compileQuery } from '../src/data/sql/compile';
import { duckdb, snowflake, type ColumnKind } from '../src/data/sql/dialect';
import { attachJoinSources } from '../src/data/sql/joins';

/**
 * Spec 1.3 calculations beyond the per-case conformance table: joins (DuckDB ≡ reference), error
 * parity for the new rules, the metric catalog, and the SQL shapes emitted for Snowflake.
 */

const NOW = new Date('2026-11-09T15:30:00Z');
const ctx = () => ({ teamId: 't', signal: new AbortController().signal });

const orders = {
  fields: ['region', 'amount', 'status', 'customer'],
  rows: [
    { region: 'EU', amount: 100.5, status: 'paid', customer: 'a' },
    { region: 'EU', amount: 50.25, status: 'paid', customer: 'b' },
    { region: 'NA', amount: 200, status: 'paid', customer: 'a' },
    { region: 'NA', amount: 999.99, status: 'refunded', customer: 'c' },
    { region: null, amount: 75, status: 'paid', customer: 'd' },
    { region: 'APAC', amount: 50.25, status: 'pending', customer: 'a' },
  ] as Row[],
};
// Two EU rows (fan-out), no APAC row (left join keeps it with NULLs), a NULL key (never matches).
const targets = {
  fields: ['region', 'target', 'manager'],
  rows: [
    { region: 'EU', target: 100, manager: 'Ana' },
    { region: 'EU', target: 7, manager: 'Ben' },
    { region: 'NA', target: 500, manager: 'Cy' },
    { region: 'LATAM', target: 10, manager: 'Di' },
    { region: null, target: 1, manager: 'Ed' },
  ] as Row[],
};

function toCsv(fields: string[], rows: Row[]): string {
  const esc = (v: Cell) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [fields.join(','), ...rows.map((r) => fields.map((f) => esc(r[f] ?? null)).join(','))].join('\n') + '\n';
}

let dataDir: string;
let runtime: DuckDBRuntime;
let engine: DuckDBFileEngine;
let src: DataSource;
let tg: DataSource;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'bi-calc-'));
  runtime = new DuckDBRuntime();
  const files = new FileSources({ runtime, registry: new MemoryFileSourceRegistry(), dataDir, now: () => NOW });
  engine = new DuckDBFileEngine(files, runtime);
  const load = async (name: string, t: { fields: string[]; rows: Row[] }, teamId = 't') =>
    (await files.upload({ teamId, subject: 'u', fileName: `${name}.csv`, bytes: new TextEncoder().encode(toCsv(t.fields, t.rows)) })).summary.source;
  src = await load('orders', orders);
  tg = await load('targets', targets);
});
afterAll(async () => {
  await runtime?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const joinCases: Array<[string, Omit<QueryInput, 'source'>]> = [
  ['left join with fan-out and an unmatched key', {
    joins: [{ source: 'tg', type: 'left', on: [{ left: 'region', right: 'region' }] }],
    dimensions: [{ field: 'region' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: '*', agg: 'count', as: 'rows' }, { field: 'tg.target', agg: 'max', as: 'target' }],
    calcs: [{ as: 'vs_target', expr: 'revenue / max(tg.target)' }],
  }],
  ['inner join grouped by a joined column', {
    joins: [{ source: 'tg', type: 'inner', on: [{ left: 'region', right: 'region' }] }],
    dimensions: [{ field: 'tg.manager', as: 'manager' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: 'tg.target', agg: 'sum', as: 'target' }],
    filters: [{ field: 'tg.target', op: 'gt', value: 5 }],
  }],
  ['qualified primary fields work too', {
    joins: [{ source: 'tg', on: [{ left: 'src.region', right: 'tg.region' }] }],
    dimensions: [{ field: 'src.status', as: 'status' }],
    measures: [{ field: 'tg.manager', agg: 'count_distinct', as: 'managers' }],
  }],
];

describe('joins: DuckDB ≡ reference', () => {
  it.each(joinCases)('%s', async (_name, input) => {
    const q = attachJoinSources(QuerySchema.parse({ source: 'src', ...input }), { src, tg });
    const expected = runInMemoryQuery(orders.rows, new Set(orders.fields), q, new Map([['tg', { rows: targets.rows, fields: new Set(targets.fields) }]]));
    const actual = await engine.execute(src, q, ctx());
    expect(actual).toEqual(expected);
    expect(expected.rows.length).toBeGreaterThan(0);
  });

  it('left join keeps unmatched rows and multiplies matched ones', async () => {
    const q = attachJoinSources(QuerySchema.parse({ source: 'src', ...joinCases[0]![1] }), { src, tg });
    const res = await engine.execute(src, q, ctx());
    const eu = res.rows.find((r) => r.region === 'EU')!;
    expect(eu).toMatchObject({ rows: 4, target: 100, revenue: 301.5 });
    expect(res.rows.find((r) => r.region === 'APAC')).toMatchObject({ rows: 1, target: null, vs_target: null });
  });

  it('refuses unresolved, cross-type and other-team joins', async () => {
    const q = QuerySchema.parse({ source: 'src', ...joinCases[0]![1] });
    await expect(engine.execute(src, q, ctx())).rejects.toMatchObject({ code: 'unknown_source' });
    await expect(engine.execute(src, attachJoinSources(q, { src, tg: { type: 'sample', ref: 'orders' } }), ctx())).rejects.toMatchObject({ code: 'invalid_join' });
    // Another team cannot reach "tg" even with its ref.
    await expect(engine.execute(src, attachJoinSources(q, { src, tg }), { ...ctx(), teamId: 'other' })).rejects.toMatchObject({ code: 'unknown_source' });
  });

  it('sample engine joins sample datasets', async () => {
    const sample = new SampleEngine({ a: () => ({ rows: orders.rows, fields: new Set(orders.fields) }), b: () => ({ rows: targets.rows, fields: new Set(targets.fields) }) }, () => NOW);
    const q = attachJoinSources(
      QuerySchema.parse({ source: 'x', joins: [{ source: 'y', type: 'inner', on: [{ left: 'region', right: 'region' }] }], dimensions: [{ field: 'y.manager', as: 'manager' }], measures: [{ field: '*', agg: 'count', as: 'n' }] }),
      { x: { type: 'sample', ref: 'a' }, y: { type: 'sample', ref: 'b' } },
    );
    const res = await sample.execute({ type: 'sample', ref: 'a' }, q, ctx());
    expect(res.rows).toEqual([
      { manager: 'Ana', n: 2 },
      { manager: 'Ben', n: 2 },
      { manager: 'Cy', n: 2 },
    ]);
  });
});

describe('error parity for 1.3 rules', () => {
  const codes = async (input: Omit<QueryInput, 'source'>) => {
    const q = QuerySchema.parse({ source: 'src', ...input });
    let reference: string | undefined;
    try {
      runInMemoryQuery(orders.rows, new Set(orders.fields), q);
    } catch (e) {
      reference = (e as EngineError).code;
    }
    const duck = await engine.execute(src, q, ctx()).then(() => undefined, (e: EngineError) => e.code);
    return { reference, duck };
  };
  it.each<[string, Omit<QueryInput, 'source'>, string]>([
    ['median of text', { measures: [{ field: 'status', agg: 'median' }] }, 'invalid_measure'],
    ['contains on a number', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'amount', op: 'contains', value: '1' }] }, 'invalid_filter'],
    ['bin on text', { dimensions: [{ field: 'status', bin: { width: 1 } }] }, 'invalid_dimension'],
    ['calc on an unknown column', { measures: [{ field: '*', agg: 'count' }], calcs: [{ as: 'x', expr: 'sum(profit)' }] }, 'unknown_field'],
    ['calc on a text max', { measures: [{ field: 'status', agg: 'max', as: 'm' }], calcs: [{ as: 'x', expr: 'm * 2' }] }, 'invalid_calc'],
    ['calc syntax error', { measures: [{ field: '*', agg: 'count' }], calcs: [{ as: 'x', expr: 'count +' }] }, 'invalid_expression'],
    ['ordered window that misses a dimension', { dimensions: [{ field: 'region' }, { field: 'status' }], measures: [{ field: '*', agg: 'count', as: 'n' }], windows: [{ as: 'r', type: 'running_total', measure: 'n', order: 'region' }] }, 'invalid_window'],
    ['top-N on a number', { dimensions: [{ field: 'amount' }], measures: [{ field: '*', agg: 'count', as: 'n' }], topN: { dimension: 'amount', n: 2, by: 'n' } }, 'invalid_top_n'],
    ['unexpanded catalog metrics', { metrics: [{ metric: 'revenue' }] }, 'metrics_not_expanded'],
    ['duplicate output names', { measures: [{ field: '*', agg: 'count', as: 'x' }], calcs: [{ as: 'x', expr: 'x + 1' }] }, 'duplicate_column'],
  ])('%s', async (_name, input, code) => {
    expect(await codes(input)).toEqual({ reference: code, duck: code });
  });
});

describe('metric catalog', () => {
  const catalog: MetricDefinition[] = [
    { name: 'revenue', field: 'amount', agg: 'sum', format: 'currency' },
    { name: 'orders', field: '*', agg: 'count' },
    { name: 'aov', expr: 'revenue / orders', format: 'currency' },
    { name: 'aov_x2', expr: 'aov * 2' },
  ];

  it('validates definitions', () => {
    for (const m of catalog) expect(validateMetricDefinition(m)).toMatchObject({ ok: true });
    const bad = (d: unknown) => {
      const r = validateMetricDefinition(d);
      return r.ok ? [] : r.errors.map((e) => e.path);
    };
    expect(bad({ name: 'Revenue', field: 'amount', agg: 'sum' })).toEqual(['name']);
    expect(bad({ name: 'x', field: 'amount', agg: 'total' })).toEqual(['agg']);
    expect(bad({ name: 'x', field: 'a', agg: 'sum', expr: 'a' })).toEqual(['expr']);
    expect(bad({ name: 'x', expr: 'x + 1' })).toEqual(['expr']);
    expect(bad({ name: 'x', expr: 'sum(' })).toEqual(['expr']);
    expect(bad({ name: 'x' })).toEqual(['']);
    expect(bad({ name: 'x', field: 'a', agg: 'sum', color: 'red' })).toEqual(['color']);
  });

  it('expands simple metrics to measures and derived ones to calcs, and the result runs', async () => {
    const q = QuerySchema.parse({ source: 'src', dimensions: [{ field: 'region' }], metrics: [{ metric: 'revenue' }, { metric: 'aov_x2', as: 'double_aov' }, { metric: 'orders' }], calcs: [{ as: 'pct', expr: 'revenue * 100 / sum(amount)' }] });
    const expanded = expandMetrics(q, catalog);
    expect(expanded.metrics).toBeUndefined();
    expect(expanded.measures).toEqual([
      { field: 'amount', agg: 'sum', as: 'revenue' },
      { field: '*', agg: 'count', as: 'orders' },
    ]);
    expect(expanded.calcs!.map((c) => c.as)).toEqual(['double_aov', 'pct']);
    const expected = runInMemoryQuery(orders.rows, new Set(orders.fields), expanded);
    const actual = await engine.execute(src, expanded, ctx());
    expect(actual).toEqual(expected);
    expect(actual.rows.find((r) => r.region === 'EU')).toMatchObject({ revenue: 150.75, orders: 2, double_aov: 150.75, pct: 100 });
  });

  it('reports unknown metrics and cycles', () => {
    const q = QuerySchema.parse({ source: 'src', metrics: [{ metric: 'nope' }] });
    expect(() => expandMetrics(q, catalog)).toThrow(expect.objectContaining({ code: 'unknown_metric' }));
    const cyclic = [{ name: 'a', expr: 'b + 1' }, { name: 'b', expr: 'a + 1' }];
    expect(() => expandMetrics(QuerySchema.parse({ source: 'src', metrics: [{ metric: 'a' }] }), cyclic)).toThrow(/cycle/);
    expect(expandMetrics(QuerySchema.parse({ source: 'src', measures: [{ field: '*', agg: 'count' }] }), catalog).metrics).toBeUndefined();
  });
});

describe('SQL shapes', () => {
  const columns = new Map<string, ColumnKind>([
    ['order_date', 'date'],
    ['region', 'string'],
    ['amount', 'number'],
    ['status', 'string'],
  ]);
  const compile = (dialect: typeof duckdb, q: Omit<QueryInput, 'source'>, joined?: Parameters<typeof compileQuery>[1]['joined']) =>
    compileQuery(QuerySchema.parse({ source: 's', ...q }), { dialect, relation: { sql: '"DB"."S"."ORDERS"', params: [] }, columns, joined });

  it('percentiles use each dialect’s aggregate', () => {
    const q = { measures: [{ field: 'amount', agg: 'p90' as const }, { field: 'amount', agg: 'median' as const }, { field: 'amount', agg: 'stddev' as const }] };
    expect(compile(snowflake, q).sql).toContain('round(CAST(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY "amount") AS DOUBLE), 6) AS "p90_amount"');
    expect(compile(snowflake, q).sql).toContain('stddev_samp("amount")');
    expect(compile(duckdb, q).sql).toContain('quantile_cont("amount", 0.5)');
  });

  it('every user value is a bind; frame sizes and offsets are validated integers', () => {
    const out = compile(snowflake, {
      dimensions: [
        { field: 'order_date', grain: 'month' },
        { field: 'region', as: 'area', buckets: { rules: [{ op: 'eq', value: "EU'; DROP", label: "Europe'--" }], else: 'Rest' } },
      ],
      measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
      calcs: [{ as: 'x', expr: 'revenue * 1.5' }],
      filters: [{ field: 'status', op: 'contains', value: "50%_off'" }],
      windows: [{ as: 'yoy', type: 'percent_change', measure: 'revenue', order: 'order_date', partition: ['area'], offset: 12 }],
    });
    expect(out.sql).not.toContain('DROP');
    expect(out.sql).not.toContain('Europe');
    expect(out.sql).not.toContain('50%');
    expect(out.params).toEqual(["EU'; DROP", "Europe'--", 'Rest', 1.5, "%50!%!_off'%"]);
    expect(out.sql).toContain(`lag("q"."revenue", 12) OVER (PARTITION BY "q"."area" ORDER BY "q"."order_date" ASC NULLS LAST)`);
    expect(out.sql).toContain(`lower("status") LIKE ? ESCAPE '!'`);
    expect(out.sql).toMatch(/^SELECT "q"\."order_date", "q"\."area", "q"\."revenue", "q"\."x", .* AS "yoy"\nFROM \(\nSELECT /);
  });

  it('top-N ranks inside a subquery over the same filtered relation, binds repeated in order', () => {
    const out = compile(snowflake, {
      dimensions: [{ field: 'region' }],
      measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
      filters: [{ field: 'status', op: 'eq', value: 'paid' }],
      topN: { dimension: 'region', n: 3, by: 'revenue' },
    });
    expect(out.sql).toContain(`CASE WHEN "region" IN (SELECT "region" FROM "DB"."S"."ORDERS" WHERE "status" = ? GROUP BY 1 ORDER BY round(CAST(sum("amount") AS DOUBLE), 6) DESC NULLS LAST, 1 ASC NULLS LAST LIMIT 3) THEN "region" ELSE CAST(? AS VARCHAR) END`);
    expect(out.params).toEqual(['paid', 'Other', 'paid']);
  });

  it('joins alias every relation and qualify every column', () => {
    const out = compile(
      snowflake,
      { joins: [{ source: 'tg', type: 'inner', on: [{ left: 'region', right: 'region' }] }], dimensions: [{ field: 'tg.manager' }], measures: [{ field: 'amount', agg: 'sum' }] },
      new Map([['tg', { relation: { sql: '"DB"."S"."TARGETS"', params: [] }, columns: new Map<string, ColumnKind>([['region', 'string'], ['manager', 'string']]) }]]),
    );
    expect(out.sql).toContain('FROM "DB"."S"."ORDERS" AS "t0" INNER JOIN "DB"."S"."TARGETS" AS "t1" ON "t0"."region" = "t1"."region"');
    expect(out.sql).toContain('"t1"."manager" AS "tg.manager"');
    expect(out.sql).toContain('round(CAST(sum("t0"."amount") AS DOUBLE), 6)');
  });
});
