import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { Viewer } from '../src/Viewer';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });

// Regression: without a `fetch` prop (the real page), the viewer used to rebuild the SDK's client on
// every render and reload forever, so the page never showed the dashboard.
it('loads once and stays loaded when using the global fetch', async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/v1/share')) return json({ share: { id: 'x', dashboardId: 'dash_9f2a', audience: 'viewer', label: 'L' }, dashboard: { id: 'dash_9f2a', title: 'Sales overview', latestVersion: 1 } });
      if (url.endsWith('/dash_9f2a')) return json({ id: 'dash_9f2a', version: 1, title: 'Sales overview', specVersion: '1.0', createdAt: '', createdBy: 'd', spec: salesOverview });
      const q = JSON.parse(String(init!.body)).queries as string[];
      return new Response(q.map((id) => JSON.stringify({ id, ok: true, result: { columns: [], rows: [], truncated: false } })).join('\n') + '\n');
    }),
  );
  render(<Viewer hash={'#token=bis_0123456789ab_' + 'x'.repeat(43)} />);
  await screen.findByRole('heading', { name: 'Sales overview' });
  await waitFor(() => expect(calls.some((u) => u.endsWith('/data'))).toBe(true));
  await new Promise((r) => setTimeout(r, 300));
  expect(calls.filter((u) => u.endsWith('/v1/share'))).toHaveLength(1);
  expect(calls.filter((u) => u.endsWith('/dash_9f2a'))).toHaveLength(1);
  expect(calls.filter((u) => u.endsWith('/data')).length).toBeLessThanOrEqual(2);
});
