import type { Share } from '@yourorg/bi-spec';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioApi } from '../src/api/studioApi';
import { appSnippets } from '../src/components/ShareDialog';
import { Studio } from '../src/components/Studio';
import { emptyDraft } from '../src/draft/json';

afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Share dialog', () => {
  it('creates a viewer link shown once, lists shares and revokes', async () => {
    const shares: Share[] = [];
    const posts: unknown[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/v1/dashboards/dash_x/shares') && method === 'GET') return json({ shares });
      if (url.endsWith('/v1/dashboards/dash_x/shares') && method === 'POST') {
        const body = JSON.parse(String(init!.body));
        posts.push(body);
        const share: Share = { id: 'abc123abc123', dashboardId: 'dash_x', audience: body.audience, label: body.label ?? 'Viewer link', createdBy: 'dev-a', createdAt: '2026-11-10T00:00:00Z', ...(body.version ? { version: body.version } : {}) };
        shares.unshift(share);
        return json({ share, token: 'bis_abc123abc123_secret', viewerUrl: 'http://localhost:5176/#token=bis_abc123abc123_secret' }, 201);
      }
      if (url.endsWith('/v1/dashboards/dash_x/shares/abc123abc123') && method === 'DELETE') {
        shares[0] = { ...shares[0]!, revokedAt: '2026-11-10T01:00:00Z' };
        return new Response(null, { status: 204 });
      }
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    });
    const api = new StudioApi({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch });
    const draft = emptyDraft('dash_x', 'X');
    render(<Studio api={api} draft={draft} saved={{ id: 'dash_x', version: 3, spec: draft }} latestVersion={3} onExit={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share dashboard' });
    expect(await within(dialog).findByText('Not shared yet.')).toBeTruthy();
    fireEvent.change(within(dialog).getByPlaceholderText(/Exec weekly review/), { target: { value: 'Exec team' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Version' }), { target: { value: 'pin' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create viewer link' }));

    const link = (await within(dialog).findByRole('textbox', { name: 'Viewer link' })) as HTMLInputElement;
    expect(link.value).toBe('http://localhost:5176/#token=bis_abc123abc123_secret');
    expect(posts[0]).toEqual({ audience: 'viewer', label: 'Exec team', version: 3, expiresInDays: 30 });
    expect(await within(dialog).findByText('Exec team')).toBeTruthy();

    // Done hides the secret for good.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(within(dialog).queryByRole('textbox', { name: 'Viewer link' })).toBeNull();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(dialog).getByText('revoked')).toBeTruthy());
  });

  it('Share is disabled until the dashboard is saved', () => {
    const api = new StudioApi({ apiUrl: '/bi-api', token: 't', fetch: vi.fn(async () => json({}, 404)) as unknown as typeof globalThis.fetch });
    render(<Studio api={api} draft={emptyDraft('dash_new', 'New')} saved={null} latestVersion={0} onExit={() => {}} />);
    expect((screen.getByRole('button', { name: 'Share' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('app snippets show how to read and parse the JSON', () => {
    const s = appSnippets('https://bi.example.com/api', 'dash_x', 'bis_t').map(([, c]) => c).join('\n');
    expect(s).toContain('https://bi.example.com/api/v1/dashboards/dash_x');
    expect(s).toContain('validateDashboard(spec)');
    expect(s).toContain('<Dashboard id="dash_x"');
  });
});
