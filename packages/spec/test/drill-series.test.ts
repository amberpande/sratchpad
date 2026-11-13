import { describe, expect, it } from 'vitest';
import { drillQuery, QuerySchema, validateDashboard } from '../src';

// Drill on the series dimension (1.4, D-088).
const q = QuerySchema.parse({ source: 's', dimensions: [{ field: 'order_date', grain: 'month' }, { field: 'channel' }], measures: [{ field: 'amount', agg: 'sum' }] });
const drill = { dimension: 1, levels: [{ field: 'channel' }, { field: 'category' }] };

describe('drill on a series', () => {
  it('replaces the series dimension, keeps its output name, filters by the clicked value', () => {
    const r = drillQuery(q, drill, 1, ['Online']);
    expect(r.ok && r.query.dimensions).toEqual([{ field: 'order_date', grain: 'month' }, { field: 'category', as: 'channel' }]);
    expect(r.ok && r.query.filters).toEqual([{ field: 'channel', op: 'eq', value: 'Online' }]);
  });

  it('validates the first level against the chosen dimension, and needs spec 1.4', () => {
    const doc = (d: unknown, v = '1.4') => ({
      specVersion: v,
      id: 'd',
      title: 'D',
      dataSources: { s: { type: 'sample', ref: 'orders' } },
      queries: { q: { source: 's', dimensions: [{ field: 'order_date', grain: 'month' }, { field: 'channel' }], measures: [{ field: 'amount', agg: 'sum' }] } },
      widgets: { w: { type: 'line-chart', query: 'q', encoding: { x: 'order_date', y: 'sum_amount', series: 'channel' }, drill: d } },
      layout: [{ i: 'w', x: 0, y: 0, w: 6, h: 4 }],
    });
    expect(validateDashboard(doc(drill)).ok).toBe(true);
    expect(validateDashboard(doc({ ...drill, levels: [{ field: 'region' }, { field: 'category' }] })).ok).toBe(false);
    expect(validateDashboard(doc(drill, '1.3')).ok).toBe(false);
  });
});
