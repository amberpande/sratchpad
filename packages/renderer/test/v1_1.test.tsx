import { validateDashboard, type QueryResult, type StoredDashboard } from '@yourorg/bi-spec';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import opsMix from '../../../examples/dashboards/ops_mix.json';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { Dashboard, DashboardView, widgetComponents, type DataClient, type QueryRequest } from '../src';

afterEach(cleanup);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const customers = Array.from({ length: 5000 }, (_, i) => ({
  customer_id: `cus_${String(i).padStart(4, '0')}`,
  orders: 1 + (i % 6),
  avg_order_value: 500 + (i % 37) * 40,
  revenue: 10_000 - i,
}));

function opsResults(asOf?: string): Record<string, QueryResult> {
  const stamp = asOf ? { asOf } : {};
  return {
    q_rev_by_channel: {
      columns: [
        { name: 'order_date', type: 'time', grain: 'month' },
        { name: 'channel', type: 'string' },
        { name: 'revenue', type: 'number' },
      ],
      rows: ['2026-09-01', '2026-10-01'].flatMap((m) => ['Direct', 'Online', 'Partner'].map((c, i) => ({ order_date: m, channel: c, revenue: 1000 * (i + 1) }))),
      truncated: false,
      ...stamp,
    },
    q_category_share: {
      columns: [
        { name: 'category', type: 'string' },
        { name: 'revenue', type: 'number' },
      ],
      rows: [
        { category: 'Services', revenue: 300 },
        { category: 'Software', revenue: 250 },
        { category: 'Hardware', revenue: 150 },
        { category: 'Support', revenue: 100 },
      ],
      truncated: false,
      ...stamp,
    },
    q_region_category: {
      columns: [
        { name: 'region', type: 'string' },
        { name: 'category', type: 'string' },
        { name: 'revenue', type: 'number' },
      ],
      rows: [
        { region: 'APAC', category: 'Software', revenue: 1200 },
        { region: 'APAC', category: 'Hardware', revenue: 800 },
        { region: 'Europe', category: 'Software', revenue: 2500 },
      ],
      truncated: false,
      ...stamp,
    },
    q_customers: {
      columns: [
        { name: 'customer_id', type: 'string' },
        { name: 'orders', type: 'number' },
        { name: 'avg_order_value', type: 'number' },
        { name: 'revenue', type: 'number' },
      ],
      rows: customers,
      truncated: false,
      ...(asOf ? { asOf: minutesAgo(30), cached: true } : {}),
    },
  };
}

function fakeClient(spec: unknown, results: Record<string, QueryResult>) {
  const requests: QueryRequest[] = [];
  const client: DataClient & { requests: QueryRequest[] } = {
    requests,
    async getDashboard(id): Promise<StoredDashboard> {
      return { id, version: 1, title: 't', specVersion: '1.1', createdAt: '', createdBy: '', spec };
    },
    async fetchQuery(request) {
      requests.push(request);
      return results[request.queryId]!;
    },
  };
  return client;
}

const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!;

describe('spec 1.1 widgets', () => {
  it('renders every new type from ops_mix, and text widgets need no query', async () => {
    const client = fakeClient(opsMix, opsResults());
    const { container } = render(<Dashboard id="ops_mix" token="t" client={client} />);
    expect(await screen.findByRole('heading', { name: 'Order mix' })).toBeTruthy();

    // code-split charts load
    await waitFor(() => expect(container.querySelector('[aria-label="Stacked area chart of Revenue by Channel by Order date"]')).toBeTruthy());
    await waitFor(() => expect(container.querySelector('[aria-label="Pie chart of Revenue by Category"]')).toBeTruthy());
    await waitFor(() => expect(container.querySelector('[aria-label^="Scatter plot of Avg order value against Orders"]')).toBeTruthy());

    // area: legend by series value (3 series ≥ 2)
    const area = card(container, 'w_channel');
    expect([...area.querySelectorAll('.bi-legend > span')].map((s) => s.textContent)).toEqual(['Direct', 'Online', 'Partner']);

    // pie: legend with shares in text ink
    const pie = card(container, 'w_share');
    expect([...pie.querySelectorAll('.bi-pie-legend li')].map((li) => li.textContent)).toEqual(['Services37.5%', 'Software31.3%', 'Hardware18.8%', 'Support12.5%']);

    // pivot: region rows × category columns, cell lookup, missing cell shown as a dash
    const pivot = within(card(container, 'w_pivot')).getByRole('table');
    expect(within(pivot).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Region', 'Hardware', 'Software']);
    expect(within(pivot).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['APAC', 'Europe']);
    const europe = within(pivot).getAllByRole('row')[2]!;
    expect(within(europe).getAllByRole('cell').map((td) => td.textContent)).toEqual(['—', '$2,500']);

    // text: markdown-lite, no query requested for it
    const text = card(container, 'w_intro');
    expect(text.querySelector('strong')?.textContent).toBe('date range');
    expect(text.querySelectorAll('li')).toHaveLength(2);
    expect(text.querySelector('code')?.textContent).toBe('region × category');
    expect(client.requests.map((r) => r.queryId).sort()).toEqual(['q_category_share', 'q_customers', 'q_region_category', 'q_rev_by_channel']);
  });

  it('virtualizes long tables: 5,000 rows, only a window in the DOM, all rows announced', async () => {
    const client = fakeClient(opsMix, opsResults());
    const { container } = render(<Dashboard id="ops_mix" token="t" client={client} />);
    const table = await waitFor(() => within(card(container, 'w_customers')).getByRole('table'));
    expect(table.getAttribute('aria-rowcount')).toBe('5001');
    await waitFor(() => expect(table.querySelectorAll('tbody tr[aria-rowindex]').length).toBeGreaterThan(0));
    const rendered = table.querySelectorAll('tbody tr[aria-rowindex]');
    expect(rendered.length).toBeLessThan(60);
    expect(within(table).getByText('cus_0000')).toBeTruthy();
    expect(within(card(container, 'w_customers')).getByText('5,000 rows')).toBeTruthy();
    // the scroll region is keyboard-focusable and named
    const region = within(card(container, 'w_customers')).getByRole('region', { name: 'Customers (scrollable)' });
    expect(region.tabIndex).toBe(0);
  });

  it('every chart has a keyboard-accessible "View as table" toggle showing the same result', async () => {
    const client = fakeClient(opsMix, opsResults());
    const { container } = render(<Dashboard id="ops_mix" token="t" client={client} />);
    await waitFor(() => expect(container.querySelector('[aria-label^="Pie chart"]')).toBeTruthy());
    const pie = card(container, 'w_share');
    const toggle = within(pie).getByRole('button', { name: 'View as table' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.tagName).toBe('BUTTON'); // native button: Enter/Space work
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const table = within(pie).getByRole('table', { name: 'Category share of revenue (table view)' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Category', 'Revenue']);
    expect(within(table).getByText('$300.00')).toBeTruthy(); // uses the chart's currency format
    fireEvent.click(toggle);
    await waitFor(() => expect(pie.querySelector('[aria-label^="Pie chart"]')).toBeTruthy());

    // charts have it; tables, pivots and text don't
    for (const id of ['w_channel', 'w_customers_scatter']) expect(within(card(container, id)).queryByRole('button', { name: 'View as table' })).toBeTruthy();
    for (const id of ['w_pivot', 'w_customers', 'w_intro']) expect(within(card(container, id)).queryByRole('button', { name: 'View as table' })).toBeNull();
  });

  it('shows freshness when the API sends asOf, per dashboard and for widgets that differ', async () => {
    const client = fakeClient(opsMix, opsResults(minutesAgo(3)));
    const { container } = render(<Dashboard id="ops_mix" token="t" client={client} />);
    // the dashboard is as fresh as its stalest widget (the cached customers query, 30 min)
    await waitFor(() => expect(container.querySelector('.bi-header .bi-fresh')?.textContent).toBe('Updated 30 min ago'));
    const header = container.querySelector('.bi-header')!;
    expect(header.querySelector('.bi-fresh')?.getAttribute('title')).toMatch(/cached/);
    // widgets 3 min old differ from the header's 30 min, so they show their own label
    expect(card(container, 'w_pivot').querySelector('.bi-fresh')?.textContent).toBe('Updated 3 min ago');
    // the customers widgets match the header, so they don't repeat it
    expect(card(container, 'w_customers').querySelector('.bi-fresh')).toBeNull();
  });

  it('shows no freshness label (and reserves no extra space) when asOf is absent', async () => {
    const client = fakeClient(salesOverview, {});
    const { container } = render(<Dashboard id="dash_9f2a" token="t" client={{ ...client, fetchQuery: async () => opsResults().q_category_share! }} />);
    await screen.findByRole('heading', { name: 'Sales overview' });
    await waitFor(() => expect(container.querySelectorAll('.bi-card').length).toBe(6));
    expect(container.querySelector('.bi-fresh')).toBeNull();
  });

  it('a 1.1 document opened by a 1.0 renderer degrades to placeholders', async () => {
    const validation = validateDashboard(opsMix, { supported: { major: 1, minor: 0 } });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const client = fakeClient(opsMix, opsResults());
    const { container } = render(
      <DashboardView dashboard={validation.dashboard} version={1} client={client} compatibility={validation.compatibility} />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/newer than this renderer/);
    expect(screen.getAllByText('Needs a newer renderer')).toHaveLength(5);
    // the 1.0 table still renders; its 1.1 "pagination" option was dropped with a warning
    await waitFor(() => expect(within(card(container, 'w_customers')).getByRole('table')).toBeTruthy());
    expect(validation.warnings.map((w) => w.path)).toContain('widgets.w_customers.options.pagination');
    // placeholders don't fetch
    expect(client.requests.map((r) => r.queryId)).toEqual(['q_customers']);
  });

  it('a param change re-renders only the widgets whose query changed', async () => {
    const spec = structuredClone(opsMix) as any;
    // q_category_share stops depending on the date range
    spec.params.dateRange.bind = spec.params.dateRange.bind.filter((b: string) => b !== 'q_category_share.filters');
    const renders: Record<string, number> = {};
    const original = widgetComponents.pie;
    const PivotOriginal = widgetComponents.pivot as ComponentType<any>;
    const counting =
      (name: string, Inner: ComponentType<any>) =>
      (props: any) => {
        renders[name] = (renders[name] ?? 0) + 1;
        return <Inner {...props} />;
      };
    (widgetComponents as any).pie = counting('pie', () => <div>pie</div>);
    (widgetComponents as any).pivot = counting('pivot', PivotOriginal);
    try {
      const results = opsResults();
      const cache = new Map<string, QueryResult>();
      // A caching client like the real one: same cache key → same result object.
      const client: DataClient = {
        async getDashboard(id) {
          return { id, version: 1, title: 't', specVersion: '1.1', createdAt: '', createdBy: '', spec };
        },
        async fetchQuery(r) {
          const key = `${r.queryId}:${JSON.stringify(r.cacheParams)}`;
          if (!cache.has(key)) cache.set(key, { ...results[r.queryId]! });
          return cache.get(key)!;
        },
      };
      const { rerender } = render(<Dashboard id="ops_mix" token="t" client={client} params={{ dateRange: 'last_30d' }} />);
      await screen.findByText('pie');
      await waitFor(() => expect(renders.pivot).toBeGreaterThan(0));
      const before = { ...renders };
      await act(async () => {
        rerender(<Dashboard id="ops_mix" token="t" client={client} params={{ dateRange: 'last_7d' }} />);
      });
      await waitFor(() => expect(renders.pivot).toBeGreaterThan(before.pivot!));
      expect(renders.pie).toBe(before.pie); // its query didn't change: no re-render
    } finally {
      (widgetComponents as any).pie = original;
      (widgetComponents as any).pivot = PivotOriginal;
    }
  });

  it('never renders author links that are not http(s) or mailto', async () => {
    const spec = structuredClone(opsMix) as any;
    spec.widgets.w_intro.options.text = '[ok](https://example.com) and [bad](javascript:alert(1)) <b>raw</b>';
    const client = fakeClient(spec, opsResults());
    const { container } = render(<Dashboard id="ops_mix" token="t" client={client} />);
    await waitFor(() => expect(card(container, 'w_intro')?.querySelector('.bi-text')).toBeTruthy());
    const text = card(container, 'w_intro').querySelector('.bi-text')!;
    const links = [...text.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(text.querySelector('b')).toBeNull();
    expect(text.textContent).toContain('<b>raw</b>');
  });
});
