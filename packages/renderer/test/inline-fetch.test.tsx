import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { Dashboard } from '../src';

afterEach(cleanup);

// Regression: an inline fetch prop (a new function each render) used to rebuild the data client and
// reload the dashboard on every parent render, which could loop forever.
it('does not reload when the host re-renders with a new inline fetch', async () => {
  const calls: string[] = [];
  const transport = async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).endsWith('/dash_9f2a')) {
      return new Response(JSON.stringify({ id: 'dash_9f2a', version: 1, title: 'Sales overview', specVersion: '1.0', createdAt: '', createdBy: 'd', spec: salesOverview }));
    }
    const q = JSON.parse(String(init!.body)).queries as string[];
    return new Response(q.map((id) => JSON.stringify({ id, ok: true, result: { columns: [], rows: [], truncated: false } })).join('\n') + '\n');
  };
  function Host() {
    const [n, setN] = useState(0);
    useEffect(() => {
      if (n < 5) setTimeout(() => setN(n + 1), 10);
    }, [n]);
    return <Dashboard id="dash_9f2a" token="t" fetch={(...a) => transport(...(a as [string, RequestInit]))} onLoad={() => setN((x) => x)} />;
  }
  render(<Host />);
  await screen.findByText('Sales overview');
  await new Promise((r) => setTimeout(r, 150));
  await waitFor(() => expect(calls.some((u) => u.endsWith('/data'))).toBe(true));
  expect(calls.filter((u) => u.endsWith('/dash_9f2a'))).toHaveLength(1);
});
