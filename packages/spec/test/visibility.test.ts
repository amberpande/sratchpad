import { describe, expect, it } from 'vitest';
import { isWidgetVisible, validateDashboard } from '../src';

// Show/hide widgets by a control's value (1.4, D-089).
describe('visibleWhen', () => {
  it('evaluates set, empty and in', () => {
    expect(isWidgetVisible({ param: 'r', is: 'set' }, { r: 'EU' })).toBe(true);
    expect(isWidgetVisible({ param: 'r', is: 'set' }, { r: null })).toBe(false);
    expect(isWidgetVisible({ param: 'r', is: 'empty' }, { r: [] })).toBe(true);
    expect(isWidgetVisible({ param: 'r', is: 'in', values: ['EU', 'US'] }, { r: ['APAC', 'US'] })).toBe(true);
    expect(isWidgetVisible({ param: 'r', is: 'in', values: ['EU'] }, { r: 'APAC' })).toBe(false);
    expect(isWidgetVisible(undefined, {})).toBe(true);
  });

  it('validates the shape and the param reference', () => {
    const doc = (visibleWhen: unknown) => ({
      specVersion: '1.4',
      id: 'd',
      title: 'D',
      dataSources: {},
      queries: {},
      widgets: { t: { type: 'text', options: { text: 'Hi' }, visibleWhen } },
      layout: [{ i: 't', x: 0, y: 0, w: 4, h: 2 }],
      params: { region: { type: 'select', field: 'region', bind: [] } },
    });
    expect(validateDashboard(doc({ param: 'region' })).ok).toBe(true);
    expect(validateDashboard(doc({ param: 'nope' })).ok).toBe(false);
    expect(validateDashboard(doc({ param: 'region', is: 'in' })).ok).toBe(false);
  });
});
