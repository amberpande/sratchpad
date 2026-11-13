import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuerySchema, type Cell, type DataSource, type QueryInput, type QueryResult } from '@yourorg/bi-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBFileEngine } from '../src/data/duckdb/engine';
import { DuckDBRuntime } from '../src/data/duckdb/runtime';
import { EngineError, type Engine } from '../src/data/engine';
import { MemoryFileSourceRegistry } from '../src/data/files/registry';
import { FileSources } from '../src/data/files/service';
import { runInMemoryQuery, type Row } from '../src/data/sample/execute';
import { attachJoinSources } from '../src/data/sql/joins';
import { generateOrders } from '../src/data/sample/orders';

/**
 * The conformance suite. The in-memory sample engine is the reference implementation of query
 * semantics; every SQL engine must return exactly what it returns (rows, row order, columns,
 * truncated) for the same query over the same rows. Each case runs against both engines here:
 * the DuckDB side loads the rows through the real upload path (CSV → Parquet), so CSV type
 * inference is covered too.
 */

const NOW = new Date('2026-11-09T15:30:00Z');

const small: { fields: string[]; rows: Row[] } = {
  fields: ['d', 'region', 'amount', 'qty', 'status', 'customer', 'vip'],
  rows: [
    { d: '2026-01-05', region: 'EU', amount: 100.5, qty: 1, status: 'paid', customer: 'a', vip: true },
    { d: '2026-01-20', region: 'EU', amount: 50.25, qty: 2, status: 'paid', customer: 'b', vip: false },
    { d: '2026-02-03', region: 'NA', amount: 200, qty: 3, status: 'paid', customer: 'a', vip: true },
    { d: '2026-02-04', region: 'NA', amount: 999.99, qty: 1, status: 'refunded', customer: 'c', vip: null },
    { d: '2026-03-15', region: null, amount: null, qty: 4, status: 'paid', customer: 'd', vip: false },
    { d: '2026-03-16', region: 'APAC', amount: 50.25, qty: null, status: 'pending', customer: 'a', vip: true },
    { d: '2025-12-29', region: 'EU', amount: 10, qty: 2, status: 'paid', customer: 'e', vip: false },
    { d: null, region: 'NA', amount: 75, qty: 1, status: 'paid', customer: null, vip: false },
  ],
};

const orders = generateOrders(NOW);

function toCsv(fields: string[], rows: Row[]): string {
  const esc = (v: Cell) => {
    if (v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.join(','), ...rows.map((r) => fields.map((f) => esc(r[f] ?? null)).join(','))].join('\n') + '\n';
}

type Case = [name: string, query: Omit<QueryInput, 'source'>];

const smallCases: Case[] = [
  ['count rows', { measures: [{ field: '*', agg: 'count' }] }],
  ['every aggregation', {
    measures: [
      { field: 'amount', agg: 'sum' },
      { field: 'amount', agg: 'avg' },
      { field: 'amount', agg: 'min' },
      { field: 'amount', agg: 'max' },
      { field: 'amount', agg: 'count' },
      { field: 'customer', agg: 'count_distinct' },
      { field: 'qty', agg: 'sum' },
      { field: 'd', agg: 'min', as: 'first_day' },
      { field: 'd', agg: 'max', as: 'last_day' },
      { field: 'region', agg: 'min', as: 'min_region' },
      { field: 'region', agg: 'max', as: 'max_region' },
    ],
  }],
  ['group by a string with a NULL group (sorted last)', { dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] }],
  ['group by desc keeps NULLs last', { dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count' }], orderBy: [{ field: 'region', dir: 'desc' }] }],
  ['order by a measure with NULLs, asc', { dimensions: [{ field: 'customer' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }], orderBy: [{ field: 'revenue', dir: 'asc' }] }],
  ['order by a measure with NULLs, desc', { dimensions: [{ field: 'customer' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }], orderBy: [{ field: 'revenue', dir: 'desc' }] }],
  ['ties broken by dimensions', { dimensions: [{ field: 'status' }, { field: 'region' }], measures: [{ field: '*', agg: 'count' }], orderBy: [{ field: 'count', dir: 'desc' }] }],
  ['limit + truncated', { dimensions: [{ field: 'customer' }], measures: [{ field: '*', agg: 'count' }], orderBy: [{ field: 'count', dir: 'desc' }], limit: 2 }],
  ['limit equal to group count is not truncated', { dimensions: [{ field: 'status' }], measures: [{ field: '*', agg: 'count' }], limit: 3 }],
  ['month grain with a NULL date group', { dimensions: [{ field: 'd', grain: 'month' }], measures: [{ field: 'amount', agg: 'sum' }, { field: '*', agg: 'count' }] }],
  ['week grain starts Monday (Dec 29 2025 is a Monday; Jan 5 too)', { dimensions: [{ field: 'd', grain: 'week', as: 'week' }], measures: [{ field: '*', agg: 'count' }] }],
  ['day, quarter and year grains', { dimensions: [{ field: 'd', grain: 'quarter', as: 'q' }, { field: 'd', grain: 'year', as: 'y' }, { field: 'd', grain: 'day', as: 'day' }], measures: [{ field: 'qty', agg: 'sum' }] }],
  ['date as a plain dimension', { dimensions: [{ field: 'd' }], measures: [{ field: 'qty', agg: 'max' }], orderBy: [{ field: 'd', dir: 'desc' }] }],
  ['boolean dimension', { dimensions: [{ field: 'vip' }], measures: [{ field: '*', agg: 'count' }] }],
  ['boolean min/max', { dimensions: [{ field: 'region' }], measures: [{ field: 'vip', agg: 'min' }, { field: 'vip', agg: 'max' }] }],
  ['dimensions without measures (distinct)', { dimensions: [{ field: 'status' }, { field: 'vip' }] }],
  ['ungrouped aggregate over no rows', { measures: [{ field: 'amount', agg: 'sum' }, { field: 'customer', agg: 'count_distinct' }, { field: '*', agg: 'count' }, { field: 'd', agg: 'max' }], filters: [{ field: 'status', op: 'eq', value: 'nope' }] }],
  ['grouped aggregate over no rows', { dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'amount', op: 'gt', value: 1e9 }] }],
  ['eq / neq (neq excludes NULL)', { dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'region', op: 'neq', value: 'EU' }] }],
  ['gt / lte on numbers', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'amount', op: 'gt', value: 50.25 }, { field: 'amount', op: 'lte', value: 200 }] }],
  ['gte / lt on dates (a daterange param)', { dimensions: [{ field: 'd', grain: 'month' }], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'd', op: 'gte', value: '2026-01-10' }, { field: 'd', op: 'lt', value: '2026-03-16' }] }],
  ['eq on a date and a boolean', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'd', op: 'eq', value: '2026-02-03' }, { field: 'vip', op: 'eq', value: true }] }],
  ['in with a NULL in the list', { dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'region', op: 'in', value: ['EU', null, 'APAC'] }] }],
  ['not_in with a NULL in the list', { dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'region', op: 'not_in', value: ['EU', null] }] }],
  ['in with only NULL', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'region', op: 'in', value: [null] }] }],
  ['not_in with only NULL', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'region', op: 'not_in', value: [null] }] }],
  ['between on dates and numbers', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'd', op: 'between', value: ['2026-01-10', '2026-02-03'] }, { field: 'qty', op: 'between', value: [1, 3] }] }],
  ['between with a NULL bound', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'qty', op: 'between', value: [null, 3] }] }],
  ['is_null / not_null', { dimensions: [{ field: 'status' }], measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'amount', op: 'not_null' }, { field: 'vip', op: 'is_null' }] }],
  ['in on numbers', { measures: [{ field: 'amount', agg: 'sum' }], filters: [{ field: 'qty', op: 'in', value: [1, 4] }] }],
];

// ── spec 1.3: calculations ────────────────────────────────────────────────────
const calcCases: Case[] = [
  ['median, percentiles and stddev by region', {
    dimensions: [{ field: 'region' }],
    measures: [
      { field: 'amount', agg: 'median' }, { field: 'amount', agg: 'p25' }, { field: 'amount', agg: 'p75' },
      { field: 'amount', agg: 'p90' }, { field: 'amount', agg: 'stddev' }, { field: 'qty', agg: 'median', as: 'qty_median' },
    ],
  }],
  ['ungrouped statistics over no rows', { measures: [{ field: 'amount', agg: 'median' }, { field: 'qty', agg: 'stddev' }], filters: [{ field: 'status', op: 'eq', value: 'nope' }] }],
  ['calcs: ratios, division by zero, functions and NULL groups', {
    dimensions: [{ field: 'region' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: '*', agg: 'count', as: 'n' }],
    calcs: [
      { as: 'avg_ticket', expr: 'revenue / n' },
      { as: 'qty_share', expr: 'round(sum(qty) * 100 / revenue, 2)' },
      { as: 'zero_div', expr: 'revenue / (n - n)' },
      { as: 'least_rev', expr: 'least(revenue, 100)' },
      { as: 'greatest_x', expr: 'greatest(revenue, sum(qty))' },
      { as: 'coalesced', expr: 'coalesce(revenue, -1)' },
      { as: 'nullif_n', expr: 'nullif(n, 1)' },
      { as: 'abs_neg', expr: 'abs(-revenue) + 0.5' },
      { as: 'double_ticket', expr: 'avg_ticket * 2' },
      { as: 'distinct_customers', expr: 'count_distinct(customer) + count(*) - n' },
    ],
    orderBy: [{ field: 'avg_ticket', dir: 'desc' }],
  }],
  ['calc-only ordering and limit', {
    dimensions: [{ field: 'customer' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
    calcs: [{ as: 'per_item', expr: 'revenue / sum(qty)' }],
    orderBy: [{ field: 'per_item', dir: 'asc' }],
    limit: 3,
  }],
  ['numeric bins (histogram)', { dimensions: [{ field: 'amount', bin: { width: 100 }, as: 'amount_bin' }], measures: [{ field: '*', agg: 'count' }] }],
  ['bins with an offset', { dimensions: [{ field: 'qty', bin: { width: 2, offset: 1 } }], measures: [{ field: '*', agg: 'count' }] }],
  ['buckets with in, is_null, contains and else', {
    dimensions: [
      { field: 'region', as: 'area', buckets: { rules: [{ op: 'in', value: ['EU'], label: 'Europe' }, { op: 'is_null', label: 'Unknown' }], else: 'Rest' } },
      { field: 'status', as: 'state', buckets: { rules: [{ op: 'contains', value: 'PAI', label: 'Paid-ish' }] } },
    ],
    measures: [{ field: '*', agg: 'count' }],
  }],
  ['contains / starts_with / ends_with (case-insensitive, wildcards escaped)', {
    dimensions: [{ field: 'status' }],
    measures: [{ field: '*', agg: 'count' }],
    filters: [{ field: 'status', op: 'contains', value: 'PAI' }, { field: 'customer', op: 'starts_with', value: 'A' }, { field: 'region', op: 'ends_with', value: 'u' }],
  }],
  ['a "%" in a search value is literal', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'status', op: 'contains', value: '%' }] }],
  ['windows along months', {
    dimensions: [{ field: 'd', grain: 'month', as: 'month' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
    windows: [
      { as: 'running', type: 'running_total', measure: 'revenue', order: 'month' },
      { as: 'moving', type: 'moving_average', measure: 'revenue', order: 'month', window: 2 },
      { as: 'diff', type: 'difference', measure: 'revenue', order: 'month' },
      { as: 'change', type: 'percent_change', measure: 'revenue', order: 'month' },
      { as: 'share', type: 'percent_of_total', measure: 'revenue' },
      { as: 'rk', type: 'rank', measure: 'revenue' },
      { as: 'rk_dense_asc', type: 'rank', measure: 'revenue', dir: 'asc', dense: true },
    ],
  }],
  ['partitioned windows, ordered by a window column, limited', {
    dimensions: [{ field: 'region' }, { field: 'status' }],
    measures: [{ field: '*', agg: 'count', as: 'n' }, { field: 'amount', agg: 'sum', as: 'revenue' }],
    windows: [
      { as: 'running_in_region', type: 'running_total', measure: 'n', order: 'status', partition: ['region'] },
      { as: 'share_in_region', type: 'percent_of_total', measure: 'revenue', partition: ['region'] },
      { as: 'rank_in_status', type: 'rank', measure: 'revenue', partition: ['status'] },
    ],
    orderBy: [{ field: 'share_in_region', dir: 'desc' }],
    limit: 5,
  }],
  ['windows over a calc', {
    dimensions: [{ field: 'customer' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: 'qty', agg: 'sum', as: 'items' }],
    calcs: [{ as: 'per_item', expr: 'revenue / items' }],
    windows: [{ as: 'running_per_item', type: 'running_total', measure: 'per_item', order: 'customer' }],
  }],
  ['top-N with Other', {
    dimensions: [{ field: 'customer' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: 'amount', agg: 'avg', as: 'avg_amount' }, { field: '*', agg: 'count' }],
    topN: { dimension: 'customer', n: 2, by: 'revenue' },
    orderBy: [{ field: 'revenue', dir: 'desc' }],
  }],
  ['top-N without the remainder, ranked by a calc', {
    dimensions: [{ field: 'region' }, { field: 'status' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: '*', agg: 'count', as: 'n' }],
    calcs: [{ as: 'ticket', expr: 'revenue / n' }],
    topN: { dimension: 'region', n: 2, by: 'ticket', otherLabel: null },
  }],
  ['top-N with a custom label and a NULL group', {
    dimensions: [{ field: 'region' }],
    measures: [{ field: 'qty', agg: 'sum', as: 'items' }],
    topN: { dimension: 'region', n: 3, by: 'items', otherLabel: 'Everything else' },
  }],
];

const orderCases: Case[] = [
  ['revenue by month', { dimensions: [{ field: 'order_date', grain: 'month' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: '*', agg: 'count', as: 'orders' }] }],
  ['revenue by week, last 90 days', { dimensions: [{ field: 'order_date', grain: 'week' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }], filters: [{ field: 'order_date', op: 'gte', value: '2026-08-11' }, { field: 'order_date', op: 'lt', value: '2026-11-10' }] }],
  ['top customers, truncated', { dimensions: [{ field: 'customer_id' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }], orderBy: [{ field: 'revenue', dir: 'desc' }], limit: 10 }],
  ['region x category averages', { dimensions: [{ field: 'region' }, { field: 'category' }], measures: [{ field: 'amount', agg: 'avg' }, { field: 'quantity', agg: 'avg' }, { field: 'customer_id', agg: 'count_distinct' }] }],
  ['paid orders by quarter and channel', { dimensions: [{ field: 'order_date', grain: 'quarter' }, { field: 'channel' }], measures: [{ field: 'quantity', agg: 'sum' }], filters: [{ field: 'status', op: 'eq', value: 'paid' }], orderBy: [{ field: 'sum_quantity', dir: 'desc' }] }],
  ['totals', { measures: [{ field: 'amount', agg: 'sum' }, { field: 'amount', agg: 'avg' }, { field: 'amount', agg: 'min' }, { field: 'amount', agg: 'max' }, { field: 'order_date', agg: 'min' }, { field: 'order_id', agg: 'max' }] }],
  ['daily counts, many groups, limit', { dimensions: [{ field: 'order_date', grain: 'day' }], measures: [{ field: '*', agg: 'count' }], orderBy: [{ field: 'count', dir: 'desc' }], limit: 25 }],
  ['by year with status filter', { dimensions: [{ field: 'order_date', grain: 'year' }], measures: [{ field: 'amount', agg: 'sum' }], filters: [{ field: 'status', op: 'in', value: ['paid', 'pending'] }, { field: 'amount', op: 'gte', value: 500 }] }],
  ['1.3: year-over-year change by month', {
    dimensions: [{ field: 'order_date', grain: 'month' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
    windows: [
      { as: 'yoy', type: 'percent_change', measure: 'revenue', order: 'order_date', offset: 12 },
      { as: 'mom', type: 'difference', measure: 'revenue', order: 'order_date' },
      { as: 'ytd_running', type: 'running_total', measure: 'revenue', order: 'order_date' },
    ],
  }],
  ['1.4: calendar year-over-year by month and channel', {
    dimensions: [{ field: 'order_date', grain: 'month' }, { field: 'channel' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
    filters: [{ field: 'amount', op: 'gte', value: 4500 }],
    windows: [
      { as: 'yoy', type: 'percent_change', measure: 'revenue', order: 'order_date', partition: ['channel'], offset: 12, calendar: true },
      { as: 'mom', type: 'difference', measure: 'revenue', order: 'order_date', partition: ['channel'], calendar: true },
    ],
  }],
  ['1.4: row-level fields as measure, dimension and filter', {
    fields: [
      { as: 'unit_price', expr: 'amount / quantity' },
      { as: 'order_year', expr: 'year(order_date)' },
      { as: 'weekday', expr: 'weekday(order_date)' },
      { as: 'big', expr: 'round(amount * 1.1, 2)' },
    ],
    dimensions: [{ field: 'order_year' }, { field: 'weekday' }],
    measures: [{ field: 'unit_price', agg: 'avg' }, { field: 'big', agg: 'sum' }],
    filters: [{ field: 'unit_price', op: 'gt', value: 50 }],
  }],
  ['1.4: level of detail: average customer total by region, big customers only', {
    dimensions: [{ field: 'region' }, { field: 'order_date', grain: 'quarter', as: 'quarter' }],
    detail: { dimensions: [{ field: 'customer_id' }], measures: [{ field: 'amount', agg: 'sum', as: 'customer_total' }, { field: '*', agg: 'count', as: 'customer_orders' }] },
    measures: [{ field: 'customer_total', agg: 'avg', as: 'avg_customer_total' }, { field: 'customer_total', agg: 'max' }, { field: 'customer_orders', agg: 'median' }, { field: '*', agg: 'count', as: 'customers' }],
    filters: [{ field: 'status', op: 'eq', value: 'paid' }, { field: 'customer_total', op: 'gte', value: 1000 }],
    orderBy: [{ field: 'avg_customer_total', dir: 'desc' }],
  }],
  ['1.3: top 5 customers plus Other', {
    dimensions: [{ field: 'customer_id' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: 'amount', agg: 'avg', as: 'avg_amount' }, { field: '*', agg: 'count', as: 'orders' }],
    topN: { dimension: 'customer_id', n: 5, by: 'revenue' },
    orderBy: [{ field: 'revenue', dir: 'desc' }],
  }],
  ['1.3: order amount histogram', { dimensions: [{ field: 'amount', bin: { width: 500 } }], measures: [{ field: '*', agg: 'count', as: 'orders' }] }],
  ['1.3: distribution statistics by region', {
    dimensions: [{ field: 'region' }],
    measures: [{ field: 'amount', agg: 'median' }, { field: 'amount', agg: 'p25' }, { field: 'amount', agg: 'p75' }, { field: 'amount', agg: 'p90' }, { field: 'amount', agg: 'stddev' }],
  }],
  ['1.3: average order value and share of total by channel', {
    dimensions: [{ field: 'channel' }],
    measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: 'order_id', agg: 'count_distinct', as: 'orders' }],
    calcs: [{ as: 'aov', expr: 'revenue / orders' }],
    windows: [{ as: 'share', type: 'percent_of_total', measure: 'revenue' }],
  }],
];

interface Side {
  reference: (q: QueryInput) => QueryResult;
  engine: Engine;
  source: DataSource;
}

let dataDir: string;
let runtime: DuckDBRuntime;
const sides: Record<'small' | 'orders', Side> = {} as never;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'bi-conformance-'));
  runtime = new DuckDBRuntime();
  const files = new FileSources({ runtime, registry: new MemoryFileSourceRegistry(), dataDir, now: () => NOW });
  const engine = new DuckDBFileEngine(files, runtime);
  const load = async (name: string, fields: string[], rows: Row[]) => {
    const { summary } = await files.upload({ teamId: 't', subject: 'u', fileName: `${name}.csv`, bytes: new TextEncoder().encode(toCsv(fields, rows)) });
    return summary.source;
  };
  sides.small = { reference: (q) => runInMemoryQuery(small.rows, new Set(small.fields), QuerySchema.parse(q)), engine, source: await load('small', small.fields, small.rows) };
  sides.orders = { reference: (q) => runInMemoryQuery(orders.rows, orders.fields, QuerySchema.parse(q)), engine, source: await load('orders', [...orders.fields], orders.rows) };
});

afterAll(async () => {
  await runtime?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function both(side: Side, input: Omit<QueryInput, 'source'>) {
  const q = { source: 'src', ...input };
  const expected = side.reference(q);
  const actual = await side.engine.execute(side.source, QuerySchema.parse(q), { teamId: 't', signal: new AbortController().signal });
  return { expected, actual };
}

describe('conformance: DuckDB file engine ≡ in-memory reference', () => {
  describe.each([
    ['small fixture (NULLs, booleans, edge filters)', 'small' as const, smallCases],
    ['sample orders (~8k rows)', 'orders' as const, orderCases],
    ['spec 1.3 calculations (small fixture)', 'small' as const, calcCases],
  ])('%s', (_label, key, cases) => {
    it.each(cases)('%s', async (_name, query) => {
      const { expected, actual } = await both(sides[key], query);
      expect(actual).toEqual(expected);
    });
  });

  it('the reference cases are not vacuous', async () => {
    const { expected } = await both(sides.orders, orderCases[0]![1]);
    expect(expected.rows.length).toBe(25); // Nov 2024 … Nov 2026
    expect(expected.columns[0]).toEqual({ name: 'order_date', type: 'time', grain: 'month' });
  });

  it('raises the same error codes for bad fields and grains', async () => {
    const codeOf = async (side: Side, input: Omit<QueryInput, 'source'>) => {
      let reference: string | undefined;
      try {
        side.reference({ source: 's', ...input });
      } catch (e) {
        reference = (e as EngineError).code;
      }
      const engine = await side.engine
        .execute(side.source, QuerySchema.parse({ source: 's', ...input }), { teamId: 't', signal: new AbortController().signal })
        .then(() => undefined, (e: EngineError) => e.code);
      return { reference, engine };
    };
    expect(await codeOf(sides.small, { measures: [{ field: 'profit', agg: 'sum' }] })).toEqual({ reference: 'unknown_field', engine: 'unknown_field' });
    expect(await codeOf(sides.small, { dimensions: [{ field: 'region', grain: 'month' }] })).toEqual({ reference: 'invalid_grain', engine: 'invalid_grain' });
    expect(await codeOf(sides.small, { dimensions: [{ field: 'region' }], orderBy: [{ field: 'nope', dir: 'asc' }] })).toEqual({ reference: 'unknown_field', engine: 'unknown_field' });
  });
});
