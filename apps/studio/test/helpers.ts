import { ID_PATTERN, validateDashboard } from '@yourorg/bi-spec';
import { expect } from 'vitest';
import { SAMPLE_ORDERS, SAMPLE_ORDERS_FIELDS } from '../src/draft/fields';
import { emptyDraft } from '../src/draft/json';
import { draftReducer, nextWidgetId, type DraftAction } from '../src/draft/reducer';
import type { DraftSpec, FieldInfo } from '../src/draft/types';

export const fields = SAMPLE_ORDERS_FIELDS;
export const field = (name: string): FieldInfo => fields.find((f) => f.name === name)!;

export function apply(draft: DraftSpec, ...actions: DraftAction[]): DraftSpec {
  return actions.reduce(draftReducer, draft);
}

export function add(draft: DraftSpec, widgetType: string, extra: Partial<Extract<DraftAction, { type: 'addWidget' }>> = {}): { draft: DraftSpec; id: string } {
  const id = nextWidgetId(draft, widgetType);
  return { draft: draftReducer(draft, { type: 'addWidget', widgetType, id, source: { source: SAMPLE_ORDERS.source }, fields, ...extra }), id };
}

export const blank = () => emptyDraft('dash_test', 'Test');

export function expectValid(draft: DraftSpec) {
  const result = validateDashboard(draft, { allowNewerMinor: false });
  if (!result.ok) throw new Error(`expected a valid spec, got:\n${result.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  return result;
}

export function expectIds(draft: DraftSpec) {
  for (const id of [...Object.keys(draft.widgets), ...Object.keys(draft.queries), ...Object.keys(draft.dataSources), ...Object.keys(draft.params)]) {
    expect(id).toMatch(ID_PATTERN);
  }
}
