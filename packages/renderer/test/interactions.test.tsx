import { validateDashboard, type QueryResult, type ValidDashboard } from '@yourorg/bi-spec';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardView, InteractionContext, type DataClient, type QueryRequest } from '../src';
import { createHttpDataClient, requestKey } from '../src/data/client';
import { InteractionBadge } from '../src/interactions-ui';
import { useInteractionEngine, type NavigateRequest } from '../src/interactionEngine';
import { Grid } from '../src/layout/Grid';

afterEach(cleanup);

function dash(extra: Record<string, unknown> = {}): ValidDashboard {
  const r = validateDashboard({
    specVersion: '1.3',
    id: 'd',
    title: 'D',
    interactions: { crossFilter: true },
    dataSources: { s: { type: 'sample', ref: 'orders' } },
    queries: {
      q_region: { source: 's', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
      q_month: { source: 's', dimensions: [{ field: 'order_date', grain: 'month' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
      q_cat: { source: 's', dimensions: [{ field: 'category' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
    },
    widgets: {
      w_region: { type: 'bar-chart', query: 'q_region', encoding: { x: 'region', y: 'revenue' }, options: {} },
      w_month: { type: 'line-chart', query: 'q_month', encoding: { x: 'order_date', y: 'revenue' }, options: {} },
      w_cat: { type: 'table', query: 'q_cat', options: {} },
      w_alone: { type: 'table', query: 'q_cat', options: {}, interactions: { crossFilter: false } },
      w_drill: { type: 'bar-chart', query: 'q_region', encoding: { x: 'region', y: 'revenue' }, options: {}, drill: { levels: [{ field: 'region' }, { field: 'channel', label: 'Channel' }] } },
      w_thru: { type: 'bar-chart', query: 'q_cat', encoding: { x: 'category', y: 'revenue' }, options: {}, drillThrough: { dashboardId: 'dash_cat', params: { cat: 'category' } }, interactions: { crossFilter: false } },
    },
    layout: [
      { i: 'w_region', x: 0, y: 0, w: 6, h: 4 },
      { i: 'w_month', x: 6, y: 0, w: 6, h: 4 },
      { i: 'w_cat', x: 0, y: 4, w: 6, h: 4 },
      { i: 'w_alone', x: 6, y: 4, w: 6, h: 4 },
      { i: 'w_drill', x: 0, y: 8, w: 6, h: 4 },
      { i: 'w_thru', x: 6, y: 8, w: 6, h: 4 },
    ],
    ...extra,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.dashboard;
}

type EngineApi = ReturnType<typeof useInteractionEngine>;
function harness(dashboard: ValidDashboard, onNavigate?: (r: NavigateRequest) => void) {
  const ref: { current?: EngineApi } = {};
  function Probe() {
    const api = useInteractionEngine(dashboard, onNavigate);
    ref.current = api;
    return (
      <InteractionContext.Provider value={api.engine}>
        <InteractionBadge widgetId="w_drill" widget={dashboard.widgets.w_drill!} />
        <InteractionBadge widgetId="w_region" widget={dashboard.widgets.w_region!} />
        <InteractionBadge widgetId="w_cat" widget={dashboard.widgets.w_cat!} />
      </InteractionContext.Provider>
    );
  }
  render(<Probe />);
  const click = (widgetId: string, field: string, value: string, additive = false) =>
    act(() => ref.current!.engine.forWidget(widgetId, dashboard.widgets[widgetId]!).select({ field, value }, { additive }));
  return { api: () => ref.current!, click };
}

describe('interaction engine', () => {
  it('cross-filters the other widgets, not the source or opted-out ones; click again clears', () => {
    const d = dash();
    const { api, click } = harness(d);
    expect(api().engine.forWidget('w_region', d.widgets.w_region!).interactive).toBe(true);
    click('w_region', 'region', 'Europe');
    expect(api().runtimeFor('w_cat')).toEqual({ filters: [{ field: 'region', op: 'in', values: ['Europe'] }] });
    expect(api().runtimeFor('w_month')).toEqual({ filters: [{ field: 'region', op: 'in', values: ['Europe'] }] });
    expect(api().runtimeFor('w_region')).toBeUndefined();
    expect(api().runtimeFor('w_alone')).toBeUndefined();
    expect(api().engine.forWidget('w_region', d.widgets.w_region!).isSelected('region', 'Europe')).toBe(true);
    expect(api().engine.forWidget('w_region', d.widgets.w_region!).isSelected('region', 'APAC')).toBe(false);
    expect(screen.getAllByText('region: Europe').length).toBeGreaterThanOrEqual(2); // source chip + filtered chips
    click('w_region', 'region', 'APAC', true);
    expect(api().runtimeFor('w_cat')!.filters![0]!.values).toEqual(['Europe', 'APAC']);
    click('w_region', 'region', 'APAC'); // plain click replaces
    click('w_region', 'region', 'APAC'); // same again clears
    expect(api().runtimeFor('w_cat')).toBeUndefined();
  });

  it('maps a time bucket click to a grain filter', () => {
    const d = dash();
    const { api, click } = harness(d);
    click('w_month', 'order_date', '2026-03-01');
    expect(api().runtimeFor('w_cat')).toEqual({ filters: [{ field: 'order_date', op: 'eq', grain: 'month', values: ['2026-03-01'] }] });
  });

  it('drills down, shows a breadcrumb, and goes back up', () => {
    const d = dash();
    const { api, click } = harness(d);
    click('w_drill', 'region', 'Europe');
    expect(api().runtimeFor('w_drill')).toEqual({ drill: { widget: 'w_drill', level: 1, path: ['Europe'] } });
    expect(screen.getByLabelText('Drill-down').textContent).toContain('Europe');
    // At the bottom level a click cross-filters instead.
    click('w_drill', 'region', 'Online');
    expect(api().runtimeFor('w_cat')).toEqual({ filters: [{ field: 'channel', op: 'in', values: ['Online'] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Up one level' }));
    expect(api().runtimeFor('w_drill')).toBeUndefined();
  });

  it('drill-through asks the host to navigate with the mapped param', () => {
    const nav = vi.fn();
    const d = dash();
    const { click } = harness(d, nav);
    click('w_thru', 'category', 'Software');
    expect(nav).toHaveBeenCalledWith({ dashboardId: 'dash_cat', params: { cat: 'Software' } });
  });

  it('does nothing when the dashboard enables nothing', () => {
    const d = dash({ interactions: undefined });
    const { api, click } = harness(d);
    expect(api().engine.forWidget('w_region', d.widgets.w_region!).interactive).toBe(false);
    click('w_region', 'region', 'Europe');
    expect(api().runtimeFor('w_cat')).toBeUndefined();
  });
});

describe('tabs and mobile layout', () => {
  it('only runs the active tab’s queries', async () => {
    const d = dash({
      tabs: [{ id: 'a', title: 'Overview' }, { id: 'b', title: 'Detail' }],
      layout: [
        { i: 'w_region', x: 0, y: 0, w: 6, h: 4 },
        { i: 'w_cat', x: 0, y: 0, w: 6, h: 4, tab: 'b' },
      ],
    });
    const requests: QueryRequest[] = [];
    const result: QueryResult = { columns: [], rows: [], truncated: false };
    const client: DataClient = { getDashboard: () => Promise.reject(new Error('x')), fetchQuery: async (r) => (requests.push(r), result) };
    render(<DashboardView dashboard={d} version={1} client={client} />);
    await act(async () => {});
    expect(requests.map((r) => r.queryId)).toEqual(['q_region']);
    fireEvent.click(screen.getByRole('tab', { name: 'Detail' }));
    await act(async () => {});
    expect(requests.map((r) => r.queryId)).toContain('q_cat');
    expect(screen.getByRole('tab', { name: 'Detail' }).getAttribute('aria-selected')).toBe('true');
  });

  it('orders, sizes and hides widgets when stacked', () => {
    // jsdom: the ResizeObserver stub reports 800 px; force a narrow width through getBoundingClientRect.
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = undefined as never;
    try {
      const { container } = render(
        <Grid
          items={[
            { i: 'a', x: 0, y: 0, w: 6, h: 2 },
            { i: 'b', x: 6, y: 0, w: 6, h: 2 },
            { i: 'c', x: 0, y: 2, w: 12, h: 4 },
          ]}
          mobile={[{ i: 'c', order: 0, h: 3 }, { i: 'b', hide: true }]}
        >
          {(item) => <span>{item.i}</span>}
        </Grid>,
      );
      const cells = [...container.querySelectorAll('[data-widget-id]')] as HTMLElement[];
      expect(cells.map((c) => c.dataset.widgetId)).toEqual(['c', 'a']);
      expect(cells[0]!.style.gridRow).toBe('span 3');
    } finally {
      spy.mockRestore();
      globalThis.ResizeObserver = RO;
    }
  });
});

describe('data client variants', () => {
  it('sends variants under their own key and caches them apart', async () => {
    const bodies: Array<{ queries: unknown[] }> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { queries: Array<string | { key: string }> };
      bodies.push(body);
      const lines = body.queries.map((q) => JSON.stringify({ id: typeof q === 'string' ? q : q.key, ok: true, result: { columns: [], rows: [{ k: typeof q === 'string' ? q : q.key }], truncated: false } }));
      return new Response(lines.join('\n') + '\n');
    });
    const client = createHttpDataClient({ apiUrl: '/x', token: 't', fetch: fetch as unknown as typeof globalThis.fetch });
    const base = { dashboardId: 'd', version: 1, queryId: 'q_cat', params: {}, cacheParams: {} };
    const runtime = { filters: [{ field: 'region', op: 'in' as const, values: ['Europe'] }] };
    const [plain, filtered] = await Promise.all([client.fetchQuery(base), client.fetchQuery({ ...base, runtime })]);
    expect(plain.rows[0]!.k).toBe('q_cat');
    expect(filtered.rows[0]!.k).toBe(requestKey('q_cat', runtime));
    expect(bodies[0]!.queries).toEqual(['q_cat', { query: 'q_cat', key: requestKey('q_cat', runtime), ...runtime }]);
    await client.fetchQuery({ ...base, runtime });
    expect(fetch).toHaveBeenCalledTimes(1); // cached
    expect(requestKey('q_cat', {})).toBe('q_cat');
  });
});
