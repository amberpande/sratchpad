import { describe, expect, it } from 'vitest';
import {
  checkCompatibility,
  requiredSpecVersion,
  SPEC_VERSION,
  SUPPORTED_SPEC,
  validateDashboard,
  WIDGET_TYPES,
  type Issue,
} from '../src';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import opsMix from '../../../examples/dashboards/ops_mix.json';

const codes = (issues: Issue[]) => issues.map((i) => `${i.path}:${i.code}`);
const V1_0 = { major: 1, minor: 0 };

/** A 1.1 document exercising every new type and field. */
function doc11(): any {
  return {
    specVersion: '1.1',
    id: 'd11',
    title: 'Spec 1.1',
    dataSources: { orders: { type: 'sample', ref: 'orders' } },
    queries: {
      q_trend: {
        source: 'orders',
        dimensions: [{ field: 'order_date', grain: 'month' }, { field: 'channel' }],
        measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
      },
      q_share: { source: 'orders', dimensions: [{ field: 'category' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
      q_grid: {
        source: 'orders',
        dimensions: [{ field: 'region' }, { field: 'category' }],
        measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }],
      },
      q_points: {
        source: 'orders',
        dimensions: [{ field: 'region' }],
        measures: [
          { field: 'order_id', agg: 'count_distinct', as: 'orders' },
          { field: 'amount', agg: 'avg', as: 'aov' },
          { field: 'amount', agg: 'sum', as: 'revenue' },
        ],
      },
    },
    widgets: {
      w_area: { type: 'area-chart', query: 'q_trend', encoding: { x: 'order_date', y: 'revenue', series: 'channel' }, options: { stacked: true } },
      w_line: { type: 'line-chart', query: 'q_trend', encoding: { x: 'order_date', y: 'revenue', series: 'channel' }, options: {} },
      w_pie: { type: 'pie', query: 'q_share', encoding: { category: 'category', value: 'revenue' }, options: {} },
      w_pivot: { type: 'pivot', query: 'q_grid', encoding: { rows: 'region', columns: 'category', value: 'revenue' }, options: {} },
      w_scatter: { type: 'scatter', query: 'q_points', encoding: { x: 'orders', y: 'aov', size: 'revenue', label: 'region' }, options: {} },
      w_text: { type: 'text', options: { text: '**Hello**' } },
    },
    layout: [
      { i: 'w_area', x: 0, y: 0, w: 6, h: 4 },
      { i: 'w_line', x: 6, y: 0, w: 6, h: 4 },
      { i: 'w_pie', x: 0, y: 4, w: 4, h: 4 },
      { i: 'w_pivot', x: 4, y: 4, w: 4, h: 4 },
      { i: 'w_scatter', x: 8, y: 4, w: 4, h: 4 },
      { i: 'w_text', x: 0, y: 8, w: 12, h: 2 },
    ],
  };
}

describe('spec 1.1', () => {
  it('is fully supported by this build (which writes the newest minor)', () => {
    expect(SPEC_VERSION).toBe(`${SUPPORTED_SPEC.major}.${SUPPORTED_SPEC.minor}`);
    expect(SUPPORTED_SPEC.minor).toBeGreaterThanOrEqual(1);
    expect(checkCompatibility('1.0').level).toBe('full');
    expect(checkCompatibility('1.1')).toMatchObject({ level: 'full', supported: `1.0–${SPEC_VERSION}` });
    expect(checkCompatibility('1.99').level).toBe('degraded');
  });

  it('registers each new type with since 1.1', () => {
    for (const t of ['area-chart', 'scatter', 'pie', 'pivot', 'text'] as const) expect(WIDGET_TYPES[t].since).toBe('1.1');
    for (const t of ['kpi', 'line-chart', 'bar-chart', 'table'] as const) expect(WIDGET_TYPES[t].since).toBe('1.0');
    expect(WIDGET_TYPES['line-chart'].fieldsSince).toMatchObject({ 'encoding.series': '1.1' });
  });

  it('accepts a 1.1 document using every new type, with defaults applied', () => {
    const result = validateDashboard(doc11());
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
    if (!result.ok) return;
    expect(result.dashboard.widgets.w_text).toEqual({ type: 'text', options: { text: '**Hello**', align: 'left' } });
    expect(result.dashboard.widgets.w_pie).toMatchObject({ options: { maxSlices: 6, donut: true } });
    expect(result.dashboard.widgets.w_area).toMatchObject({ encoding: { series: 'channel' }, options: { stacked: true, curve: 'monotone' } });
  });

  it('still accepts every 1.0 document unchanged', () => {
    const result = validateDashboard(salesOverview);
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
    expect(requiredSpecVersion(salesOverview.widgets)).toBe('1.0');
  });

  it('accepts the ops_mix example (stored strictly, as the API seeds it)', () => {
    const result = validateDashboard(opsMix, { allowNewerMinor: false });
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
    expect(requiredSpecVersion(opsMix.widgets)).toBe('1.1');
  });

  it('rejects 1.1 types and fields in a document that claims 1.0', () => {
    const doc = doc11();
    doc.specVersion = '1.0';
    doc.widgets.w_table = { type: 'table', query: 'q_share', options: { pagination: 'scroll' } };
    doc.layout.push({ i: 'w_table', x: 0, y: 10, w: 12, h: 2 });
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors).sort()).toEqual([
      'widgets.w_area.type:widget_type_too_new',
      'widgets.w_line.encoding.series:field_too_new',
      'widgets.w_pie.type:widget_type_too_new',
      'widgets.w_pivot.type:widget_type_too_new',
      'widgets.w_scatter.type:widget_type_too_new',
      'widgets.w_table.options.pagination:field_too_new',
      'widgets.w_text.type:widget_type_too_new',
    ]);
  });

  it('degrades a 1.1 document for a 1.0 reader: new types become placeholders, new fields are dropped', () => {
    const result = validateDashboard(doc11(), { supported: V1_0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compatibility.level).toBe('degraded');
    for (const id of ['w_area', 'w_pie', 'w_pivot', 'w_scatter', 'w_text']) {
      expect(result.dashboard.widgets[id]?.type).toBe('__unsupported__');
    }
    expect(result.dashboard.widgets.w_area).toMatchObject({ originalType: 'area-chart', query: 'q_trend' });
    expect(result.dashboard.widgets.w_text).not.toHaveProperty('query');
    // the line chart still renders, as the single-series chart a 1.0 reader knows
    expect(result.dashboard.widgets.w_line).toEqual({
      type: 'line-chart',
      query: 'q_trend',
      encoding: { x: 'order_date', y: 'revenue' },
      options: { curve: 'monotone', showPoints: false },
    });
    expect(codes(result.warnings)).toEqual(expect.arrayContaining(['widgets.w_line.encoding.series:unknown_field', 'widgets.w_pie.type:unknown_widget_type']));
    // and a 1.0 store refuses it rather than saving what it cannot check
    expect(validateDashboard(doc11(), { supported: V1_0, allowNewerMinor: false }).ok).toBe(false);
  });

  it('text widgets need no query and reject one', () => {
    const doc = doc11();
    doc.widgets.w_text.query = 'q_share';
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors)).toEqual(['widgets.w_text.query:unexpected_query']);
    // other types still require one
    const doc2 = doc11();
    delete doc2.widgets.w_pie.query;
    const r2 = validateDashboard(doc2);
    expect(!r2.ok && codes(r2.errors)).toEqual(['widgets.w_pie.query:missing_query']);
  });

  it('series needs a single y column that exists', () => {
    const doc = doc11();
    doc.queries.q_trend.measures.push({ field: 'quantity', agg: 'sum', as: 'units' });
    doc.widgets.w_line.encoding.y = ['revenue', 'units'];
    doc.widgets.w_area.encoding.series = 'nope';
    const result = validateDashboard(doc);
    expect(!result.ok && codes(result.errors).sort()).toEqual(['widgets.w_area.encoding.series:unknown_column', 'widgets.w_line.encoding.series:invalid_value']);
  });

  it('pies are only for part-to-whole measures', () => {
    const doc = doc11();
    doc.queries.q_share.measures = [{ field: 'amount', agg: 'avg', as: 'revenue' }];
    const result = validateDashboard(doc);
    expect(!result.ok && codes(result.errors)).toEqual(['widgets.w_pie.encoding.value:not_part_to_whole']);
    const doc2 = doc11();
    doc2.widgets.w_pie.options.maxSlices = 9;
    const r2 = validateDashboard(doc2);
    expect(!r2.ok && codes(r2.errors)).toEqual(['widgets.w_pie.options.maxSlices:too_big']);
  });

  it('pivots only reshape: the query may group by nothing but rows and columns', () => {
    const doc = doc11();
    doc.queries.q_grid.dimensions.push({ field: 'channel' });
    const result = validateDashboard(doc);
    expect(!result.ok && codes(result.errors)).toEqual(['widgets.w_pivot.query:invalid_query_shape']);
    const doc2 = doc11();
    doc2.widgets.w_pivot.encoding.value = 'region';
    const r2 = validateDashboard(doc2);
    expect(!r2.ok && codes(r2.errors)).toEqual(['widgets.w_pivot.encoding.value:invalid_role']);
  });

  it('scatter axes are numeric measures', () => {
    const doc = doc11();
    doc.widgets.w_scatter.encoding.x = 'region';
    const result = validateDashboard(doc);
    expect(!result.ok && codes(result.errors)).toEqual(['widgets.w_scatter.encoding.x:invalid_role']);
  });

  it('computes the lowest specVersion a document needs', () => {
    const d = doc11();
    expect(requiredSpecVersion(d.widgets)).toBe('1.1');
    expect(requiredSpecVersion({ a: { type: 'line-chart', encoding: { x: 'a', y: 'b' } } })).toBe('1.0');
    expect(requiredSpecVersion({ a: { type: 'line-chart', encoding: { x: 'a', y: 'b', series: 'c' } } })).toBe('1.1');
  });
});
