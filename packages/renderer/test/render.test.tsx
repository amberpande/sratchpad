import type { QueryResult, StoredDashboard } from '@yourorg/bi-spec';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { Dashboard, formatValue, type DataClient, type QueryRequest } from '../src';

afterEach(cleanup);

const results: Record<string, QueryResult> = {
  q_rev_by_month: {
    columns: [
      { name: 'order_date', type: 'time', grain: 'month' },
      { name: 'revenue', type: 'number' },
    ],
    rows: [
      { order_date: '2026-09-01', revenue: 1_000_000 },
      { order_date: '2026-10-01', revenue: 1_250_000.5 },
    ],
    truncated: false,
  },
  q_totals: {
    columns: [
      { name: 'orders', type: 'number' },
      { name: 'avg_order_value', type: 'number' },
    ],
    rows: [{ orders: 4321, avg_order_value: 1834.256 }],
    truncated: false,
  },
  q_rev_by_region: {
    columns: [
      { name: 'region', type: 'string' },
      { name: 'revenue', type: 'number' },
    ],
    rows: [{ region: 'Europe', revenue: 5 }],
    truncated: false,
  },
  q_by_category: {
    columns: [
      { name: 'category', type: 'string' },
      { name: 'orders', type: 'number' },
      { name: 'revenue', type: 'number' },
      { name: 'avg_order_value', type: 'number' },
    ],
    rows: [
      { category: 'Software', orders: 1500, revenue: 2_700_000, avg_order_value: 1800 },
      { category: 'Hardware', orders: 1200, revenue: 900_000, avg_order_value: 750 },
    ],
    truncated: false,
  },
};

function fakeClient(spec: unknown, overrides: Partial<Record<string, Error>> = {}) {
  const requests: QueryRequest[] = [];
  const client: DataClient & { requests: QueryRequest[] } = {
    requests,
    async getDashboard(id): Promise<StoredDashboard> {
      return { id, version: 4, title: 't', specVersion: '1.0', createdAt: '', createdBy: '', spec };
    },
    async fetchQuery(request) {
      requests.push(request);
      const err = overrides[request.queryId];
      if (err) throw err;
      return results[request.queryId]!;
    },
  };
  return client;
}

describe('<Dashboard>', () => {
  it('renders KPIs and tables from the JSON, pinned to the loaded version', async () => {
    const client = fakeClient(salesOverview);
    render(<Dashboard id="dash_9f2a" token="t" client={client} params={{ dateRange: 'last_30d' }} />);

    expect(await screen.findByRole('heading', { name: 'Sales overview' })).toBeTruthy();
    expect(await screen.findByText('$2,250,001')).toBeTruthy(); // KPI: sum of the monthly revenue
    expect(screen.getByText('Total revenue')).toBeTruthy();
    expect(screen.getByText('4,321')).toBeTruthy();
    expect(screen.getByText('$1,834')).toBeTruthy();

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Category', 'Orders', 'Revenue', 'Avg. order']);
    expect(within(table).getByText('$2,700,000')).toBeTruthy();

    // one request per unique query, all pinned to v4 with the host's params
    expect(client.requests.map((r) => r.queryId).sort()).toEqual(['q_by_category', 'q_rev_by_month', 'q_rev_by_region', 'q_totals']);
    expect(client.requests.every((r) => r.version === 4 && r.params.dateRange === 'last_30d')).toBe(true);
  });

  it('isolates a failing query to its own widgets', async () => {
    const client = fakeClient(salesOverview, { q_totals: new Error('warehouse timeout') });
    render(<Dashboard id="dash_9f2a" token="t" client={client} />);
    expect(await screen.findByText('$2,250,001')).toBeTruthy();
    const alerts = await screen.findAllByText('warehouse timeout');
    expect(alerts).toHaveLength(2); // the two KPIs that share q_totals
  });

  it('refuses a dashboard from another major version, with a clear message', async () => {
    const client = fakeClient({ ...salesOverview, specVersion: '2.0' });
    render(<Dashboard id="dash_9f2a" token="t" client={client} />);
    expect(await screen.findByText('This dashboard can’t be displayed')).toBeTruthy();
    expect(screen.getByText(/needs a renderer for 2\.x/)).toBeTruthy();
  });

  it('renders a newer minor version degraded, with placeholders for unknown widgets', async () => {
    const doc = structuredClone(salesOverview) as any;
    doc.specVersion = '1.9'; // newer than this renderer supports
    doc.widgets.w_region.type = 'chord-diagram';
    const client = fakeClient(doc);
    render(<Dashboard id="dash_9f2a" token="t" client={client} />);
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText('Needs a newer renderer')).toBeTruthy();
    expect(await screen.findByText('$2,250,001')).toBeTruthy();
    expect(client.requests.map((r) => r.queryId)).not.toContain('q_rev_by_region');
  });

  it('shows not-found errors from the API', async () => {
    const { BIRequestError } = await import('../src');
    const client: DataClient = {
      getDashboard: async () => {
        throw new BIRequestError(404, 'not_found', 'Dashboard "nope" was not found.');
      },
      fetchQuery: async () => results.q_totals!,
    };
    render(<Dashboard id="nope" token="t" client={client} />);
    expect(await screen.findByText('Dashboard not found')).toBeTruthy();
  });

  it('loads code-split chart widgets', async () => {
    const client = fakeClient(salesOverview);
    const { container } = render(<Dashboard id="dash_9f2a" token="t" client={client} />);
    await waitFor(() => expect(container.querySelectorAll('[role="img"][aria-label^="Line chart"]').length).toBe(1));
    expect(container.querySelector('[role="img"][aria-label="Bar chart of Revenue by Region"]')).toBeTruthy();
  });
});

describe('formatValue', () => {
  const ctx = { locale: 'en-US', currency: 'USD' };
  it('formats by explicit format, column type and grain, in UTC', () => {
    expect(formatValue(1234567, 'currency', undefined, ctx)).toBe('$1,234,567');
    expect(formatValue(12.5, 'currency', undefined, ctx)).toBe('$12.50');
    expect(formatValue(1234567, 'currency', undefined, ctx, { compact: true })).toBe('$1.2M');
    expect(formatValue(0.1234, 'percent', undefined, ctx)).toBe('12.3%');
    expect(formatValue('2026-01-01', undefined, { name: 'm', type: 'time', grain: 'month' }, ctx)).toBe('Jan 2026');
    expect(formatValue('2026-04-01', undefined, { name: 'q', type: 'time', grain: 'quarter' }, ctx)).toBe('Q2 2026');
    expect(formatValue('2026-03-01', undefined, { name: 'd', type: 'time', grain: 'day' }, ctx)).toBe('Mar 1, 2026');
    expect(formatValue(null, 'currency', undefined, ctx)).toBe('—');
  });
});
