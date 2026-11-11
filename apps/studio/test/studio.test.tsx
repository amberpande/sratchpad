import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioApi } from '../src/api/studioApi';
import { Studio } from '../src/components/Studio';
import { emptyDraft } from '../src/draft/json';

afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = () => json({ error: { code: 'not_found', message: 'No such route.' } }, 404);

/** A Phase 1 backend: dashboards only; every Phase 2/4 route 404s. */
function phase1Backend(opts: { conflictAt?: number } = {}) {
  const puts: Array<{ spec: { id: string }; expectedVersion: number }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'PUT' && url.includes('/v1/dashboards/')) {
      const body = JSON.parse(String(init!.body)) as { spec: { id: string }; expectedVersion: number };
      puts.push(body);
      if (opts.conflictAt !== undefined && body.expectedVersion !== opts.conflictAt) {
        return json({ error: { code: 'version_conflict', message: 'stale', details: { currentVersion: opts.conflictAt } } }, 409);
      }
      const version = body.expectedVersion + 1;
      return json({ id: body.spec.id, version, title: 'x', specVersion: '1.1', createdAt: '', createdBy: 'dev', spec: body.spec, warnings: [] }, version === 1 ? 201 : 200);
    }
    return notFound();
  });
  return { api: new StudioApi({ apiUrl: '/bi-api', token: 't', fetch: fetch as unknown as typeof globalThis.fetch }), fetch, puts };
}

describe('Studio (against a Phase 1 backend)', () => {
  it('builds a dashboard from the palette, validates continuously and saves with expectedVersion 0', async () => {
    const { api, puts } = phase1Backend();
    render(<Studio api={api} draft={emptyDraft('dash_new', 'New one')} saved={null} latestVersion={0} onExit={() => {}} />);

    // Falls back to the sample source and built-in fields when /v1/sources and the profiler 404.
    expect(await screen.findByText(/can’t list sources yet/)).toBeTruthy();
    expect(await screen.findByText('order_date')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Line chart$/ }));
    // The new widget is selected and its query shows in the inspector.
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    await waitFor(() => expect(within(inspector).getByText('q_line-chart')).toBeTruthy());
    expect(screen.getByRole('button', { name: /^Valid/ })).toBeTruthy();

    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText('Saved v1.');
    expect(puts[0]!.expectedVersion).toBe(0);
    expect(puts[0]!.spec).toMatchObject({ id: 'dash_new', widgets: { 'w_line-chart': { type: 'line-chart' } } });
    expect(screen.getByText('Saved · v1')).toBeTruthy();

    // Without the preview route, the canvas says so and uses saved data.
    expect(await screen.findByText(/Live preview isn’t available/)).toBeTruthy();
  });

  it('blocks Save while invalid and shows the error next to the field', async () => {
    const { api } = phase1Backend();
    render(<Studio api={api} draft={emptyDraft('dash_new', 'New one')} saved={null} latestVersion={0} onExit={() => {}} />);
    await screen.findByText('order_date');
    fireEvent.click(screen.getByRole('button', { name: /^KPI$/ }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    // Remove the KPI's only measure: the query becomes empty and the value slot dangles.
    fireEvent.click(await within(inspector).findByRole('button', { name: 'Remove amount' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /error/ })).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(inspector).getByText(/needs at least one dimension or measure/)).toBeTruthy();
  });

  it('explains a 409 conflict and offers to reload or save on top', async () => {
    const { api, puts } = phase1Backend({ conflictAt: 4 });
    const draft = emptyDraft('dash_x', 'X');
    render(<Studio api={api} draft={{ ...draft, title: 'X edited' }} saved={{ id: 'dash_x', version: 2, spec: draft }} latestVersion={2} onExit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Someone saved v4 while you were editing v2/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reload latest/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save mine as v5' }));
    await screen.findByText('Saved v5.');
    expect(puts.map((p) => p.expectedVersion)).toEqual([2, 4]);
  });

  it('two-way JSON: edits in the text apply to the draft', async () => {
    const { api } = phase1Backend();
    render(<Studio api={api} draft={emptyDraft('dash_new', 'New one')} saved={null} latestVersion={0} onExit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    const text = screen.getByRole('textbox', { name: 'Dashboard JSON' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: text.value.replace('"New one"', '"Renamed in JSON"') } });
    expect((screen.getByRole('textbox', { name: 'Dashboard title' }) as HTMLInputElement).value).toBe('Renamed in JSON');
    fireEvent.change(text, { target: { value: '{ broken' } });
    expect(screen.getByText(/Not valid JSON/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Dashboard title' }) as HTMLInputElement).value).toBe('Renamed in JSON');
  });

  it('disables "Suggest a dashboard" when the recommendations route is missing', async () => {
    const { api } = phase1Backend();
    render(<Studio api={api} draft={emptyDraft('dash_new', 'New one')} saved={null} latestVersion={0} onExit={() => {}} />);
    const button = (await screen.findByRole('button', { name: 'Suggest a dashboard' })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByText(/Suggestions aren’t available on this backend yet/)).toBeTruthy();
    expect(button.disabled).toBe(true);
  });
});
