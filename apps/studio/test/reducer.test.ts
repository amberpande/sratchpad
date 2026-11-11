import { validateDashboard, WIDGET_TYPES } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { collides } from '../src/draft/layout';
import { bindableQueries, bindTarget } from '../src/draft/params';
import { draftReducer } from '../src/draft/reducer';
import { add, apply, blank, expectIds, expectValid, field, fields } from './helpers';

describe('draft reducer', () => {
  it('adds each core widget type as a valid, placed widget with pattern-safe ids', () => {
    let draft = blank();
    for (const type of ['kpi', 'line-chart', 'bar-chart', 'table']) draft = add(draft, type).draft;
    expectValid(draft);
    expectIds(draft);
    expect(Object.keys(draft.widgets)).toEqual(['w_kpi', 'w_line-chart', 'w_bar-chart', 'w_table']);
    expect(draft.dataSources).toEqual({ orders: { type: 'sample', ref: 'orders' } });
    // Placed without overlaps, inside the 12-column grid.
    for (const a of draft.layout) {
      expect(a.x + a.w).toBeLessThanOrEqual(12);
      for (const b of draft.layout) if (a !== b) expect(collides(a, b)).toBe(false);
    }
    // Sensible starters: line over time, bar by a category, KPI of a measure.
    expect(draft.queries['q_line-chart']!.dimensions).toEqual([{ field: 'order_date', grain: 'month' }]);
    expect(draft.widgets['w_line-chart']!.encoding).toEqual({ x: 'order_date', y: 'sum_amount' });
    expect(draft.widgets['w_bar-chart']!.encoding).toEqual({ x: 'region', y: 'sum_amount' });
    expect(draft.widgets.w_kpi!.options).toMatchObject({ field: 'sum_amount' });
  });

  it('numbers repeated widgets and their queries', () => {
    let { draft } = add(blank(), 'kpi');
    draft = add(draft, 'kpi').draft;
    expect(Object.keys(draft.widgets)).toEqual(['w_kpi', 'w_kpi_2']);
    expect(draft.widgets.w_kpi_2!.query).toBe('q_kpi_2');
    expectValid(draft);
  });

  it('adds every registered widget type (including newer ones) with only options left to fill', () => {
    for (const type of Object.keys(WIDGET_TYPES)) {
      const { draft, id } = add(blank(), type);
      expect(draft.widgets[id]?.type).toBe(type);
      const result = validateDashboard(draft, { allowNewerMinor: false });
      const errors = result.ok ? [] : result.errors;
      expect(errors.filter((e) => !e.path.startsWith(`widgets.${id}.options`))).toEqual([]);
    }
  });

  it('moves and resizes through setLayout and stays valid', () => {
    let { draft, id } = add(blank(), 'line-chart');
    draft = apply(draft, { type: 'setLayout', layout: [{ i: id, x: 2, y: 3, w: 10, h: 6 }, { i: 'ghost', x: 0, y: 0, w: 1, h: 1 }] });
    expect(draft.layout).toEqual([{ i: id, x: 2, y: 3, w: 10, h: 6 }]);
    expectValid(draft);
  });

  it('dropping fields builds the query and keeps the encoding pointing at real columns', () => {
    let { draft, id } = add(blank(), 'line-chart');
    draft = apply(draft, { type: 'applyField', widgetId: id, field: field('quantity') });
    expect(draft.queries['q_line-chart']!.measures).toEqual([
      { field: 'amount', agg: 'sum' },
      { field: 'quantity', agg: 'sum' },
    ]);
    // A new measure becomes another series.
    expect(draft.widgets[id]!.encoding).toEqual({ x: 'order_date', y: ['sum_amount', 'sum_quantity'] });
    expectValid(draft);

    // Re-dropping a time field updates its grain instead of duplicating it.
    draft = apply(draft, { type: 'applyField', widgetId: id, field: field('order_date') });
    expect(draft.queries['q_line-chart']!.dimensions).toHaveLength(1);
    expectValid(draft);
  });

  it('removing a measure re-points the encoding and drops dangling sorts', () => {
    let { draft, id } = add(blank(), 'bar-chart');
    draft = apply(draft, { type: 'applyField', widgetId: id, field: field('quantity') });
    expect(draft.queries['q_bar-chart']!.orderBy).toEqual([{ field: 'sum_amount', dir: 'desc' }]);
    draft = apply(draft, { type: 'updateQuery', id: 'q_bar-chart', query: { source: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'quantity', agg: 'sum' }], orderBy: [{ field: 'sum_amount', dir: 'desc' }] } });
    expect(draft.widgets[id]!.encoding).toEqual({ x: 'region', y: 'sum_quantity' });
    expect(draft.queries['q_bar-chart']!.orderBy).toBeUndefined();
    expectValid(draft);
  });

  it('changing type keeps the query and re-derives the encoding', () => {
    let { draft, id } = add(blank(), 'line-chart');
    draft = apply(draft, { type: 'setWidgetType', id, widgetType: 'kpi' });
    expect(draft.widgets[id]).toMatchObject({ type: 'kpi', query: 'q_line-chart', options: { field: 'sum_amount' } });
    expect(draft.widgets[id]!.encoding).toBeUndefined();
    draft = apply(draft, { type: 'setWidgetType', id, widgetType: 'bar-chart' });
    expectValid(draft);
  });

  it('a field dropped on empty canvas seeds a new widget around it', () => {
    const { draft, id } = add(blank(), 'bar-chart', { seedField: field('channel'), at: { x: 4, y: 2 } });
    expect(draft.queries['q_bar-chart']!.dimensions).toEqual([{ field: 'channel' }]);
    expect(draft.layout).toEqual([{ i: id, x: 4, y: 2, w: 6, h: 4 }]);
    expectValid(draft);
    const kpi = add(blank(), 'kpi', { seedField: field('quantity') });
    expect(kpi.draft.queries.q_kpi!.measures).toEqual([{ field: 'quantity', agg: 'sum' }]);
    expectValid(kpi.draft);
  });

  it('a date-range param binds to queries that have a time field and new time queries join it', () => {
    let { draft } = add(blank(), 'line-chart');
    draft = add(draft, 'bar-chart').draft;
    const bySource = { orders: fields };
    expect(bindableQueries(draft, undefined, bySource)).toEqual(['q_line-chart']);
    expect(bindableQueries(draft, 'order_date', bySource)).toEqual(['q_line-chart', 'q_bar-chart']);
    draft = apply(draft, { type: 'setParam', id: 'dateRange', param: { type: 'daterange', default: 'last_90d', bind: bindableQueries(draft, undefined, bySource).map(bindTarget) } });
    expectValid(draft);
    draft = add(draft, 'line-chart').draft;
    expect(draft.params.dateRange!.bind).toEqual(['q_line-chart.filters', 'q_line-chart_2.filters']);
    expectValid(draft);
  });

  it('removing a widget drops its unused query and unbinds params', () => {
    let { draft, id } = add(blank(), 'line-chart');
    draft = apply(draft, { type: 'setParam', id: 'dateRange', param: { type: 'daterange', bind: ['q_line-chart.filters', 'q_line-chart.filters'] } });
    draft = apply(draft, { type: 'removeWidget', id });
    expect(draft.queries).toEqual({});
    expect(draft.layout).toEqual([]);
    expect(draft.params.dateRange!.bind).toEqual([]);
  });

  it('duplicates share the query; forking gives the copy its own', () => {
    let { draft, id } = add(blank(), 'kpi');
    draft = apply(draft, { type: 'duplicateWidget', id, newId: 'w_kpi_2' });
    expect(draft.widgets.w_kpi_2!.query).toBe('q_kpi');
    draft = apply(draft, { type: 'forkQuery', widgetId: 'w_kpi_2' });
    expect(draft.widgets.w_kpi_2!.query).toBe('q_kpi_2');
    expectValid(draft);
  });

  it('compacts the layout upward', () => {
    let { draft } = add(blank(), 'kpi');
    draft = apply(draft, { type: 'setLayout', layout: [{ i: 'w_kpi', x: 0, y: 7, w: 3, h: 2 }] }, { type: 'compactLayout' });
    expect(draft.layout[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('returns the same object for no-op actions (no history entry)', () => {
    const draft = blank();
    expect(draftReducer(draft, { type: 'removeWidget', id: 'nope' })).toBe(draft);
    expect(draftReducer(draft, { type: 'addWidget', widgetType: 'not-a-type', id: 'w_x' })).toBe(draft);
  });

  it('adds a recommendation candidate under a free query id', () => {
    let { draft } = add(blank(), 'kpi');
    draft = apply(draft, {
      type: 'addCandidate',
      id: 'w_rec',
      candidate: {
        id: 'c1',
        title: 'Orders by channel',
        rationale: 'Channel mix.',
        pattern: 'measure_by_dimension',
        score: 0.8,
        query: { source: 'orders', dimensions: [{ field: 'channel' }], measures: [{ field: '*', agg: 'count', as: 'orders' }] },
        widget: { type: 'bar-chart', query: 'q_kpi', encoding: { x: 'channel', y: 'orders' }, options: { title: 'Orders by channel', orientation: 'vertical', stacked: false } },
      },
    });
    expect(draft.widgets.w_rec!.query).toBe('q_kpi_2');
    expectValid(draft);
  });
});
