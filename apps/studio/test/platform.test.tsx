import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioApi } from '../src/api/studioApi';
import { DashboardList } from '../src/components/DashboardList';
import { PlatformActions } from '../src/components/platform/PlatformActions';
import { emptyDraft } from '../src/draft/json';

afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeApi(handler: (method: string, path: string, body: unknown) => Response | undefined) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('/bi-api', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    return handler(method, path, body) ?? json({ error: { code: 'not_found', message: 'no' } }, 404);
  });
  return { api: new StudioApi({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch }), calls };
}

const status = (role = 'editor', email = true) => json({ me: { subject: 'dev-a', teamId: 'team-a', role }, email, scheduler: true });

const draft = () => ({
  ...emptyDraft('dash_x', 'X'),
  dataSources: { s: { type: 'sample', ref: 'orders' } },
  queries: { q_rev: { source: 's', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum' as const, as: 'revenue' }] } },
  widgets: { w_bar: { type: 'bar-chart', query: 'q_rev', encoding: { x: 'region', y: 'revenue' }, options: { title: 'Revenue' } } },
});

describe('PlatformActions', () => {
  it('hides itself on servers without platform routes', async () => {
    const { api } = fakeApi(() => undefined);
    const { container } = render(<PlatformActions api={api} draft={draft()} savedVersion={1} dirty={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('viewers see Comments and Metrics only; dashboard features wait for a save', async () => {
    const { api } = fakeApi((m, p) => (p === '/v1/platform' ? status('viewer') : undefined));
    render(<PlatformActions api={api} draft={draft()} savedVersion={0} dirty />);
    const comments = (await screen.findByRole('button', { name: 'Comments' })) as HTMLButtonElement;
    expect(comments.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Schedule' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Metrics' })).toBeTruthy();
  });

  it('posts a comment pinned to a widget', async () => {
    const comments: unknown[] = [];
    const { api, calls } = fakeApi((m, p, body) => {
      if (p === '/v1/platform') return status();
      if (p === '/v1/dashboards/dash_x/comments' && m === 'GET') return json({ comments });
      if (p === '/v1/dashboards/dash_x/comments' && m === 'POST') {
        const c = { id: 'dash_x:1', dashboardId: 'dash_x', author: 'dev-a', createdAt: '2026-11-11T10:00:00Z', ...(body as object) };
        comments.push(c);
        return json({ comment: c }, 201);
      }
      return undefined;
    });
    render(<PlatformActions api={api} draft={draft()} savedVersion={2} dirty={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Comments' }));
    const dialog = await screen.findByRole('dialog', { name: 'Comments' });
    expect(await within(dialog).findByText('No comments yet.')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New comment' }), { target: { value: 'EU looks low' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Comment on widget' }), { target: { value: 'w_bar' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Comment' }));
    expect(await within(dialog).findByText('EU looks low')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ body: 'EU looks low', widgetId: 'w_bar' });
  });

  it('creates an email subscription and warns when email is not configured', async () => {
    const { api, calls } = fakeApi((m, p, body) => {
      if (p === '/v1/platform') return status('editor', false);
      if (p.startsWith('/v1/subscriptions?')) return json({ subscriptions: [] });
      if (p === '/v1/refresh') return json({ schedules: [] });
      if (p === '/v1/subscriptions' && m === 'POST') return json({ subscription: { id: 'sub_1', owner: 'dev-a', nextRunAt: '2026-11-12T07:00:00Z', ...(body as object) } }, 201);
      return undefined;
    });
    render(<PlatformActions api={api} draft={draft()} savedVersion={2} dirty={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule' });
    expect(within(dialog).getByText(/Email is not configured/)).toBeTruthy();
    fireEvent.change(within(dialog).getByPlaceholderText(/ana@example.com/), { target: { value: 'a@example.com; b@example.com' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Revenue \(w_bar\)/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create subscription' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/v1/subscriptions')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ dashboardId: 'dash_x', recipients: ['a@example.com', 'b@example.com'], widgets: ['w_bar'], schedule: { frequency: 'daily', time: '08:00' } });
  });
});

describe('DashboardList favorites and usage', () => {
  it('stars favorites (shown first) and sorts by views', async () => {
    const { api, calls } = fakeApi((m, p) => {
      if (p === '/v1/dashboards') return json({ dashboards: [
        { id: 'a', title: 'Alpha', latestVersion: 1, updatedAt: '2026-11-10T00:00:00Z' },
        { id: 'b', title: 'Beta', latestVersion: 1, updatedAt: '2026-11-09T00:00:00Z' },
      ] });
      if (p === '/v1/favorites') return json({ dashboards: [] });
      if (p.startsWith('/v1/usage')) return json({ days: 30, dashboards: [{ dashboardId: 'b', views: 12 }, { dashboardId: 'a', views: 3 }] });
      if (p.startsWith('/v1/favorites/') && m === 'PUT') return new Response(null, { status: 204 });
      return undefined;
    });
    render(<DashboardList api={api} onOpen={() => {}} onCreate={() => {}} />);
    expect(await screen.findByText(/12 views/)).toBeTruthy();
    const titles = () => screen.getAllByRole('listitem').map((li) => li.querySelector('strong')!.textContent);
    expect(titles()).toEqual(['Alpha', 'Beta']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort dashboards' }), { target: { value: 'views' } });
    expect(titles()).toEqual(['Beta', 'Alpha']);
    fireEvent.click(screen.getByRole('button', { name: 'Add Alpha to favorites' }));
    expect(titles()).toEqual(['Alpha', 'Beta']);
    expect(screen.getByRole('button', { name: 'Remove Alpha from favorites' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/v1/favorites/a')).toBe(true));
  });
});
