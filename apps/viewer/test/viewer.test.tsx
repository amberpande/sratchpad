import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { readToken, Viewer } from '../src/Viewer';

afterEach(cleanup);

const TOKEN = 'bis_0123456789ab_' + 'x'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function backend(introStatus = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    if (url.endsWith('/v1/share')) {
      return introStatus === 200
        ? json({ share: { id: '0123456789ab', dashboardId: 'dash_9f2a', audience: 'viewer', label: 'Exec', expiresAt: '2026-12-09T00:00:00Z' }, dashboard: { id: 'dash_9f2a', title: 'Sales overview', latestVersion: 1 } })
        : json({ error: { code: 'unauthorized', message: 'no' } }, introStatus);
    }
    if (url.endsWith('/v1/dashboards/dash_9f2a')) {
      return json({ id: 'dash_9f2a', version: 1, title: 'Sales overview', specVersion: '1.0', createdAt: '', createdBy: 'dev', spec: salesOverview });
    }
    if (url.endsWith('/data')) {
      const body = JSON.parse(String(init!.body)) as { queries: string[] };
      const lines = body.queries.map((id) => JSON.stringify({ id, ok: true, result: { columns: [], rows: [], truncated: false } }));
      return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    return json({ error: { code: 'not_found', message: 'no' } }, 404);
  });
}

describe('viewer', () => {
  it('reads only well-formed share tokens from the fragment', () => {
    expect(readToken(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(readToken('#token=dev-token-team-a')).toBeNull();
    expect(readToken('')).toBeNull();
  });

  it('opens the shared dashboard read-only, with its param controls', async () => {
    const fetch = backend();
    render(<Viewer hash={`#token=${TOKEN}`} fetch={fetch as unknown as typeof globalThis.fetch} />);
    expect(await screen.findByRole('heading', { name: 'Sales overview' })).toBeTruthy();
    expect(screen.getByText(/Read-only · link expires/)).toBeTruthy();
    const range = (await screen.findByRole('combobox', { name: 'Date range' })) as HTMLSelectElement;
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/data'))).toBe(true));
    fireEvent.change(range, { target: { value: 'last_30d' } });
    await waitFor(() => {
      const bodies = fetch.mock.calls.filter(([u]) => String(u).endsWith('/data')).map(([, i]) => JSON.parse(String((i as RequestInit).body)));
      expect(bodies.some((b) => b.params?.dateRange === 'last_30d')).toBe(true);
    });
  });

  it('explains missing, expired and revoked links', async () => {
    render(<Viewer hash="" fetch={backend() as unknown as typeof globalThis.fetch} />);
    expect(screen.getByRole('alert').textContent).toMatch(/incomplete/);
    cleanup();
    render(<Viewer hash={`#token=${TOKEN}`} fetch={backend(401) as unknown as typeof globalThis.fetch} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer works/);
  });
});
