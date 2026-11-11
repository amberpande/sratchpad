import { describe, expect, it } from 'vitest';
import { requiredSpecVersion, validateDashboard, WIDGET_TYPES } from '../src';

/** A document with one source and the given queries/widgets, each widget placed in its own row. */
function doc(specVersion: string, queries: Record<string, unknown>, widgets: Record<string, unknown>) {
  return {
    specVersion,
    id: 'd',
    title: 'D',
    dataSources: { s: { type: 'sample', ref: 'orders' } },
    queries,
    widgets,
    layout: Object.keys(widgets).map((i, n) => ({ i, x: 0, y: n * 4, w: 12, h: 4 })),
  };
}

const q = (dimensions: string[], measures: Array<[string, string, string]>, extra: Record<string, unknown> = {}) => ({
  source: 's',
  dimensions: dimensions.map((field) => ({ field })),
  measures: measures.map(([field, agg, as]) => ({ field, agg, as })),
  ...extra,
});

const QUERIES = {
  q_region: q(['region'], [['amount', 'sum', 'revenue']]),
  q_rc: q(['region', 'category'], [['amount', 'sum', 'revenue']]),
  q_flow: q(['channel', 'region'], [['amount', 'sum', 'revenue']]),
  q_month: { ...q(['order_date'], [['amount', 'sum', 'revenue'], ['order_id', 'count', 'orders']]), dimensions: [{ field: 'order_date', grain: 'month' }] },
  q_stats: q(['category'], [['amount', 'min', 'lo'], ['amount', 'avg', 'mid'], ['amount', 'max', 'hi']]),
  q_total: q([], [['amount', 'avg', 'aov'], ['amount', 'max', 'top']]),
  q_status: q(['status'], [['order_id', 'count', 'orders']]),
};

const WIDGETS: Record<string, unknown> = {
  w_map: { type: 'map', query: 'q_region', encoding: { region: 'region', value: 'revenue' }, options: { basemap: 'world', colors: { from: '#eeeeee', to: '#1f5fb8' } } },
  w_heat: { type: 'heatmap', query: 'q_rc', encoding: { x: 'category', y: 'region', value: 'revenue' }, options: { showValues: true } },
  w_tree: { type: 'treemap', query: 'q_rc', encoding: { category: 'category', group: 'region', value: 'revenue' }, options: {} },
  w_box: { type: 'boxplot', query: 'q_stats', encoding: { category: 'category', min: 'lo', q1: 'lo', median: 'mid', q3: 'hi', max: 'hi' }, options: {} },
  w_fall: { type: 'waterfall', query: 'q_region', encoding: { category: 'region', value: 'revenue' }, options: { colors: { decrease: '#cc0000' } } },
  w_funnel: { type: 'funnel', query: 'q_status', encoding: { stage: 'status', value: 'orders' }, options: {} },
  w_gauge: { type: 'gauge', query: 'q_total', options: { field: 'aov', maxField: 'top', target: 2000, bands: [{ to: 1000, color: '#e34948' }, { to: 3000, color: '#1baf7a' }] } },
  w_bullet: { type: 'bullet', query: 'q_region', encoding: { category: 'region', value: 'revenue' }, options: { ranges: [100, 200, 300] } },
  w_sankey: { type: 'sankey', query: 'q_flow', encoding: { source: 'channel', target: 'region', value: 'revenue' }, options: {} },
  w_combo: { type: 'combo', query: 'q_month', encoding: { x: 'order_date', bars: 'revenue', lines: ['orders'] }, options: { y2Label: 'Orders', referenceLines: [{ value: 500000, label: 'Goal' }] } },
  w_img: { type: 'image', options: { src: 'https://example.com/logo.png', alt: 'Company logo', href: 'https://example.com' } },
};

describe('spec 1.3 visuals', () => {
  it('accepts every new type in a 1.3 document, with defaults applied', () => {
    const r = validateDashboard(doc('1.3', QUERIES, WIDGETS));
    expect(r.ok ? r.warnings.filter((w) => w.code !== 'unplaced_widget') : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(r.dashboard.widgets.w_map).toMatchObject({ options: { kind: 'choropleth' } });
    expect(r.dashboard.widgets.w_tree).toMatchObject({ options: { maxNodes: 60 } });
    expect(r.dashboard.widgets.w_fall).toMatchObject({ options: { showTotal: true, totalLabel: 'Total' } });
    expect(r.dashboard.widgets.w_combo).toMatchObject({ options: { secondaryAxis: true, stacked: false } });
    expect(r.dashboard.widgets.w_img).toMatchObject({ type: 'image', options: { fit: 'contain' } });
  });

  it('is version-gated: a 1.2 document cannot use them; a 1.2 reader shows placeholders', () => {
    const r = validateDashboard(doc('1.2', QUERIES, { w_heat: WIDGETS.w_heat }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ path: 'widgets.w_heat.type', code: 'widget_type_too_new' });
    const old = validateDashboard(doc('1.3', QUERIES, { w_heat: WIDGETS.w_heat }), { supported: { major: 1, minor: 2 } });
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.dashboard.widgets.w_heat).toMatchObject({ type: '__unsupported__', originalType: 'heatmap' });
    for (const t of ['map', 'heatmap', 'treemap', 'boxplot', 'waterfall', 'funnel', 'gauge', 'bullet', 'sankey', 'combo', 'image'] as const) {
      expect(WIDGET_TYPES[t].since).toBe('1.3');
    }
  });

  it('checks roles and query shapes', () => {
    const codes = (widgets: Record<string, unknown>) => {
      const r = validateDashboard(doc('1.3', QUERIES, widgets));
      return r.ok ? [] : r.errors.map((e) => `${e.path}:${e.code}`);
    };
    expect(codes({ w: { type: 'heatmap', query: 'q_rc', encoding: { x: 'category', y: 'revenue', value: 'revenue' }, options: {} } })).toContain('widgets.w.encoding.y:invalid_role');
    expect(codes({ w: { type: 'treemap', query: 'q_stats', encoding: { category: 'category', value: 'mid' }, options: {} } })).toContain('widgets.w.encoding.value:not_part_to_whole');
    expect(codes({ w: { type: 'sankey', query: 'q_rc', encoding: { source: 'region', target: 'region', value: 'revenue' }, options: {} } })).toContain('widgets.w.encoding.target:invalid_value');
    expect(codes({ w: { type: 'waterfall', query: 'q_rc', encoding: { category: 'region', value: 'revenue' }, options: {} } })).toContain('widgets.w.query:invalid_query_shape');
    expect(codes({ w: { type: 'gauge', query: 'q_total', options: { field: 'aov' } } })).toContain('widgets.w.options.max:missing_field');
    expect(codes({ w: { type: 'map', query: 'q_region', encoding: { region: 'region' }, options: {} } })).toContain('widgets.w.encoding:missing_field');
    expect(codes({ w: { type: 'map', query: 'q_region', encoding: { region: 'region', value: 'revenue' }, options: { kind: 'symbol' } } })).toContain('widgets.w.encoding:missing_field');
    expect(codes({ w: { type: 'combo', query: 'q_month', encoding: { x: 'order_date', bars: 'order_date', lines: 'orders' }, options: {} } })).toContain('widgets.w.encoding.bars:invalid_role');
  });

  it('only accepts https images and hex colors', () => {
    for (const src of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//example.com/a.png']) {
      const r = validateDashboard(doc('1.3', {}, { w: { type: 'image', options: { src, alt: 'x' } } }));
      expect(r.ok, src).toBe(false);
    }
    expect(validateDashboard(doc('1.3', {}, { w: { type: 'image', options: { src: 'https://x.test/a.png', alt: '' } } })).ok).toBe(false);
    const bad = validateDashboard(doc('1.3', QUERIES, { w: { ...(WIDGETS.w_map as object), options: { colors: { from: 'red', to: '#000' } } } }));
    expect(bad.ok).toBe(false);
  });
});

describe('spec 1.3 formatting on existing types', () => {
  const line = (options: Record<string, unknown>, encoding: Record<string, unknown> = {}) => ({
    w: { type: 'line-chart', query: 'q_month', encoding: { x: 'order_date', y: 'revenue', ...encoding }, options },
  });

  it('accepts references, tooltips, number formats and facets on cartesian charts', () => {
    const r = validateDashboard(
      doc(
        '1.3',
        { ...QUERIES, q_mr: { ...q(['region'], [['amount', 'sum', 'revenue']]), dimensions: [{ field: 'order_date', grain: 'month' }, { field: 'region' }] } },
        {
          w: {
            type: 'line-chart',
            query: 'q_mr',
            encoding: { x: 'order_date', y: 'revenue', facet: 'region' },
            options: {
              referenceLines: [{ value: 100, label: 'Target', color: '#cc0000' }, { axis: 'x', value: '2026-01-01' }],
              referenceBands: [{ from: 0, to: 50, label: 'Low' }],
              annotations: [{ x: '2026-03-01', text: 'Launch' }],
              tooltip: { fields: ['region'] },
              numberFormats: { revenue: { prefix: '$', scale: 'auto', decimals: 1 } },
            },
          },
        },
      ),
    );
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('gates every new option and checks the columns they name', () => {
    const old = validateDashboard(doc('1.2', QUERIES, line({ numberFormats: { revenue: { decimals: 0 } } })));
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.errors[0]).toMatchObject({ path: 'widgets.w.options.numberFormats', code: 'field_too_new' });
    const missing = validateDashboard(doc('1.3', QUERIES, line({ tooltip: { fields: ['nope'] }, referenceLines: [{ field: 'nope2' }] })));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.map((e) => e.path).sort()).toEqual(['widgets.w.options.referenceLines.0.field', 'widgets.w.options.tooltip.fields.0']);
    const ref = validateDashboard(doc('1.3', QUERIES, line({ referenceLines: [{ value: 1, field: 'revenue' }] })));
    expect(ref.ok).toBe(false);
    const facet = validateDashboard(doc('1.3', QUERIES, line({}, { facet: 'revenue' })));
    expect(facet.ok).toBe(false);
  });

  it('validates KPI thresholds/comparison and table conditional formats/sparklines', () => {
    const r = validateDashboard(
      doc('1.3', QUERIES, {
        k: {
          type: 'kpi',
          query: 'q_month',
          options: {
            field: 'revenue',
            thresholds: [{ op: 'lt', value: 1000, color: '#cc0000' }, { op: 'between', value: [1000, 5000], background: '#fff3c4' }],
            comparison: { field: 'orders', positiveIs: 'up' },
          },
        },
        t: {
          type: 'table',
          query: 'q_rc',
          options: {
            conditionalFormats: [{ field: 'revenue', scale: { from: '#ffffff', to: '#1f5fb8' } }, { field: 'region', rules: [{ op: 'eq', value: 1, color: '#000000' }] }],
            sparkline: { by: 'category', value: 'revenue' },
            sortable: false,
          },
        },
      }),
    );
    expect(r.ok ? [] : r.errors).toEqual([]);
    const bad = validateDashboard(
      doc('1.3', QUERIES, {
        k: { type: 'kpi', query: 'q_month', options: { field: 'revenue', thresholds: [{ op: 'between', value: 5, color: '#000000' }, { op: 'gt', value: 1 }] } },
        t: { type: 'table', query: 'q_rc', options: { conditionalFormats: [{ field: 'revenue' }] } },
      }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('requiredSpecVersion raises to 1.3 for new types and options only', () => {
    expect(requiredSpecVersion({ w: { type: 'line-chart', encoding: { x: 'a', y: 'b' }, options: {} } })).toBe('1.0');
    expect(requiredSpecVersion({ w: { type: 'line-chart', encoding: { x: 'a', y: 'b' }, options: { tooltip: { fields: ['c'] } } } })).toBe('1.3');
    expect(requiredSpecVersion({ w: { type: 'line-chart', encoding: { x: 'a', y: 'b', facet: 'c' }, options: {} } })).toBe('1.3');
    expect(requiredSpecVersion({ w: { type: 'sankey', encoding: {}, options: {} } })).toBe('1.3');
    expect(requiredSpecVersion({ w: { type: 'kpi', options: { field: 'x', numberFormats: {} } } })).toBe('1.3');
  });
});
