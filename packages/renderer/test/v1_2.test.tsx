import { validateDashboard, type QueryResult } from '@yourorg/bi-spec';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardView, type DataClient } from '../src';

afterEach(cleanup);

const result: QueryResult = {
  columns: [
    { name: 'region', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  rows: [
    { region: 'APAC', revenue: 1200 },
    { region: 'Europe', revenue: 2500 },
  ],
  truncated: false,
};

const client: DataClient = {
  getDashboard: () => Promise.reject(new Error('unused')),
  fetchQuery: async () => result,
};

function doc(options: Record<string, unknown>, style?: Record<string, unknown>, theme?: Record<string, unknown>) {
  const v = validateDashboard({
    specVersion: '1.2',
    id: 'd',
    title: 'Styled',
    ...(theme ? { theme } : {}),
    dataSources: { s: { type: 'sample', ref: 'orders' } },
    queries: { q: { source: 's', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] } },
    widgets: { w: { type: 'bar-chart', query: 'q', encoding: { x: 'region', y: 'revenue' }, options: { title: 'Revenue by region', ...options }, ...(style ? { style } : {}) } },
    layout: [{ i: 'w', x: 0, y: 0, w: 12, h: 5 }],
  });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.dashboard;
}

describe('spec 1.2 styling in the renderer', () => {
  it('applies the dashboard theme as scoped custom properties', () => {
    const { container } = render(
      <DashboardView
        dashboard={doc({}, undefined, { palette: ['#111111', '#222222'], accent: '#ff0000', background: '#0d1117', cardBackground: '#161b22', cardStyle: 'elevated', density: 'compact', radius: 2, font: 'mono' })}
        version={1}
        client={client}
      />,
    );
    const root = container.querySelector('.bi-root') as HTMLElement;
    expect(root.style.getPropertyValue('--bi-series-1')).toBe('#111111');
    expect(root.style.getPropertyValue('--bi-series-2')).toBe('#222222');
    expect(root.style.getPropertyValue('--bi-accent')).toBe('#ff0000');
    expect(root.style.getPropertyValue('--bi-page')).toBe('#0d1117');
    expect(root.style.getPropertyValue('--bi-surface')).toBe('#161b22');
    expect(root.style.getPropertyValue('--bi-radius')).toBe('2px');
    expect(root.style.getPropertyValue('--bi-font')).toContain('monospace');
    expect(root.dataset.biCard).toBe('elevated');
    expect(root.dataset.biDensity).toBe('compact');
    expect((container.querySelector('.bi-grid') as HTMLElement).style.gap).toBe('10px');
  });

  it('applies widget style to its card only, and can hide the title', () => {
    const { container } = render(
      <DashboardView dashboard={doc({}, { colors: ['#8250df'], background: '#fff8c5', emphasis: true, titleAlign: 'center', hideTitle: true })} version={1} client={client} />,
    );
    const card = container.querySelector('.bi-card') as HTMLElement;
    expect(card.style.getPropertyValue('--bi-series-1')).toBe('#8250df');
    expect(card.style.getPropertyValue('--bi-surface')).toBe('#fff8c5');
    expect(card.dataset.biEmphasis).toBe('');
    expect(card.dataset.biTitleAlign).toBe('center');
    expect(card.querySelector('.bi-card-title')!.textContent).toBe('');
    expect(card.getAttribute('aria-label')).toBe('Revenue by region'); // still named for screen readers
  });

  it('turns off gridlines, adds data labels and axis titles', async () => {
    const { container } = render(
      <DashboardView dashboard={doc({ showGrid: false, dataLabels: true, axis: { x: { label: 'Region' }, y: { label: 'Revenue ($)', min: 0, max: 3000 } } })} version={1} client={client} />,
    );
    await waitFor(() => expect(container.querySelector('.recharts-bar-rectangle')).toBeTruthy());
    expect(container.querySelector('.recharts-cartesian-grid')).toBeNull();
    expect(container.textContent).toContain('Region');
    expect(container.textContent).toContain('Revenue ($)');
    expect(container.querySelectorAll('.bi-data-label').length).toBeGreaterThan(0);
  });

  it('a theme mode wins over the host theme (the author chose colors for it)', () => {
    const { container } = render(<DashboardView dashboard={doc({}, undefined, { mode: 'dark', background: '#0d1117' })} version={1} client={client} theme="light" />);
    expect((container.querySelector('.bi-root') as HTMLElement).dataset.biTheme).toBe('dark');
    cleanup();
    const host = render(<DashboardView dashboard={doc({})} version={1} client={client} theme="light" />);
    expect((host.container.querySelector('.bi-root') as HTMLElement).dataset.biTheme).toBe('light');
  });

  it('keeps gridlines by default', async () => {
    const { container } = render(<DashboardView dashboard={doc({})} version={1} client={client} />);
    await waitFor(() => expect(container.querySelector('.recharts-bar-rectangle')).toBeTruthy());
    expect(container.querySelector('.recharts-cartesian-grid')).toBeTruthy();
    expect((container.querySelector('.bi-root') as HTMLElement).getAttribute('style')).toBeNull();
  });
});
