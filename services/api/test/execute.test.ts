import { QuerySchema, type QueryInput } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/data/engine';
import { bucketTime, runInMemoryQuery, type Row } from '../src/data/sample/execute';
import { generateOrders } from '../src/data/sample/orders';

const rows: Row[] = [
  { d: '2026-01-05', region: 'EU', amount: 100, status: 'paid', customer: 'a' },
  { d: '2026-01-20', region: 'EU', amount: 50, status: 'paid', customer: 'b' },
  { d: '2026-02-03', region: 'NA', amount: 200, status: 'paid', customer: 'a' },
  { d: '2026-02-04', region: 'NA', amount: 999, status: 'refunded', customer: 'c' },
  { d: '2026-03-15', region: null, amount: null, status: 'paid', customer: 'd' },
];
const fields = new Set(['d', 'region', 'amount', 'status', 'customer']);
const run = (q: QueryInput) => runInMemoryQuery(rows, fields, QuerySchema.parse(q));

describe('runInMemoryQuery', () => {
  it('groups by a time grain and aggregates with SQL null semantics', () => {
    const result = run({
      source: 's',
      dimensions: [{ field: 'd', grain: 'month' }],
      measures: [
        { field: 'amount', agg: 'sum', as: 'revenue' },
        { field: '*', agg: 'count' },
        { field: 'amount', agg: 'count', as: 'priced' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'paid' }],
    });
    expect(result.columns).toEqual([
      { name: 'd', type: 'time', grain: 'month' },
      { name: 'revenue', type: 'number' },
      { name: 'count', type: 'number' },
      { name: 'priced', type: 'number' },
    ]);
    expect(result.rows).toEqual([
      { d: '2026-01-01', revenue: 150, count: 2, priced: 2 },
      { d: '2026-02-01', revenue: 200, count: 1, priced: 1 },
      { d: '2026-03-01', revenue: null, count: 1, priced: 0 },
    ]);
  });

  it('orders by measures, puts NULL groups last, and reports truncation', () => {
    const result = run({
      source: 's',
      dimensions: [{ field: 'region' }],
      measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
      orderBy: [{ field: 'revenue', dir: 'desc' }],
      limit: 2,
    });
    expect(result.rows).toEqual([
      { region: 'NA', revenue: 1199 },
      { region: 'EU', revenue: 150 },
    ]);
    expect(result.truncated).toBe(true);
  });

  it('supports the filter operators', () => {
    const count = (filters: QueryInput['filters']) =>
      run({ source: 's', measures: [{ field: '*', agg: 'count' }], filters }).rows[0]!.count;
    expect(count([{ field: 'amount', op: 'gte', value: 100 }])).toBe(3);
    expect(count([{ field: 'region', op: 'in', value: ['EU', 'NA'] }])).toBe(4);
    expect(count([{ field: 'region', op: 'not_in', value: ['EU'] }])).toBe(2); // NULL region is excluded, as in SQL
    expect(count([{ field: 'region', op: 'is_null' }])).toBe(1);
    expect(count([{ field: 'd', op: 'between', value: ['2026-01-10', '2026-02-03'] }])).toBe(2);
    expect(count([{ field: 'region', op: 'neq', value: 'EU' }])).toBe(2);
  });

  it('returns one row for an ungrouped aggregate over no matches', () => {
    const result = run({
      source: 's',
      measures: [
        { field: 'amount', agg: 'sum' },
        { field: 'customer', agg: 'count_distinct' },
      ],
      filters: [{ field: 'status', op: 'eq', value: 'nope' }],
    });
    expect(result.rows).toEqual([{ sum_amount: null, count_distinct_customer: 0 }]);
  });

  it('names unknown fields in a helpful error', () => {
    expect(() => run({ source: 's', measures: [{ field: 'profit', agg: 'sum' }] })).toThrow(EngineError);
    expect(() => run({ source: 's', measures: [{ field: 'profit', agg: 'sum' }] })).toThrow(/Available fields: d, region/);
  });

  it('buckets weeks to ISO Mondays, quarters and years', () => {
    expect(bucketTime('2026-11-08', 'week', 'd')).toBe('2026-11-02'); // Sunday → previous Monday
    expect(bucketTime('2026-11-09', 'week', 'd')).toBe('2026-11-09');
    expect(bucketTime('2026-08-19', 'quarter', 'd')).toBe('2026-07-01');
    expect(bucketTime('2026-08-19T10:00:00Z', 'year', 'd')).toBe('2026-01-01');
    expect(() => bucketTime('EU', 'month', 'region')).toThrow(/not a date column/);
  });
});

describe('generateOrders', () => {
  it('is deterministic for a given day and ends today', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const a = generateOrders(now);
    const b = generateOrders(now);
    expect(a.rows).toEqual(b.rows);
    expect(a.rows.length).toBeGreaterThan(4000);
    expect(a.rows[a.rows.length - 1]!.order_date).toBe('2026-11-09');
    expect(a.rows[0]!.order_date).toBe('2024-11-01');
  });
});
