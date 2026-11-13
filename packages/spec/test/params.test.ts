import { describe, expect, it } from 'vitest';
import {
  applyParams,
  checkCompatibility,
  effectiveParamValues,
  outputColumns,
  paramsForQuery,
  resolveDateRange,
  stableStringify,
  validateDashboard,
  type ValidDashboard,
} from '../src';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import docExample from './fixtures/doc-example.json';

function valid(doc: unknown): ValidDashboard {
  const result = validateDashboard(doc);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.dashboard;
}

const NOW = new Date('2026-11-09T15:30:00Z');

describe('resolveDateRange', () => {
  it('resolves presets to inclusive-from, exclusive-to UTC days', () => {
    expect(resolveDateRange('last_7d', NOW)).toEqual({ from: '2026-11-03', toExclusive: '2026-11-10' });
    expect(resolveDateRange('last_90d', NOW)).toEqual({ from: '2026-08-12', toExclusive: '2026-11-10' });
    expect(resolveDateRange('mtd', NOW)).toEqual({ from: '2026-11-01', toExclusive: '2026-11-10' });
    expect(resolveDateRange('qtd', NOW)).toEqual({ from: '2026-10-01', toExclusive: '2026-11-10' });
    expect(resolveDateRange('ytd', NOW)).toEqual({ from: '2026-01-01', toExclusive: '2026-11-10' });
    expect(resolveDateRange('all', NOW)).toBeNull();
    expect(resolveDateRange({ from: '2026-01-01', to: '2026-03-31' }, NOW)).toEqual({ from: '2026-01-01', toExclusive: '2026-04-01' });
  });
});

describe('params', () => {
  it('appends bound param filters, inferring the date field from the time dimension', () => {
    const dash = valid(docExample);
    const q = applyParams(dash, 'q_rev_by_month', effectiveParamValues(dash, { dateRange: 'last_30d' }), NOW);
    expect(q.filters).toEqual([
      { field: 'status', op: 'eq', value: 'paid' },
      { field: 'order_date', op: 'gte', value: '2026-10-11' },
      { field: 'order_date', op: 'lt', value: '2026-11-10' },
    ]);
  });

  it('adds no filter for "all"', () => {
    const dash = valid(docExample);
    const q = applyParams(dash, 'q_rev_by_month', { dateRange: 'all' }, NOW);
    expect(q.filters).toHaveLength(1);
  });

  it('falls back to the default for invalid values and reports them', () => {
    const dash = valid(docExample);
    const reported: string[] = [];
    const values = effectiveParamValues(dash, { dateRange: 'last_2y', unknownParam: 1 }, (name) => reported.push(name));
    expect(values).toEqual({ dateRange: 'last_90d' });
    expect(reported).toEqual(['dateRange']);
  });

  it('scopes cache-relevant params to the queries they bind', () => {
    const doc = structuredClone(salesOverview) as any;
    doc.params.region = { type: 'select', field: 'region', bind: ['q_rev_by_region.filters'] };
    const dash = valid(doc);
    const values = effectiveParamValues(dash, { region: 'Europe' });
    expect(paramsForQuery(dash, 'q_rev_by_region', values)).toEqual({ dateRange: 'last_365d', region: 'Europe' });
    expect(paramsForQuery(dash, 'q_by_category', values)).toEqual({ dateRange: 'last_365d' });
    expect(applyParams(dash, 'q_rev_by_region', values, NOW).filters).toContainEqual({ field: 'region', op: 'eq', value: 'Europe' });
  });
});

describe('outputColumns', () => {
  it('names measures by alias, or agg_field', () => {
    expect(
      outputColumns({
        dimensions: [{ field: 'order_date', grain: 'month' }],
        measures: [
          { field: 'amount', agg: 'sum', as: 'revenue' },
          { field: 'amount', agg: 'avg' },
          { field: '*', agg: 'count' },
        ],
      }).map((c) => c.name),
    ).toEqual(['order_date', 'revenue', 'avg_amount', 'count']);
  });
});

describe('checkCompatibility', () => {
  it('classifies versions against the supported range', () => {
    expect(checkCompatibility('1.0').level).toBe('full');
    expect(checkCompatibility('1.5').level).toBe('degraded');
    expect(checkCompatibility('2.0').level).toBe('unsupported');
    expect(checkCompatibility('0.9').level).toBe('unsupported');
    expect(checkCompatibility('v1').level).toBe('unsupported');
  });
});

describe('stableStringify', () => {
  it('is independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(stableStringify({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });
});
