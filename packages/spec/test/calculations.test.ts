import { describe, expect, it } from 'vitest';
import { evaluateCalc, formatCalcExpr, outputColumns, parseCalcExpr, QuerySchema, queryExtensionSince, requiredSpecVersion, validateDashboard } from '../src';

const doc = (specVersion: string, query: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  specVersion,
  id: 'd',
  title: 'D',
  dataSources: { s: { type: 'sample', ref: 'orders' }, t: { type: 'sample', ref: 'targets' } },
  queries: { q: { source: 's', ...query } },
  widgets: { w: { type: 'table', query: 'q', options: {} } },
  layout: [{ i: 'w', x: 0, y: 0, w: 12, h: 4 }],
  ...extra,
});
const errors = (d: unknown) => {
  const r = validateDashboard(d, { allowNewerMinor: false });
  return r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`);
};

const rich = {
  dimensions: [{ field: 'order_date', grain: 'month', as: 'month' }, { field: 'region' }],
  measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }, { field: 'amount', agg: 'median' }, { field: '*', agg: 'count', as: 'n' }],
  calcs: [{ as: 'ticket', expr: 'revenue / n' }, { as: 'ticket2', expr: 'round(ticket * 2, 1)' }],
  windows: [
    { as: 'running', type: 'running_total', measure: 'revenue', order: 'month', partition: ['region'] },
    { as: 'share', type: 'percent_of_total', measure: 'ticket' },
    { as: 'rk', type: 'rank', measure: 'revenue', dense: true },
  ],
  topN: { dimension: 'region', n: 5, by: 'revenue' },
  joins: [{ source: 't', on: [{ left: 'region', right: 'region' }] }],
  metrics: [{ metric: 'margin' }],
  filters: [{ field: 'region', op: 'contains', value: 'eu' }],
  orderBy: [{ field: 'share', dir: 'desc' }],
};

describe('spec 1.3 query features', () => {
  it('accepts a 1.3 query using every feature, and outputColumns names every output', () => {
    expect(errors(doc('1.3', rich))).toEqual([]);
    const q = QuerySchema.parse({ source: 's', ...rich });
    expect(q.joins![0]!.type).toBe('left');
    expect(outputColumns(q).map((c) => `${c.name}:${c.role}${c.derived ? `:${c.derived}` : ''}`)).toEqual([
      'month:dimension',
      'region:dimension',
      'revenue:measure',
      'median_amount:measure',
      'n:measure',
      'margin:measure:metric',
      'ticket:measure:calc',
      'ticket2:measure:calc',
      'running:measure:window',
      'share:measure:window',
      'rk:measure:window',
    ]);
  });

  it('is an error in documents claiming an older version, and requiredSpecVersion knows', () => {
    const e = errors(doc('1.2', { dimensions: [{ field: 'amount', bin: { width: 10 } }], measures: [{ field: 'amount', agg: 'p90' }], filters: [{ field: 'region', op: 'starts_with', value: 'E' }], calcs: [{ as: 'x', expr: 'p90_amount * 2' }] }));
    expect(e).toEqual(
      expect.arrayContaining(['queries.q.measures.0.agg:field_too_new', 'queries.q.filters.0.op:field_too_new', 'queries.q.dimensions.0.bin:field_too_new', 'queries.q.calcs:field_too_new']),
    );
    expect(queryExtensionSince({ measures: [{ field: 'a', agg: 'sum' }] })).toBeUndefined();
    expect(queryExtensionSince({ dimensions: [{ field: 'a', buckets: { rules: [] } }] })).toBe('1.3');
    expect(requiredSpecVersion({}, { queries: { q: { calcs: [] } } })).toBe('1.3');
  });

  it('checks references, window ordering, top-N and joins', () => {
    expect(errors(doc('1.3', { dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count', as: 'n' }], calcs: [{ as: 'x', expr: 'amount / n' }] }))).toEqual(['queries.q.calcs.0.expr:unknown_column']);
    expect(errors(doc('1.3', { measures: [{ field: '*', agg: 'count', as: 'n' }], calcs: [{ as: 'x', expr: 'n +' }] }))).toEqual(['queries.q.calcs.0.expr:invalid_expression']);
    expect(errors(doc('1.3', { dimensions: [{ field: 'a' }, { field: 'b' }], measures: [{ field: '*', agg: 'count', as: 'n' }], windows: [{ as: 'r', type: 'running_total', measure: 'n', order: 'a' }] }))).toEqual(['queries.q.windows.0.partition:ambiguous_window_order']);
    expect(errors(doc('1.3', { dimensions: [{ field: 'a' }], measures: [{ field: '*', agg: 'count', as: 'n' }], windows: [{ as: 'r', type: 'moving_average', measure: 'n' }] }))).toEqual(['queries.q.windows.0.order:missing_order']);
    expect(errors(doc('1.3', { dimensions: [{ field: 'a' }], measures: [{ field: '*', agg: 'count', as: 'n' }], windows: [{ as: 'r', type: 'rank', measure: 'nope', window: 3 }] }))).toEqual(['queries.q.windows.0.measure:unknown_column', 'queries.q.windows.0.window:invalid_value']);
    expect(errors(doc('1.3', { dimensions: [{ field: 'a', bin: { width: 1 } }], measures: [{ field: '*', agg: 'count', as: 'n' }], topN: { dimension: 'a', n: 3, by: 'm' } }))).toEqual(['queries.q.topN.dimension:invalid_value', 'queries.q.topN.by:unknown_column']);
    expect(errors(doc('1.3', { measures: [{ field: '*', agg: 'count' }], joins: [{ source: 'zz', on: [{ left: 'a', right: 'b' }] }, { source: 's', on: [{ left: 'a', right: 'b' }] }] }))).toEqual(['queries.q.joins.0.source:unknown_reference', 'queries.q.joins.1.source:invalid_value']);
    expect(errors(doc('1.3', { dimensions: [{ field: 'd', grain: 'month', bin: { width: 1 } }], measures: [{ field: '*', agg: 'count' }] }))).toEqual(['queries.q.dimensions.0:invalid_value']);
    // Duplicate output names (a calc named like a measure) are caught by the generic check.
    expect(errors(doc('1.3', { measures: [{ field: '*', agg: 'count', as: 'n' }], calcs: [{ as: 'n', expr: 'n + 1' }] }))).toEqual(['queries.q:duplicate_column']);
    // Widgets may use calc/window outputs.
    expect(errors(doc('1.3', { dimensions: [{ field: 'm' }], measures: [{ field: '*', agg: 'count', as: 'n' }], calcs: [{ as: 'x', expr: 'n * 2' }] }, { widgets: { w: { type: 'bar-chart', query: 'q', encoding: { x: 'm', y: 'x' }, options: {} } } }))).toEqual([]);
  });

  it('validates bucket rules and search values', () => {
    expect(errors(doc('1.3', { dimensions: [{ field: 'r', buckets: { rules: [{ op: 'in', value: 'EU', label: 'E' }] } }], measures: [{ field: '*', agg: 'count' }] }))).toEqual(['queries.q.dimensions.0.buckets.rules.0.value:invalid_value']);
    expect(errors(doc('1.3', { measures: [{ field: '*', agg: 'count' }], filters: [{ field: 'r', op: 'contains', value: 3 }] }))).toEqual(['queries.q.filters.0.value:invalid_value']);
  });
});

describe('calc expressions', () => {
  it('parses precedence, functions, quoted names and aggregates, and round-trips', () => {
    const r = parseCalcExpr('-a + b * 2 / "weird name" - round(sum("order amount"), 2) + count(*) + least(1, 2)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const again = parseCalcExpr(formatCalcExpr(r.node));
    expect(again).toEqual(r);
  });

  it('rejects bad input with a position', () => {
    for (const [text, msg] of [
      ['', /empty/],
      ['a +', /ends too early/],
      ['foo(1)', /Unknown function/],
      ['sum(*)', /only works with count/],
      ['round(a, b)', /digits/],
      ['nullif(a)', /takes 2/],
      ['a $ b', /Unexpected "\$" at position 3/],
      ['(a', /Expected "\)"/],
      ['"unclosed', /Unclosed/],
      ['x'.repeat(2001), /limited/],
    ] as const) {
      const p = parseCalcExpr(text);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.message).toMatch(msg);
    }
    expect(parseCalcExpr('('.repeat(40) + 'a' + ')'.repeat(40)).ok).toBe(false);
  });

  it('evaluates with SQL NULL semantics', () => {
    const ev = (text: string, vals: Record<string, number | null> = {}) => {
      const p = parseCalcExpr(text);
      if (!p.ok) throw new Error(p.message);
      return evaluateCalc(p.node, { ref: (n) => vals[n] ?? null, agg: () => 10 });
    };
    expect(ev('a / b', { a: 1, b: 0 })).toBeNull();
    expect(ev('a + b', { a: 1, b: null })).toBeNull();
    expect(ev('coalesce(b, a, 3)', { a: 2, b: null })).toBe(2);
    expect(ev('nullif(a, 2)', { a: 2 })).toBeNull();
    expect(ev('least(a, b)', { a: 1, b: null })).toBeNull();
    expect(ev('greatest(a, 5)', { a: 1 })).toBe(5);
    expect(ev('round(a, 1)', { a: -2.25 })).toBe(-2.3);
    expect(ev('round(a)', { a: 2.5 })).toBe(3);
    expect(ev('sum(x) * 2')).toBe(20);
  });
});
