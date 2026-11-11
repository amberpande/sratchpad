import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioApi } from '../src/api/studioApi';
import { Studio } from '../src/components/Studio';
import { emptyDraft } from '../src/draft/json';

afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function backend(chat: (body: { draft: { title: string }; messages: Array<{ role: string; content: string }>; selectedWidgetId?: string }) => Promise<Response> | Response) {
  const chats: unknown[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/assistant')) return json({ enabled: true, model: 'claude-opus-5-5' });
    if (url.endsWith('/v1/assistant/chat')) {
      const body = JSON.parse(String(init!.body));
      chats.push(body);
      return chat(body);
    }
    return json({ error: { code: 'not_found', message: 'no' } }, 404);
  });
  return { api: new StudioApi({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch }), chats };
}

describe('Studio assistant panel', () => {
  it('applies the assistant’s edit to the draft as one undoable step', async () => {
    const { api, chats } = backend(({ draft }) =>
      json({ reply: 'Renamed it and gave it a dark theme.', changed: true, changes: ['Renamed to Exec view', 'Dark theme'], issues: [], draft: { ...draft, title: 'Exec view', specVersion: '1.2', theme: { background: '#0d1117' } } }),
    );
    render(<Studio api={api} draft={emptyDraft('dash_x', 'Draft')} saved={null} latestVersion={0} onExit={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Assistant' }));
    const box = await screen.findByRole('textbox', { name: 'Message the assistant' });
    fireEvent.change(box, { target: { value: 'Call it Exec view, dark theme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Renamed it and gave it a dark theme.')).toBeTruthy();
    expect(screen.getByText('Dark theme')).toBeTruthy();
    const title = screen.getByRole('textbox', { name: 'Dashboard title' }) as HTMLInputElement;
    expect(title.value).toBe('Exec view');
    expect(chats[0]).toMatchObject({ draft: { id: 'dash_x', title: 'Draft' }, messages: [{ role: 'user', content: 'Call it Exec view, dark theme' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Undo this change' }));
    await waitFor(() => expect(title.value).toBe('Draft'));
    expect(screen.getByText(/\(undone\)/)).toBeTruthy();
  });

  it('never overwrites edits made while it was working', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api } = backend(async ({ draft }) => {
      await gate;
      return json({ reply: 'Renamed.', changed: true, changes: ['Renamed'], issues: [], draft: { ...draft, title: 'From assistant' } });
    });
    render(<Studio api={api} draft={emptyDraft('dash_x', 'Draft')} saved={null} latestVersion={0} onExit={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Assistant' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message the assistant' }), { target: { value: 'rename' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // The developer keeps editing meanwhile.
    fireEvent.change(screen.getByRole('textbox', { name: 'Dashboard title' }), { target: { value: 'Mine' } });
    release();
    expect(await screen.findByText(/didn’t apply this/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Dashboard title' }) as HTMLInputElement).value).toBe('Mine');
  });

  it('explains when the server has no assistant', async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith('/v1/assistant') ? json({ enabled: false }) : json({ error: { code: 'not_found', message: 'no' } }, 404)));
    const api = new StudioApi({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch });
    render(<Studio api={api} draft={emptyDraft('dash_x', 'Draft')} saved={null} latestVersion={0} onExit={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Assistant' }));
    const panel = screen.getByRole('complementary', { name: 'Assistant' });
    expect(await within(panel).findByText(/isn’t enabled on this server/)).toBeTruthy();
  });
});
