import { validateDashboard, type Cell, type QueryResult, type Widget } from '@yourorg/bi-spec';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatNumber, formatValue } from '../src/format';
import { InteractionContext, WidgetIdContext, type InteractionEngine, type MarkSelection } from '../src/interactions';
import BoxplotWidget from '../src/widgets/BoxplotWidget';
import BulletWidget from '../src/widgets/BulletWidget';
import ComboWidget from '../src/widgets/ComboWidget';
import FunnelWidget from '../src/widgets/FunnelWidget';
import GaugeWidget from '../src/widgets/GaugeWidget';
import HeatmapWidget from '../src/widgets/HeatmapWidget';
import { ImageWidget, safeHttpsUrl } from '../src/widgets/ImageWidget';
import { KpiWidget } from '../src/widgets/KpiWidget';
import LineChartWidget from '../src/widgets/LineChartWidget';
import MapWidget from '../src/widgets/MapWidget';
import SankeyWidget from '../src/widgets/SankeyWidget';
import { TableWidget } from '../src/widgets/TableWidget';
import TreemapWidget from '../src/widgets/TreemapWidget';
import WaterfallWidget from '../src/widgets/WaterfallWidget';
import { CHART_TYPES, widgetComponents } from '../src/widgets/registry';

afterEach(cleanup);

const ctx = { locale: 'en-US', currency: 'USD' };
const res = (columns: Array<[string, 'string' | 'number' | 'time']>, rows: Array<Record<string, Cell>>): QueryResult => ({
  columns: columns.map(([name, type]) => ({ name, type })),
  rows,
  truncated: false,
});

/** Validates a widget the way the API would (so tests render exactly what the spec accepts). */
function widget(w: Record<string, unknown>, measures: Array<[string, string, string]>, dimensions: string[] = []): Widget {
  const v = validateDashboard({
    specVersion: '1.3',
    id: 'd',
    title: 'D',
    dataSources: { s: { type: 'sample', ref: 'orders' } },
    queries: measures.length || dimensions.length ? { q: { source: 's', dimensions: dimensions.map((field) => ({ field })), measures: measures.map(([field, agg, as]) => ({ field, agg, as })) } } : {},
    widgets: { w: { query: w.type === 'image' ? undefined : 'q', ...w } },
    layout: [{ i: 'w', x: 0, y: 0, w: 12, h: 5 }],
  });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.dashboard.widgets.w as Widget;
}

/** A recording interaction engine: everything interactive, `selected` values highlighted. */
function engine(selected: MarkSelection[] = []) {
  const calls: Array<{ sel: MarkSelection; additive?: boolean }> = [];
  const e: InteractionEngine = {
    forWidget: () => ({
      interactive: true,
      select: (sel, ev) => calls.push({ sel, additive: ev?.additive }),
      isSelected: (field, value) => (selected.length ? selected.some((s) => s.field === field && s.value === value) : undefined),
    }),
  };
  return { e, calls };
}

function mount(el: ReactElement, w: Widget, eng = engine()) {
  return render(
    <InteractionContext.Provider value={eng.e}>
      <WidgetIdContext.Provider value={{ id: 'w', widget: w }}>
        <div style={{ width: 800, height: 300 }}>{el}</div>
      </WidgetIdContext.Provider>
    </InteractionContext.Provider>,
  );
}

const byRegion = res([['region', 'string'], ['revenue', 'number']], [
  { region: 'Europe', revenue: 300 },
  { region: 'APAC', revenue: 100 },
  { region: 'LATAM', revenue: -50 },
]);

describe('registry', () => {
  it('has a component for every 1.3 type and the charts get a table view', () => {
    for (const t of ['map', 'heatmap', 'treemap', 'boxplot', 'waterfall', 'funnel', 'gauge', 'bullet', 'sankey', 'combo', 'image'] as const) {
      expect(widgetComponents[t], t).toBeTruthy();
      if (t !== 'image') expect(CHART_TYPES.has(t), t).toBe(true);
    }
  });
});

describe('number formats (1.3)', () => {
  it('formats with decimals, prefix/suffix, scaling and percent', () => {
    expect(formatNumber(1234567, { prefix: '$', scale: 'auto', decimals: 1 }, ctx)).toBe('$1.2M');
    expect(formatNumber(-2500, { scale: 'k' }, ctx)).toBe('-2.5k');
    expect(formatNumber(0.0834, { percent: true }, ctx)).toBe('8.3%');
    expect(formatNumber(1234.5, { decimals: 0, thousands: false, suffix: ' units' }, ctx)).toBe('1235 units');
    expect(formatValue(42, { decimals: 2 }, undefined, ctx)).toBe('42.00');
    expect(formatValue('text', { decimals: 2 }, undefined, ctx)).toBe('text');
  });
});

describe('new visual types render and report clicks', () => {
  it('map: matches countries by name, alias and ISO numeric code; counts unmatched rows', async () => {
    const w = widget({ type: 'map', encoding: { region: 'country', value: 'revenue' }, options: {} }, [['amount', 'sum', 'revenue']], ['country']);
    const r = res([['country', 'string'], ['revenue', 'number']], [
      { country: 'Germany', revenue: 10 },
      { country: 'USA', revenue: 30 },
      { country: '076', revenue: 20 },
      { country: 'Atlantis', revenue: 5 },
    ]);
    const eng = engine();
    const { container } = mount(<MapWidget widget={w as never} result={r} format={ctx} />, w, eng);
    await waitFor(() => expect(container.querySelectorAll('.bi-map-region[data-matched]').length).toBe(3));
    expect(screen.getByText(/1 row\(s\) not matched/)).toBeTruthy();
    const germany = [...container.querySelectorAll('.bi-map-region[data-matched]')].find((p) => p.querySelector('title')?.textContent?.startsWith('Germany'))!;
    fireEvent.click(germany, { shiftKey: true });
    expect(eng.calls[0]).toEqual({ sel: { field: 'country', value: 'Germany' }, additive: true });
    expect(screen.getByRole('img', { name: /Map of Revenue by Country/ })).toBeTruthy();
  });

  it('map: US states by postal code; symbol map from lat/lon', async () => {
    const w = widget({ type: 'map', encoding: { region: 'st', value: 'n' }, options: { basemap: 'usa' } }, [['amount', 'count', 'n']], ['st']);
    const { container } = mount(<MapWidget widget={w as never} result={res([['st', 'string'], ['n', 'number']], [{ st: 'CA', n: 3 }, { st: 'texas', n: 1 }])} format={ctx} />, w);
    await waitFor(() => expect(container.querySelectorAll('.bi-map-region[data-matched]').length).toBe(2));
    cleanup();
    const s = widget({ type: 'map', encoding: { lat: 'lat', lon: 'lon', size: 'n', label: 'city' }, options: { kind: 'symbol' } }, [['amount', 'avg', 'lat'], ['amount', 'min', 'lon'], ['amount', 'count', 'n']], ['city']);
    const sym = mount(<MapWidget widget={s as never} result={res([['city', 'string'], ['lat', 'number'], ['lon', 'number'], ['n', 'number']], [{ city: 'Paris', lat: 48.85, lon: 2.35, n: 5 }, { city: 'Bad', lat: 200, lon: 0, n: 1 }])} format={ctx} />, s);
    await waitFor(() => expect(sym.container.querySelectorAll('.bi-map-point').length).toBe(1));
    expect(screen.getByText(/without valid coordinates/)).toBeTruthy();
  });

  it('heatmap: one cell per x×y, colored, values shown, dimmed by selection', () => {
    const w = widget({ type: 'heatmap', encoding: { x: 'category', y: 'region', value: 'revenue' }, options: { showValues: true } }, [['amount', 'sum', 'revenue']], ['region', 'category']);
    const r = res([['region', 'string'], ['category', 'string'], ['revenue', 'number']], [
      { region: 'EU', category: 'A', revenue: 10 },
      { region: 'EU', category: 'B', revenue: 20 },
      { region: 'US', category: 'A', revenue: 30 },
    ]);
    const { container } = mount(<HeatmapWidget widget={w as never} result={r} format={ctx} />, w, engine([{ field: 'category', value: 'A' }]));
    const cells = container.querySelectorAll('svg g');
    expect(cells.length).toBe(4); // 2 × 2, one empty
    expect([...cells].filter((g) => g.getAttribute('opacity') === '0.3').length).toBe(2); // category B dimmed
    expect(container.textContent).toContain('30');
  });

  it('treemap: rectangles for positive values; refuses negatives', () => {
    const w = widget({ type: 'treemap', encoding: { category: 'region', value: 'revenue' }, options: {} }, [['amount', 'sum', 'revenue']], ['region']);
    const pos = res(byRegion.columns.map((c) => [c.name, c.type as 'string' | 'number']), byRegion.rows.filter((r) => (r.revenue as number) > 0));
    const { container } = mount(<TreemapWidget widget={w as never} result={pos} format={ctx} />, w);
    expect(container.querySelectorAll('.bi-treemap rect').length).toBe(2);
    cleanup();
    mount(<TreemapWidget widget={w as never} result={byRegion} format={ctx} />, w);
    expect(screen.getByText('Can’t show as a treemap')).toBeTruthy();
  });

  it('waterfall: steps float from the running total, plus a total bar', () => {
    const w = widget({ type: 'waterfall', encoding: { category: 'region', value: 'revenue' }, options: {} }, [['amount', 'sum', 'revenue']], ['region']);
    const { container } = mount(<WaterfallWidget widget={w as never} result={byRegion} format={ctx} />, w);
    expect([...container.querySelectorAll('g[data-kind]')].map((g) => g.getAttribute('data-kind'))).toEqual(['increase', 'increase', 'decrease', 'total']);
    expect(container.textContent).toContain('Total');
    expect(container.textContent).toContain('350');
  });

  it('funnel: stages in order with conversion; click selects the stage', () => {
    const w = widget({ type: 'funnel', encoding: { stage: 'step', value: 'n' }, options: {} }, [['order_id', 'count', 'n']], ['step']);
    const eng = engine();
    mount(<FunnelWidget widget={w as never} result={res([['step', 'string'], ['n', 'number']], [{ step: 'Visit', n: 100 }, { step: 'Cart', n: 40 }, { step: 'Buy', n: 10 }])} format={ctx} />, w, eng);
    const list = screen.getByRole('list', { name: /Funnel/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list.textContent).toContain('40% of previous');
    fireEvent.click(within(list).getByText('Cart'));
    expect(eng.calls[0]!.sel).toEqual({ field: 'step', value: 'Cart' });
  });

  it('gauge: value, max from a column, target tick, accessible summary', () => {
    const w = widget({ type: 'gauge', options: { field: 'aov', maxField: 'top', target: 1500, label: 'Avg order' } }, [['amount', 'avg', 'aov'], ['amount', 'max', 'top']]);
    const { container } = mount(<GaugeWidget widget={w as never} result={res([['aov', 'number'], ['top', 'number']], [{ aov: 1200, top: 3000 }])} format={ctx} />, w);
    expect(container.querySelector('[data-part="value"]')).toBeTruthy();
    expect(container.querySelector('[data-part="target"]')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Avg order: 1,200 of 3,000, target 1,500/ })).toBeTruthy();
  });

  it('bullet, boxplot, sankey, combo render their marks', async () => {
    const b = widget({ type: 'bullet', encoding: { category: 'region', value: 'revenue' }, options: { ranges: [100, 200] } }, [['amount', 'sum', 'revenue']], ['region']);
    mount(<BulletWidget widget={b as never} result={byRegion} format={ctx} />, b);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    cleanup();

    const bx = widget({ type: 'boxplot', encoding: { category: 'c', min: 'a', q1: 'b', median: 'm', q3: 'd', max: 'e' }, options: {} }, [['amount', 'min', 'a'], ['amount', 'p25', 'b'], ['amount', 'median', 'm'], ['amount', 'p75', 'd'], ['amount', 'max', 'e']], ['c']);
    const box = mount(<BoxplotWidget widget={bx as never} result={res([['c', 'string'], ['a', 'number'], ['b', 'number'], ['m', 'number'], ['d', 'number'], ['e', 'number']], [{ c: 'X', a: 1, b: 2, m: 3, d: 4, e: 5 }])} format={ctx} />, bx);
    expect(box.container.querySelectorAll('svg rect').length).toBe(1);
    cleanup();

    const sk = widget({ type: 'sankey', encoding: { source: 'from', target: 'to', value: 'v' }, options: {} }, [['amount', 'sum', 'v']], ['from', 'to']);
    const sank = mount(<SankeyWidget widget={sk as never} result={res([['from', 'string'], ['to', 'string'], ['v', 'number']], [{ from: 'Online', to: 'EU', v: 5 }, { from: 'Online', to: 'US', v: 3 }, { from: 'Partner', to: 'EU', v: 2 }])} format={ctx} />, sk);
    expect(sank.container.querySelectorAll('.bi-sankey path').length).toBe(3);
    expect(sank.container.querySelectorAll('.bi-sankey rect').length).toBe(4);
    cleanup();

    const cb = widget({ type: 'combo', encoding: { x: 'month', bars: 'revenue', lines: 'orders' }, options: {} }, [['amount', 'sum', 'revenue'], ['order_id', 'count', 'orders']], ['month']);
    const combo = mount(<ComboWidget widget={cb as never} result={res([['month', 'string'], ['revenue', 'number'], ['orders', 'number']], [{ month: 'Jan', revenue: 10, orders: 2 }, { month: 'Feb', revenue: 20, orders: 3 }])} format={ctx} />, cb);
    await waitFor(() => expect(combo.container.querySelectorAll('.recharts-bar-rectangle').length).toBe(2));
    expect(combo.container.querySelector('.recharts-line')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Combo chart of Revenue \(bars\) and Orders \(lines\)/ })).toBeTruthy();
  });

  it('image: https only, alt text, no referrer', () => {
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://x.test/a.png')).toBeNull();
    const w = widget({ type: 'image', options: { src: 'https://x.test/logo.png', alt: 'Logo', href: 'https://x.test' } }, []);
    mount(<ImageWidget widget={w as never} result={res([], [])} format={ctx} />, w);
    const img = screen.getByRole('img', { name: 'Logo' }) as HTMLImageElement;
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect((img.closest('a') as HTMLAnchorElement).rel).toBe('noopener noreferrer');
    cleanup();
    // A value that slipped past validation is still refused at render time.
    mount(<ImageWidget widget={{ ...w, options: { ...(w as { options: object }).options, src: 'data:image/png;base64,AA' } } as never} result={res([], [])} format={ctx} />, w);
    expect(screen.getByText('Image not shown')).toBeTruthy();
  });
});

describe('formatting on existing types', () => {
  it('table: conditional formats as custom properties, click-to-sort, row clicks', () => {
    const w = widget(
      { type: 'table', options: { conditionalFormats: [{ field: 'revenue', rules: [{ op: 'lt', value: 0, color: '#cc0000' }] }], numberFormats: { revenue: { prefix: '$' } } } },
      [['amount', 'sum', 'revenue']],
      ['region'],
    );
    const eng = engine();
    const { container } = mount(<TableWidget widget={w as never} result={byRegion} format={ctx} />, w, eng);
    const neg = screen.getByText('-$50');
    expect(neg.getAttribute('data-cf')).toBe('');
    expect((neg as HTMLElement).style.getPropertyValue('--bi-cell-fg')).toBe('#cc0000');
    fireEvent.click(screen.getByRole('button', { name: /Revenue/ }));
    const first = () => container.querySelector('tbody tr td')!.textContent;
    expect(first()).toBe('LATAM');
    fireEvent.click(screen.getByRole('button', { name: /Revenue/ }));
    expect(first()).toBe('Europe');
    fireEvent.click(screen.getByText('APAC'));
    expect(eng.calls.at(-1)!.sel).toEqual({ field: 'region', value: 'APAC' });
  });

  it('table sparklines collapse rows by the remaining columns without summing', () => {
    const w = widget({ type: 'table', options: { sparkline: { by: 'month', value: 'revenue' } } }, [['amount', 'sum', 'revenue']], ['category', 'month']);
    const r = res([['category', 'string'], ['month', 'string'], ['revenue', 'number']], [
      { category: 'A', month: 'Jan', revenue: 1 },
      { category: 'A', month: 'Feb', revenue: 3 },
      { category: 'B', month: 'Jan', revenue: 2 },
      { category: 'B', month: 'Feb', revenue: 1 },
    ]);
    const { container } = mount(<TableWidget widget={w as never} result={r} format={ctx} />, w);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelectorAll('svg.bi-spark')).toHaveLength(2);
  });

  it('KPI: threshold color and comparison arrow with tone', () => {
    const w = widget(
      { type: 'kpi', options: { field: 'revenue', thresholds: [{ op: 'lt', value: 500, color: '#cc0000' }], comparison: { field: 'chg', label: 'vs last month', positiveIs: 'down' } } },
      [['amount', 'sum', 'revenue'], ['amount', 'avg', 'chg']],
    );
    const { container } = mount(<KpiWidget widget={w as never} result={res([['revenue', 'number'], ['chg', 'number']], [{ revenue: 400, chg: 0.12 }])} format={ctx} />, w);
    expect((container.querySelector('.bi-kpi-value') as HTMLElement).style.getPropertyValue('--bi-cell-fg')).toBe('#cc0000');
    const delta = container.querySelector('.bi-kpi-delta')!;
    expect(delta.getAttribute('data-tone')).toBe('bad'); // up is bad when positiveIs = down
    expect(delta.textContent).toContain('▲');
    expect(delta.textContent).toContain('+12%');
  });

  it('line chart: small multiples, one panel per facet value', async () => {
    const w = widget({ type: 'line-chart', encoding: { x: 'month', y: 'revenue', facet: 'region' }, options: { referenceLines: [{ value: 15, label: 'Goal' }] } }, [['amount', 'sum', 'revenue']], ['month', 'region']);
    const r = res([['month', 'string'], ['region', 'string'], ['revenue', 'number']], ['EU', 'US', 'APAC'].flatMap((g) => ['Jan', 'Feb'].map((m, i) => ({ month: m, region: g, revenue: 10 + i }))));
    const { container } = mount(<LineChartWidget widget={w as never} result={r} format={ctx} />, w);
    expect([...container.querySelectorAll('.bi-facet figcaption')].map((f) => f.textContent)).toEqual(['EU', 'US', 'APAC']);
    await waitFor(() => expect(container.querySelectorAll('.recharts-line').length).toBe(3));
  });

  it('charts without an engine stay inert (no selection calls, no errors)', () => {
    const w = widget({ type: 'funnel', encoding: { stage: 'step', value: 'n' }, options: {} }, [['order_id', 'count', 'n']], ['step']);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<FunnelWidget widget={w as never} result={res([['step', 'string'], ['n', 'number']], [{ step: 'Visit', n: 1 }])} format={ctx} />);
    fireEvent.click(screen.getByText('Visit'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
