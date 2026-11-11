import { describe, expect, it } from 'vitest';
import { validateDashboard, type Issue } from '../src';
import docExample from './fixtures/doc-example.json';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';

const clone = <T>(v: T): T => structuredClone(v);
const codes = (issues: Issue[]) => issues.map((i) => `${i.path}:${i.code}`);

describe('validateDashboard', () => {
  it('accepts the example from the design doc exactly as written', () => {
    const result = validateDashboard(docExample);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compatibility.level).toBe('full');
    expect(result.warnings).toEqual([]);
    // the doc's daterange param has no "field": it resolves to the query's time dimension
    expect(result.dashboard.params.dateRange).toMatchObject({ type: 'daterange', default: 'last_90d' });
    // defaults are applied
    expect(result.dashboard.widgets.w_line).toMatchObject({ type: 'line-chart', options: { curve: 'monotone', showPoints: false } });
  });

  it('accepts the Phase 1 example dashboard', () => {
    const result = validateDashboard(salesOverview);
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
  });

  it('reports broken references with precise paths', () => {
    const doc = clone(docExample) as any;
    doc.queries.q_rev_by_month.source = 'nope';
    doc.widgets.w_line.encoding.y = 'profit';
    doc.widgets.w_kpi.query = 'q_missing';
    doc.layout.push({ i: 'w_ghost', x: 0, y: 9, w: 2, h: 2 });
    doc.params.dateRange.bind = ['q_other.filters'];
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'queries.q_rev_by_month.source:unknown_reference',
        'widgets.w_line.encoding.y:unknown_column',
        'widgets.w_kpi.query:unknown_reference',
        'layout.2.i:unknown_reference',
        'params.dateRange.bind.0:unknown_reference',
      ]),
    );
  });

  it('reports every problem in one pass without cascading from malformed entries', () => {
    const doc = clone(docExample) as any;
    doc.queries.q_rev_by_month.limit = -5; // malformed, but present
    doc.layout[0].w = 20; // structural error elsewhere
    doc.widgets.w_kpi.options.reduce = 'median'; // and another
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors).sort()).toEqual([
      'layout.0.w:too_big',
      'queries.q_rev_by_month.limit:too_small',
      'widgets.w_kpi.options.reduce:invalid_enum_value',
    ]);
  });

  it('rejects typos in widget options at full compatibility', () => {
    const doc = clone(docExample) as any;
    doc.widgets.w_line.options.titel = 'Oops';
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: 'widgets.w_line.options', code: 'unrecognized_keys' });
  });

  it('rejects unknown widget types at full compatibility', () => {
    const doc = clone(docExample) as any;
    doc.widgets.w_line.type = 'chord-diagram';
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors)).toContain('widgets.w_line.type:unknown_widget_type');
  });

  it('renders a newer minor version degraded: unknown widgets become placeholders', () => {
    const doc = clone(docExample) as any;
    doc.specVersion = '1.9';
    doc.widgets.w_line.type = 'chord-diagram';
    doc.widgets.w_kpi.options.sparkline = true; // a field added in a later minor
    const result = validateDashboard(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compatibility.level).toBe('degraded');
    expect(result.dashboard.widgets.w_line).toMatchObject({ type: '__unsupported__', originalType: 'chord-diagram' });
    expect(result.dashboard.widgets.w_kpi).toMatchObject({ type: 'kpi' });
    expect(codes(result.warnings)).toContain('widgets.w_line.type:unknown_widget_type');
  });

  it('lets the store refuse newer minor versions', () => {
    const doc = clone(docExample) as any;
    doc.specVersion = '1.9';
    const result = validateDashboard(doc, { allowNewerMinor: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('version_too_new');
  });

  it('refuses another major version before checking shape', () => {
    const result = validateDashboard({ specVersion: '2.0', totally: 'different' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('unsupported_version');
  });

  it('requires a field for daterange params bound to queries without a time dimension', () => {
    const doc = clone(docExample) as any;
    doc.queries.q_total = { source: 'orders', measures: [{ field: 'amount', agg: 'sum' }] };
    doc.params.dateRange.bind.push('q_total.filters');
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors)).toContain('params.dateRange.bind.1:unresolvable_field');
  });

  it('checks layout bounds, duplicates, overlaps and unplaced widgets', () => {
    const doc = clone(docExample) as any;
    doc.layout = [
      { i: 'w_kpi', x: 0, y: 0, w: 6, h: 2 },
      { i: 'w_kpi', x: 4, y: 0, w: 6, h: 2 }, // duplicate, overlaps the first
      { i: 'w_kpi', x: 8, y: 4, w: 6, h: 2 }, // runs past column 12
    ];
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors)).toEqual(expect.arrayContaining(['layout.1.i:duplicate_layout_item', 'layout.2:out_of_bounds']));
    expect(codes(result.warnings)).toEqual(expect.arrayContaining(['layout.1:overlap', 'widgets.w_line:unplaced_widget']));
  });

  it('validates filter value shapes', () => {
    const doc = clone(docExample) as any;
    doc.queries.q_rev_by_month.filters = [{ field: 'status', op: 'in', value: 'paid' }];
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: 'queries.q_rev_by_month.filters.0.value', code: 'invalid_value' });
  });

  it('flags duplicate output columns', () => {
    const doc = clone(docExample) as any;
    doc.queries.q_rev_by_month.measures.push({ field: 'amount', agg: 'avg', as: 'revenue' });
    const result = validateDashboard(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result.errors)).toContain('queries.q_rev_by_month:duplicate_column');
  });
});
