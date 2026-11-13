import { describe, expect, it } from 'vitest';
import { applyParams, coerceParamValue, drillQuery, requiredSpecVersion, runtimeFilters, validateDashboard, type Query } from '../src';

const base = (specVersion = '1.3', extra: Record<string, unknown> = {}, widgetExtra: Record<string, unknown> = {}) => ({
  specVersion,
  id: 'd',
  title: 'D',
  dataSources: { s: { type: 'sample', ref: 'orders' }, t: { type: 'sample', ref: 'other' } },
  queries: {
    q: { source: 's', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
    q_t: { source: 's', dimensions: [{ field: 'order_date', grain: 'month' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
    q_other: { source: 't', dimensions: [{ field: 'team' }], measures: [{ field: '*', agg: 'count', as: 'n' }] },
  },
  widgets: { w: { type: 'bar-chart', query: 'q', encoding: { x: 'region', y: 'revenue' }, options: {}, ...widgetExtra } },
  layout: [{ i: 'w', x: 0, y: 0, w: 6, h: 4 }],
  ...extra,
});

const errs = (r: ReturnType<typeof validateDashboard>) => (r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`));

describe('spec 1.3 interactivity', () => {
  it('accepts interactions, tabs, mobile layout, drill and the new params', () => {
    const r = validateDashboard(
      base(
        '1.3',
        {
          interactions: { crossFilter: true },
          tabs: [{ id: 'overview', title: 'Overview' }, { id: 'detail', title: 'Detail' }],
          layout: [{ i: 'w', x: 0, y: 0, w: 6, h: 4, tab: 'detail' }],
          mobileLayout: [{ i: 'w', order: 0, h: 3 }],
          params: {
            m: { type: 'multiselect', field: 'region', optionsQuery: { query: 'q', field: 'region' }, bind: ['q_t.filters'] },
            r: { type: 'range', field: 'amount', default: [0, null], bind: ['q.filters'] },
            s: { type: 'search', field: 'region', bind: ['q.filters'] },
            k: { type: 'measure', as: 'revenue', options: [{ value: 'a', field: 'amount', agg: 'sum' }, { value: 'b', field: '*', agg: 'count' }], default: 'a', bind: ['q.measures'] },
          },
        },
        { drill: { levels: [{ field: 'region' }, { field: 'channel' }] }, drillThrough: { dashboardId: 'dash_detail', params: { region: 'region' } }, interactions: { crossFilter: false } },
      ),
    );
    expect(r.ok ? r.warnings : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(r.dashboard.tabs).toHaveLength(2);
    expect(r.dashboard.layout[0]).toMatchObject({ tab: 'detail' });
    expect(r.dashboard.widgets.w).toMatchObject({ drill: { levels: [{ field: 'region' }, { field: 'channel' }] }, interactions: { crossFilter: false } });
    expect(r.dashboard.params.k).toMatchObject({ type: 'measure', default: 'a' });
  });

  it('is version-gated: an error in documents that claim an older version', () => {
    const r = validateDashboard(base('1.2', { interactions: { crossFilter: true }, params: { m: { type: 'multiselect', field: 'region', bind: ['q.filters'] } } }, { drill: { levels: [{ field: 'region' }, { field: 'x' }] } }));
    expect(errs(r).sort()).toEqual(['interactions:field_too_new', 'params.m.type:field_too_new', 'widgets.w.drill:field_too_new']);
    expect(requiredSpecVersion({ w: { type: 'bar-chart', drill: {} } as { type: string } })).toBe('1.3');
    expect(requiredSpecVersion({}, { tabs: [] })).toBe('1.3');
    expect(requiredSpecVersion({}, { params: { m: { type: 'search' } } })).toBe('1.3');
  });

  it('reports bad references and inconsistent config', () => {
    const r = validateDashboard(
      base(
        '1.3',
        {
          tabs: [{ id: 'a', title: 'A' }, { id: 'a', title: 'Again' }],
          layout: [{ i: 'w', x: 0, y: 0, w: 6, h: 4, tab: 'nope' }],
          mobileLayout: [{ i: 'w_missing' }],
          params: {
            m: { type: 'multiselect', field: 'region', options: ['EU'], default: ['US'], bind: ['q.filters'] },
            o: { type: 'multiselect', field: 'region', optionsQuery: { query: 'q', field: 'nope' }, bind: ['q_t.filters'] },
            self: { type: 'multiselect', field: 'region', optionsQuery: { query: 'q', field: 'region' }, bind: ['q.filters'] },
            r: { type: 'range', field: 'amount', default: [10, 1], bind: ['q.filters'] },
            k: { type: 'measure', as: 'missing', options: [{ value: 'a', field: 'amount', agg: 'sum' }, { value: 'a', field: 'x', agg: 'median_of_doom' }], default: 'z', bind: ['q.measures'] },
          },
        },
        { drill: { levels: [{ field: 'channel' }, { field: 'region' }] } },
      ),
    );
    expect(errs(r)).toEqual(
      expect.arrayContaining([
        'tabs.1.id:duplicate_id',
        'layout.0.tab:unknown_reference',
        'mobileLayout.0.i:unknown_reference',
        'params.m.default.0:invalid_value',
        'params.o.optionsQuery.field:unknown_column',
        'params.self.optionsQuery.query:invalid_value',
        'params.r.default:invalid_value',
        'params.k.options.1.value:duplicate_value',
        'params.k.options.1.agg:invalid_value',
        'params.k.default:invalid_value',
        'params.k.bind.0:unknown_column',
        'widgets.w.drill.levels.0:invalid_value',
      ]),
    );
  });

  it('coerces only declared param values', () => {
    const k = { type: 'measure', as: 'revenue', options: [{ value: 'a', field: 'amount', agg: 'sum' }, { value: 'b', field: '*', agg: 'count' }], default: 'a', bind: ['q.measures'] } as never;
    expect(coerceParamValue(k, 'b')).toEqual({ ok: true, value: 'b' });
    expect(coerceParamValue(k, 'amount')).toMatchObject({ ok: false });
    const range = { type: 'range', field: 'd', kind: 'date', default: null, bind: ['q.filters'] } as never;
    expect(coerceParamValue(range, ['2026-01-01', null])).toEqual({ ok: true, value: ['2026-01-01', null] });
    expect(coerceParamValue(range, [1, 2])).toMatchObject({ ok: false });
    const multi = { type: 'multiselect', field: 'r', default: [], bind: ['q.filters'] } as never;
    expect(coerceParamValue(multi, ['a', 'a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(coerceParamValue(multi, 'a')).toMatchObject({ ok: false });
  });

  it('applyParams swaps the declared measure and adds multiselect/range filters', () => {
    const r = validateDashboard(
      base('1.3', {
        params: {
          k: { type: 'measure', as: 'revenue', options: [{ value: 'a', field: 'amount', agg: 'sum' }, { value: 'b', field: '*', agg: 'count' }], default: 'a', bind: ['q.measures'] },
          m: { type: 'multiselect', field: 'region', bind: ['q.filters'] },
          r: { type: 'range', field: 'amount', bind: ['q.filters'] },
        },
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const q = applyParams(r.dashboard, 'q', { k: 'b', m: ['EU', 'US'], r: [5, null] }, new Date());
    expect(q.measures).toEqual([{ field: '*', agg: 'count', as: 'revenue' }]);
    expect(q.filters).toEqual([
      { field: 'region', op: 'in', value: ['EU', 'US'] },
      { field: 'amount', op: 'gte', value: 5 },
    ]);
    expect(applyParams(r.dashboard, 'q', { k: 'a', m: [], r: null }, new Date()).filters).toEqual([]);
  });

  it('runtimeFilters and drillQuery only follow the declared surface', () => {
    const r = validateDashboard(base('1.3', { interactions: { crossFilter: true } }));
    if (!r.ok) throw new Error('invalid');
    expect(runtimeFilters(r.dashboard, 'q', [{ field: 'order_date', op: 'eq', grain: 'month', values: ['2026-03-01'] }])).toEqual({
      ok: true,
      filters: [
        { field: 'order_date', op: 'gte', value: '2026-03-01' },
        { field: 'order_date', op: 'lt', value: '2026-04-01' },
      ],
    });
    // "team" is a dimension, but of a query on another source.
    expect(runtimeFilters(r.dashboard, 'q', [{ field: 'team', op: 'in', values: ['x'] }])).toMatchObject({ ok: false });
    const q = r.dashboard.queries.q as Query;
    const drilled = drillQuery(q, { levels: [{ field: 'region' }, { field: 'channel' }, { field: 'category' }] }, 2, ['Europe', 'Online']);
    expect(drilled).toEqual({
      ok: true,
      query: {
        ...q,
        dimensions: [{ field: 'category', as: 'region' }],
        filters: [
          { field: 'region', op: 'eq', value: 'Europe' },
          { field: 'channel', op: 'eq', value: 'Online' },
        ],
      },
    });
    expect(drillQuery(q, { levels: [{ field: 'region' }, { field: 'channel' }] }, 1, [{ x: 1 }])).toMatchObject({ ok: false });
  });
});

describe('brushed time ranges (1.4, D-090)', () => {
  it('turn two bucket starts into an inclusive range filter, checked against the dashboard', async () => {
    const { runtimeFilters } = await import('../src');
    const dash = {
      interactions: { crossFilter: true },
      dataSources: { o: { type: 'sample', ref: 'orders' } },
      queries: { a: { source: 'o', dimensions: [{ field: 'order_date', grain: 'month' }], measures: [], filters: [], orderBy: [], limit: 10 }, b: { source: 'o', dimensions: [{ field: 'region' }], measures: [], filters: [], orderBy: [], limit: 10 } },
      widgets: {},
    } as never;
    expect(runtimeFilters(dash, 'b', [{ field: 'order_date', op: 'between', grain: 'month', values: ['2026-01-01', '2026-03-01'] }])).toEqual({
      ok: true,
      filters: [
        { field: 'order_date', op: 'gte', value: '2026-01-01' },
        { field: 'order_date', op: 'lt', value: '2026-04-01' },
      ],
    });
    expect(runtimeFilters(dash, 'b', [{ field: 'order_date', op: 'between', grain: 'month', values: ['2026-03-01', '2026-01-01'] }]).ok).toBe(false);
    expect(runtimeFilters(dash, 'b', [{ field: 'order_date', op: 'between', grain: 'week', values: ['2026-01-05', '2026-01-12'] }]).ok).toBe(false);
  });
});
