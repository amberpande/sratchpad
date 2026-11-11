/**
 * Phase 1 exit criterion, end to end and in-process:
 * the hand-written JSON is saved to the store, fetched by the SDK, its queries run through the
 * batched data endpoint, and the widgets render, with no host-specific code involved.
 */
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, seedExamples, StaticTokenVerifier } from '@yourorg/bi-api';
import { BIProvider, Dashboard } from '@yourorg/bi-renderer';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date('2026-11-09T15:30:00Z');
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const store = new MemoryDashboardStore();
  await seedExamples(store, { teamId: 'team-a', log: () => {} });
  const app = createApp({ store, auth: StaticTokenVerifier.parse(DEV_TOKENS), engines: defaultEngines(() => NOW), now: () => NOW });
  // Route the SDK's fetch straight into the API (as a host app's /bi-api proxy would).
  fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://host.local');
    return app.request(url.pathname.replace(/^\/bi-api/, '') + url.search, init);
  });
});
afterEach(cleanup);

/** Two structurally different hosts embedding the same dashboard. */
function HostA() {
  return (
    <main>
      <nav>Ops console</nav>
      <Dashboard id="dash_9f2a" token="dev-token-team-a" fetch={fetchSpy as typeof fetch} />
    </main>
  );
}
function HostB() {
  return (
    <BIProvider apiUrl="/bi-api" fetch={fetchSpy as typeof fetch}>
      <div className="portal">
        <header>Sales portal</header>
        <section>
          <Dashboard id="dash_9f2a" token={() => 'dev-token-team-a'} showHeader={false} />
        </section>
      </div>
    </BIProvider>
  );
}

async function renderedValues(ui: JSX.Element) {
  const { container, unmount } = render(ui);
  await screen.findByText('Total revenue');
  const table = await screen.findByRole('table');
  await within(table).findAllByRole('row');
  // wait until every KPI has its number
  await vi.waitFor(() => expect(container.querySelectorAll('.bi-kpi-value')).toHaveLength(3));
  const kpis = [...container.querySelectorAll('.bi-kpi-value')].map((el) => el.textContent);
  const rows = within(table)
    .getAllByRole('row')
    .map((r) => r.textContent);
  const cards = [...container.querySelectorAll('[data-widget-id]')].map((el) => [
    el.getAttribute('data-widget-id'),
    (el as HTMLElement).style.gridColumn,
    (el as HTMLElement).style.gridRow,
  ]);
  unmount();
  return { kpis, rows, cards };
}

describe('Phase 1: the contract renders', () => {
  it('renders the same JSON identically in two different host apps', async () => {
    const a = await renderedValues(<HostA />);
    const dataCallsA = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/data')).length;
    const b = await renderedValues(<HostB />);

    expect(a.kpis).toHaveLength(3);
    expect(a.kpis.every((k) => k && k !== '—')).toBe(true);
    expect(a.rows.length).toBeGreaterThan(2);
    expect(b).toEqual(a);
    expect(a.cards).toContainEqual(['w_line', '1 / span 8', '3 / span 5']);
    // one GET for the spec + one batched data round-trip per dashboard load
    expect(dataCallsA).toBe(1);
  });

  it('host-controlled params re-filter every bound widget', async () => {
    const wide = await renderedValues(<Dashboard id="dash_9f2a" token="dev-token-team-a" fetch={fetchSpy as typeof fetch} />);
    const narrow = await renderedValues(
      <Dashboard id="dash_9f2a" token="dev-token-team-a" fetch={fetchSpy as typeof fetch} params={{ dateRange: 'last_30d' }} />,
    );
    expect(narrow.kpis[1]).not.toBe(wide.kpis[1]); // paid orders count shrinks
    expect(narrow.rows).not.toEqual(wide.rows);
  });

  it('another team cannot embed this dashboard', async () => {
    render(<Dashboard id="dash_9f2a" token="dev-token-team-b" fetch={fetchSpy as typeof fetch} />);
    expect(await screen.findByText('Dashboard not found')).toBeTruthy();
  });
});
