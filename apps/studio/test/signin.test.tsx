import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Studio sign-in (stopgap until SSO)', () => {
  it('a 401 sends the user to sign-in; a valid token is kept for the tab', async () => {
    const valid = 'prod-editor-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get('Authorization');
        return auth === `Bearer ${valid}` ? json({ dashboards: [] }) : json({ error: { code: 'unauthorized', message: 'no' } }, 401);
      }),
    );
    render(<App />); // dev build: starts with the dev token, which this backend rejects
    expect(await screen.findByText(/Your session ended/)).toBeTruthy();

    const input = screen.getByLabelText('Access token');
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That token isn’t valid.')).toBeTruthy();

    fireEvent.change(input, { target: { value: valid } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.queryByLabelText('Access token')).toBeNull());
    expect(sessionStorage.getItem('sratchpad.token')).toBe(valid);
  });
});
