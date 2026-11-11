import { validateDashboard } from '@yourorg/bi-spec';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddParamButtons, DrillEditor, InteractionsSection, TabsSection } from '../src/components/InteractivityEditors';
import { compactLayout } from '../src/draft/layout';
import type { DraftSpec } from '../src/draft/types';
import { fields } from './helpers';

afterEach(cleanup);

const draft = (): DraftSpec => ({
  specVersion: '1.2',
  id: 'd',
  title: 'D',
  dataSources: { orders: { type: 'sample', ref: 'orders' } },
  queries: {
    q: { source: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] },
  },
  widgets: { w: { type: 'bar-chart', query: 'q', encoding: { x: 'region', y: 'revenue' }, options: {} } },
  layout: [{ i: 'w', x: 0, y: 0, w: 6, h: 4 }],
  params: {},
});
const noIssues = { errors: [], warnings: [], byWidget: new Map(), byParam: new Map(), dashboard: [] } as never;

/** Captures the draft each editor dispatches through `replace`. */
function capture() {
  const out: { draft?: DraftSpec } = {};
  const dispatch = vi.fn((action: { type: string; draft?: DraftSpec }) => {
    if (action.type === 'replace') out.draft = action.draft;
  });
  return { dispatch: dispatch as never, out };
}

const valid = (d: DraftSpec) => {
  const r = validateDashboard(d, { allowNewerMinor: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.dashboard;
};

describe('Studio interactivity editors', () => {
  it('turns on cross-filtering and raises specVersion', () => {
    const { dispatch, out } = capture();
    render(<InteractionsSection draft={draft()} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Click a chart to filter/ }));
    expect(out.draft).toMatchObject({ specVersion: '1.3', interactions: { crossFilter: true } });
    expect(valid(out.draft!).interactions).toEqual({ crossFilter: true });
  });

  it('adds tabs and moves a widget to one', () => {
    const { dispatch, out } = capture();
    const { rerender } = render(<TabsSection draft={draft()} dispatch={dispatch} issues={noIssues} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Tab' }));
    expect((out.draft as DraftSpec & { tabs: unknown[] }).tabs).toHaveLength(2);
    rerender(<TabsSection draft={out.draft!} dispatch={dispatch} issues={noIssues} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Tab of w' }), { target: { value: 'tab' } });
    expect(out.draft!.layout[0]).toMatchObject({ i: 'w', tab: 'tab' });
    expect(valid(out.draft!).layout[0]).toMatchObject({ tab: 'tab' });
  });

  it('adds each new param type as a valid draft', () => {
    for (const name of ['+ Multi-select', '+ Range', '+ Search', '+ Measure switch']) {
      const { dispatch, out } = capture();
      render(<AddParamButtons draft={draft()} dispatch={dispatch} fields={fields} />);
      fireEvent.click(screen.getByRole('button', { name }));
      expect(out.draft!.specVersion).toBe('1.3');
      valid(out.draft!);
      cleanup();
    }
  });

  it('adds a drill-down that starts at the query’s first dimension', () => {
    const { dispatch, out } = capture();
    render(<DrillEditor draft={draft()} widgetId="w" dispatch={dispatch} fields={fields} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add drill-down' }));
    const w = out.draft!.widgets.w as { drill?: { levels: Array<{ field: string }> } };
    expect(w.drill!.levels[0]!.field).toBe('region');
    expect(w.drill!.levels).toHaveLength(2);
    valid(out.draft!);
  });

  it('compacts each tab separately', () => {
    const out = compactLayout([
      { i: 'a', x: 0, y: 0, w: 12, h: 4 },
      { i: 'b', x: 0, y: 9, w: 12, h: 4, tab: 'x' } as never,
    ]);
    expect(out[1]).toMatchObject({ i: 'b', y: 0 });
  });
});
