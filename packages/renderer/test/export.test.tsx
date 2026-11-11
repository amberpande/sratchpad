import type { QueryResult } from '@yourorg/bi-spec';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resultToCsv, safeFileName, standaloneSvg } from '../src/export/download';
import { DashboardToolbar, WidgetMenu } from '../src/export/WidgetMenu';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const result: QueryResult = {
  columns: [
    { name: 'region', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  rows: [
    { region: 'Europe, West', revenue: 2500 },
    { region: '=cmd|"/c calc"', revenue: null },
  ],
  truncated: false,
};

describe('exports', () => {
  it('writes RFC 4180 CSV and neutralizes spreadsheet formulas', () => {
    expect(resultToCsv(result)).toBe('region,revenue\r\n"Europe, West",2500\r\n"\'=cmd|""/c calc""",\r\n');
    expect(safeFileName('Revenue / region: 2026', 'csv')).toBe('Revenue_region_2026.csv');
  });

  it('the widget menu downloads the result as CSV', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x')) as never;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<WidgetMenu widgetId="w_region" widget={{ type: 'bar-chart', query: 'q', encoding: { x: 'region', y: 'revenue' }, options: { title: 'Revenue by region' } } as never} result={result} title="Revenue by region" />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Revenue by region' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download CSV' }));
    expect(click).toHaveBeenCalled();
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(created[0]!);
    });
    expect(text).toContain('"Europe, West",2500');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('explains when there is no chart to export as an image', async () => {
    render(<WidgetMenu widgetId="w" widget={{ type: 'table', query: 'q', options: {} } as never} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for w' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download PNG' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows nothing for text widgets or before data arrives', () => {
    const { container } = render(<WidgetMenu widgetId="w" widget={{ type: 'text', options: { text: 'hi' } } as never} result={result} />);
    expect(container.innerHTML).toBe('');
    const empty = render(<WidgetMenu widgetId="w" widget={{ type: 'table', query: 'q', options: {} } as never} />);
    expect(empty.container.innerHTML).toBe('');
  });

  it('inlines computed styles so a detached chart image keeps its colors', () => {
    const host = document.createElement('div');
    host.innerHTML = '<svg width="200" height="100"><rect style="fill: rgb(42, 120, 214)" width="10" height="10"></rect></svg>';
    document.body.appendChild(host);
    const { markup, width, height } = standaloneSvg(host.querySelector('svg')!);
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).toMatch(/fill:\s*rgb\(42, 120, 214\)/);
    expect([width, height]).toEqual([200, 100]);
    host.remove();
  });

  it('the dashboard toolbar prints (save as PDF from the print dialog)', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<DashboardToolbar dashboardId="d" title="T" version={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Print / PDF' }));
    expect(print).toHaveBeenCalled();
  });
});
