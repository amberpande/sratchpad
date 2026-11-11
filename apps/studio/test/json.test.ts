import { stableStringify, validateDashboard } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import example from '../../../examples/dashboards/dash_9f2a.json';
import { coerceDraft, draftToJson, parseDraftJson } from '../src/draft/json';
import { draftReducer } from '../src/draft/reducer';
import { add, blank } from './helpers';

describe('JSON round-trip', () => {
  it('a canvas-built draft survives JSON text unchanged', () => {
    const { draft } = add(add(blank(), 'line-chart').draft, 'table');
    const parsed = parseDraftJson(draftToJson(draft));
    expect(parsed.ok && parsed.draft).toEqual(draft);
  });

  it('the hand-written example loads, round-trips and stays valid', () => {
    const coerced = coerceDraft(structuredClone(example));
    if (!coerced.ok) throw new Error(coerced.message);
    expect(stableStringify(coerced.draft)).toBe(stableStringify(example));
    expect(validateDashboard(coerced.draft).ok).toBe(true);
    const again = parseDraftJson(draftToJson(coerced.draft));
    expect(again.ok && stableStringify(again.draft)).toBe(stableStringify(example));
  });

  it('JSON edits flow back into the draft through the reducer', () => {
    const { draft } = add(blank(), 'kpi');
    const text = draftToJson(draft).replace('"label": "Sum amount"', '"label": "Edited"');
    expect(text).toContain('"Edited"');
    const parsed = parseDraftJson(text);
    if (!parsed.ok) throw new Error(parsed.message);
    const next = draftReducer(draft, { type: 'replace', draft: parsed.draft });
    expect(next.widgets.w_kpi!.options).toEqual({ field: 'sum_amount', label: 'Edited' });
  });

  it('rejects text the editor cannot walk, keeping deeper mistakes for validation', () => {
    expect(parseDraftJson('{ nope').ok).toBe(false);
    expect(parseDraftJson('[]')).toMatchObject({ ok: false, message: 'The document must be a JSON object.' });
    expect(parseDraftJson('{"widgets": []}')).toMatchObject({ ok: false, message: '"widgets" must be an object.' });
    expect(parseDraftJson('{"queries": {"q": {"measures": 3}}}')).toMatchObject({ ok: false });
    // Structurally walkable but invalid: accepted; validation reports it.
    const loose = parseDraftJson('{"specVersion": "1.0", "id": "1bad", "title": ""}');
    expect(loose.ok).toBe(true);
    if (loose.ok) expect(validateDashboard(loose.draft).ok).toBe(false);
  });
});
