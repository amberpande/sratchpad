import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Viewer } from '../src/Viewer';

afterEach(cleanup);

const TOKEN = 'bis_0123456789ab_' + 'x'.repeat(43);
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });

const spec = {
  specVersion: '1.3',
  id: 'dash_p',
  title: 'Params',
  dataSources: { s: { type: 'sample', ref: 'orders' } },
  queries: {
    q_regions: { source: 's', dimensions: [{ field: 'region' }], measures: [{ field: '*', agg: 'count', as: 'n' }] },
    q_cat: { source: 's', dimensions: [{ field: 'category' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
  },
  widgets: { w: { type: 'table', query: 'q_cat', options: {} } },
  layout: [{ i: 'w', x: 0, y: 0, w: 12, h: 4 }],
  params: {
    regions: { type: 'multiselect', label: 'Regions', field: 'region', optionsQuery: { query: 'q_regions', field: 'region' }, bind: ['q_cat.filters'] },
    amount: { type: 'range', label: 'Amount', field: 'amount', bind: ['q_cat.filters'] },
    q: { type: 'search', label: 'Category', field: 'category', bind: ['q_cat.filters'] },
    metric: { type: 'measure', label: 'Metric', as: 'revenue', options: [{ value: 'rev', label: 'Revenue', field: 'amount', agg: 'sum' }, { value: 'orders', label: 'Orders', field: '*', agg: 'count' }], default: 'rev', bind: ['q_cat.measures'] },
  },
};

describe('viewer 1.3 param controls', () => {
  it('renders multiselect (options from a saved query), range, search and measure controls', async () => {
    const bodies: Array<{ queries: unknown[]; params: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/share')) return json({ share: { id: 'x', dashboardId: 'dash_p', audience: 'viewer', label: 'L' }, dashboard: { id: 'dash_p', title: 'Params', latestVersion: 1 } });
      if (url.endsWith('/dash_p')) return json({ id: 'dash_p', version: 1, title: 'Params', specVersion: '1.3', createdAt: '', createdBy: 'd', spec });
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      const lines = (body.queries as string[]).map((id) =>
        JSON.stringify({ id, ok: true, result: { columns: [], rows: id === 'q_regions' ? [{ region: 'Europe', n: 1 }, { region: 'APAC', n: 2 }] : [], truncated: false } }),
      );
      return new Response(lines.join('\n') + '\n');
    });
    render(<Viewer hash={`#token=${TOKEN}`} fetch={fetch as unknown as typeof globalThis.fetch} />);
    const regions = (await screen.findByRole('listbox', { name: 'Regions' })) as HTMLSelectElement;
    await waitFor(() => expect(regions.options.length).toBe(2));
    expect([...regions.options].map((o) => o.textContent)).toEqual(['Europe', 'APAC']);

    regions.options[1]!.selected = true;
    fireEvent.change(regions);
    await waitFor(() => expect(bodies.some((b) => JSON.stringify(b.params.regions) === '["APAC"]')).toBe(true));

    fireEvent.change(screen.getByLabelText('Amount from'), { target: { value: '100' } });
    await waitFor(() => expect(bodies.some((b) => JSON.stringify(b.params.amount) === '[100,null]')).toBe(true));

    fireEvent.change(screen.getByRole('combobox', { name: 'Metric' }), { target: { value: 'orders' } });
    await waitFor(() => expect(bodies.some((b) => b.params.metric === 'orders')).toBe(true));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Category' }), { target: { value: 'soft' } });
    await waitFor(() => expect(bodies.some((b) => b.params.q === 'soft')).toBe(true), { timeout: 2000 });
  });
});
