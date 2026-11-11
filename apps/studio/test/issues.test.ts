import { validateDashboard } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { indexIssues, issuesAt } from '../src/draft/issues';
import { buildRenderable } from '../src/draft/renderable';
import { add, apply, blank } from './helpers';

function setup() {
  let { draft } = add(blank(), 'line-chart');
  draft = add(draft, 'kpi').draft;
  draft = apply(draft, { type: 'duplicateWidget', id: 'w_kpi', newId: 'w_kpi_copy' });
  return draft;
}

describe('validation-error mapping', () => {
  it('maps encoding, query, layout, param and document errors to what the author sees', () => {
    let draft = setup();
    draft = apply(
      draft,
      { type: 'setWidgetField', id: 'w_line-chart', container: 'encoding', key: 'y', value: 'nope' },
      { type: 'updateQuery', id: 'q_kpi', query: { source: 'orders', measures: [{ field: 'amount', agg: 'avg', as: 'x' }, { field: 'qty', agg: 'sum', as: 'x' }] } },
      { type: 'setParam', id: 'dateRange', param: { type: 'daterange', bind: ['missing.filters'] } },
    );
    draft = { ...draft, layout: draft.layout.map((it) => (it.i === 'w_kpi' ? { ...it, x: 11, w: 3 } : it)) };
    const index = indexIssues(validateDashboard(draft), draft);

    const line = index.byWidget.get('w_line-chart')!;
    expect(issuesAt(line, 'encoding.y').map((i) => i.code)).toEqual(['unknown_column']);

    // A query error shows on every widget that reads the query.
    for (const id of ['w_kpi', 'w_kpi_copy']) {
      expect(issuesAt(index.byWidget.get(id), 'query').some((i) => i.code === 'duplicate_column')).toBe(true);
    }
    // layout.N resolves to the widget placed at N.
    expect(issuesAt(index.byWidget.get('w_kpi'), 'layout').map((i) => i.code)).toEqual(['out_of_bounds']);
    expect(index.byParam.get('dateRange')!.map((i) => i.local)).toEqual(['bind.0']);
    expect(index.dashboard).toEqual([]);
    expect(index.errors.every((i) => i.severity === 'error')).toBe(true);
  });

  it('maps document-level errors to the dashboard', () => {
    const draft = apply(setup(), { type: 'setMeta', title: '' });
    const index = indexIssues(validateDashboard(draft), draft);
    expect(index.dashboard.map((i) => [i.path, i.local])).toEqual([['title', 'title']]);
    expect(index.byWidget.size).toBe(0);
  });

  it('keeps warnings separate and non-blocking', () => {
    let draft = setup();
    draft = { ...draft, layout: draft.layout.map((it) => ({ ...it, x: 0, y: 0 })) };
    const result = validateDashboard(draft);
    expect(result.ok).toBe(true);
    const index = indexIssues(result, draft);
    expect(index.errors).toEqual([]);
    expect(index.warnings.some((w) => w.code === 'overlap' && w.scope === 'widget')).toBe(true);
  });

  it('one broken widget never blanks the rest of the canvas', () => {
    let draft = setup();
    draft = apply(draft, { type: 'setWidgetField', id: 'w_line-chart', container: 'encoding', key: 'x', value: 'missing' });
    const r = buildRenderable(draft);
    expect([...r.ok].sort()).toEqual(['w_kpi', 'w_kpi_copy']);
    expect(r.blocked.get('w_line-chart')![0]!.path).toBe('widgets.w_line-chart.encoding.x');
    expect(r.dashboard && Object.keys(r.dashboard.widgets).sort()).toEqual(['w_kpi', 'w_kpi_copy']);
    expect(validateDashboard(r.spec).ok).toBe(true);
  });
});
