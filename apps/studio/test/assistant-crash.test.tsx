import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioApi } from '../src/api/studioApi';
import { PanelBoundary } from '../src/components/PanelBoundary';
import { Studio } from '../src/components/Studio';
import { emptyDraft } from '../src/draft/json';

const original = Element.prototype.scrollIntoView;
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = original;
  vi.restoreAllMocks();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

describe('assistant panel in a real-browser-like environment', () => {
  // Regression: Chrome's scrollIntoView returns a Promise; an effect that returned it crashed React
  // ("destroy is not a function") and blanked the whole Studio when a reply arrived.
  it('survives scrollIntoView returning a Promise across several replies', async () => {
    Element.prototype.scrollIntoView = function () {
      return Promise.resolve() as unknown as void;
    };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/assistant')) return json({ enabled: true, model: 'llama3.2 (ollama)' });
      if (url.endsWith('/v1/assistant/chat')) {
        const body = JSON.parse(String(init!.body));
        return json({ reply: `Done #${body.messages.length}.`, changed: false, changes: [], issues: [], draft: body.draft });
      }
      return json({ error: { code: 'not_found', message: 'no' } }, 404);
    });
    const api = new StudioApi({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch });
    render(<Studio api={api} draft={emptyDraft('d', 'D')} saved={null} latestVersion={0} onExit={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Assistant' }));
    for (const text of ['first', 'second']) {
      fireEvent.change(await screen.findByRole('textbox', { name: 'Message the assistant' }), { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText(new RegExp(`Done #${text === 'first' ? 1 : 3}`));
    }
    // Switching tabs unmounts nothing, but re-render cleanups ran without throwing.
    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }));
    expect(screen.getByRole('textbox', { name: 'Dashboard title' })).toBeTruthy();
  });
});

describe('PanelBoundary', () => {
  it('keeps a panel crash local and offers a retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    function Boom() {
      if (fail) throw new Error('kaboom');
      return <p>recovered</p>;
    }
    render(
      <div>
        <p>rest of the studio</p>
        <PanelBoundary name="assistant">
          <Boom />
        </PanelBoundary>
      </div>,
    );
    expect(screen.getByText('rest of the studio')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/assistant panel hit an error: kaboom/);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeTruthy();
  });
});
