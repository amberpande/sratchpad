import { describe, expect, it } from 'vitest';
import { requiredSpecVersion, validateDashboard, WIDGET_TYPES } from '../src';

const base = (specVersion: string, extra: Record<string, unknown> = {}, widget: Record<string, unknown> = {}) => ({
  specVersion,
  id: 'd',
  title: 'D',
  dataSources: { s: { type: 'sample', ref: 'orders' } },
  queries: { q: { source: 's', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] } },
  widgets: { w: { type: 'bar-chart', query: 'q', encoding: { x: 'region', y: 'revenue' }, options: {}, ...widget } },
  layout: [{ i: 'w', x: 0, y: 0, w: 6, h: 4 }],
  ...extra,
});

const theme = { mode: 'dark', palette: ['#1f6feb', '#f78166'], accent: '#d29922', background: '#0d1117', cardBackground: '#161b22', cardStyle: 'elevated', density: 'compact', radius: 4, font: 'serif' };
const style = { colors: ['#8250df'], background: '#fff8c5', emphasis: true, titleAlign: 'center', hideTitle: false };
const chrome = { showGrid: false, dataLabels: true, axis: { x: { label: 'Region' }, y: { label: 'Revenue', min: 0, max: 5000000 } } };

describe('spec 1.2: styling layer', () => {
  it('accepts theme, widget style and chart chrome in a 1.2 document', () => {
    const result = validateDashboard(base('1.2', { theme }, { style, options: chrome }));
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
    if (!result.ok) return;
    expect(result.dashboard.theme).toEqual(theme);
    expect(result.dashboard.widgets.w).toMatchObject({ style, options: chrome });
  });

  it('is an error in a document that claims an older version', () => {
    const result = validateDashboard(base('1.1', { theme }, { style, options: { showGrid: false } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => `${e.path}:${e.code}`).sort()).toEqual(['theme:field_too_new', 'widgets.w.options.showGrid:field_too_new', 'widgets.w.style:field_too_new']);
  });

  it('a 1.1 reader ignores the styling layer with warnings (degraded, still renders)', () => {
    const result = validateDashboard(base('1.2', { theme }, { style, options: chrome }), { supported: { major: 1, minor: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dashboard.theme).toBeUndefined();
    expect(result.dashboard.widgets.w).not.toHaveProperty('style');
    expect(result.warnings.map((w) => w.code)).toContain('unknown_field');
  });

  it('rejects values that are not safe to apply as CSS', () => {
    const result = validateDashboard(base('1.2', { theme: { accent: 'red;background:url(x)' } }, { style: { colors: ['blue'] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['theme.accent', 'widgets.w.style.colors.0']));
    const unknown = validateDashboard(base('1.2', { theme: { glow: true } }));
    expect(unknown.ok).toBe(false);
    const range = validateDashboard(base('1.2', {}, { options: { axis: { y: { min: 10, max: 5 } } } }));
    expect(range.ok).toBe(false);
  });

  it('warns when backgrounds and theme mode would make text unreadable', () => {
    const codes = (t: Record<string, unknown>) => {
      const r = validateDashboard(base('1.2', { theme: t }));
      return r.ok ? r.warnings.filter((w) => w.code === 'low_contrast').map((w) => w.path) : ['invalid'];
    };
    expect(codes({ background: '#0d1117' })).toEqual(['theme.background']);
    expect(codes({ background: '#0d1117', mode: 'dark' })).toEqual([]);
    expect(codes({ cardBackground: '#ffffff', mode: 'dark' })).toEqual(['theme.cardBackground']);
    expect(codes({ cardBackground: '#fff' })).toEqual([]);
  });

  it('requiredSpecVersion accounts for style, theme and chrome', () => {
    const w = { type: 'bar-chart', encoding: { x: 'a', y: 'b' }, options: {} };
    expect(requiredSpecVersion({ w })).toBe('1.0');
    expect(requiredSpecVersion({ w: { ...w, style: {} } })).toBe('1.2');
    expect(requiredSpecVersion({ w: { ...w, options: { dataLabels: true } } })).toBe('1.2');
    expect(requiredSpecVersion({ w }, { theme: {} })).toBe('1.2');
    expect(WIDGET_TYPES.scatter.fieldsSince).toMatchObject({ 'options.showGrid': '1.2', 'options.axis': '1.2' });
  });
});
