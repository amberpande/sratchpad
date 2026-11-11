import { describe, expect, it } from 'vitest';
import { addDimension, addField, addMeasure, autoEncode, compactQuery, normalizeQuery, starterQuery, type NormalQuery } from '../src/draft/query';
import { widgetTypeInfo } from '../src/draft/widgetTypes';
import { field, fields } from './helpers';

const empty = (): NormalQuery => ({ source: 'orders', dimensions: [], measures: [], filters: [], orderBy: [] });

describe('query building from fields', () => {
  it('temporal fields become dimensions with a grain and sort ascending by time', () => {
    const q = addDimension(empty(), field('order_date'));
    expect(q.dimensions).toEqual([{ field: 'order_date', grain: 'month' }]);
    expect(q.orderBy).toEqual([{ field: 'order_date', dir: 'asc' }]);
    expect(addDimension(q, field('order_date'), 'week').dimensions).toEqual([{ field: 'order_date', grain: 'week' }]);
  });

  it('categorical fields become plain dimensions; measures get an aggregation', () => {
    let { query } = addField(empty(), field('region'));
    expect(query.dimensions).toEqual([{ field: 'region' }]);
    ({ query } = addField(query, field('amount')));
    expect(query.measures).toEqual([{ field: 'amount', agg: 'sum' }]);
    // An id dropped as a measure counts distinct values.
    const ids = addField(empty(), field('order_id'), 'measure');
    expect(ids.query.measures).toEqual([{ field: 'order_id', agg: 'count_distinct' }]);
    expect(ids.added).toBe('count_distinct_order_id');
  });

  it('aliases a measure only when its output column name is taken', () => {
    const q = addMeasure(addMeasure(empty(), 'amount', 'sum'), 'amount', 'sum');
    expect(q.measures).toEqual([
      { field: 'amount', agg: 'sum' },
      { field: 'amount', agg: 'sum', as: 'sum_amount_2' },
    ]);
  });

  it('normalizes and compacts without losing information', () => {
    const input = { source: 'orders', measures: [{ field: '*', agg: 'count' as const }], limit: 50 };
    expect(compactQuery(normalizeQuery(input))).toEqual(input);
  });

  it('discovers field slots from the registry', () => {
    const line = widgetTypeInfo('line-chart')!.slots;
    expect(line.slice(0, 2)).toEqual([
      { container: 'encoding', key: 'x', columns: false, multiple: false, required: true, role: 'dimension' },
      { container: 'encoding', key: 'y', columns: false, multiple: true, required: true, role: 'measure' },
    ]);
    // Later minors may add optional slots (spec 1.1: "series"); they are never required.
    expect(line.slice(2).every((s) => !s.required)).toBe(true);
    expect(widgetTypeInfo('kpi')!.slots).toEqual([{ container: 'options', key: 'field', columns: false, multiple: false, required: true, role: 'measure' }]);
    expect(widgetTypeInfo('table')!.slots[0]).toMatchObject({ key: 'columns', columns: true, required: false });
    expect(widgetTypeInfo('bar-chart')!.options.find((o) => o.key === 'orientation')).toMatchObject({ kind: 'enum', values: ['vertical', 'horizontal'], defaultValue: 'vertical' });
    expect(widgetTypeInfo('line-chart')!.options.find((o) => o.key === 'format')).toMatchObject({ kind: 'enumObject' });
  });

  it('asks the type’s own checks which slots need a measure', () => {
    // Spec 1.1 scatter: "x" is a numeric axis even though it's called x.
    const scatter = widgetTypeInfo('scatter');
    if (!scatter) return; // registry without scatter (spec 1.0)
    expect(scatter.slots.find((s) => s.key === 'x')?.role).toBe('measure');
    expect(scatter.slots.find((s) => s.key === 'size')).toMatchObject({ required: false, role: 'measure' });
  });

  it('optional slots are repaired but not auto-filled, except by a newly added dimension', () => {
    let q = addMeasure(addDimension(empty(), field('order_date')), 'amount', 'sum');
    const widget = autoEncode({ type: 'line-chart', encoding: {} }, compactQuery(q));
    expect(widget.encoding).toEqual({ x: 'order_date', y: 'sum_amount' });
    if (!widgetTypeInfo('line-chart')!.slots.some((s) => s.key === 'series')) return;
    q = addDimension(q, field('region'));
    expect(autoEncode(widget, compactQuery(q), { added: 'region' }).encoding).toEqual({ x: 'order_date', y: 'sum_amount', series: 'region' });
    expect(autoEncode({ ...widget, encoding: { ...widget.encoding, series: 'gone' } }, compactQuery(q)).encoding).toEqual({ x: 'order_date', y: 'sum_amount' });
  });

  it('autoEncode keeps valid choices and repairs broken ones', () => {
    const query = compactQuery(addMeasure(addDimension(empty(), field('region')), 'amount', 'sum'));
    expect(autoEncode({ type: 'bar-chart', encoding: { x: 'gone', y: ['sum_amount', 'gone'] } }, query).encoding).toEqual({ x: 'region', y: 'sum_amount' });
    expect(autoEncode({ type: 'kpi', options: { field: 'sum_amount', label: 'Revenue' } }, query).options).toEqual({ field: 'sum_amount', label: 'Revenue' });
    // Table: "all columns" (undefined) stays; an explicit list drops missing columns.
    expect(autoEncode({ type: 'table', options: {} }, query).options).toEqual({});
    expect(autoEncode({ type: 'table', options: { columns: [{ field: 'region' }, { field: 'gone' }] } }, query).options).toEqual({ columns: [{ field: 'region' }] });
  });

  it('starter queries fit the widget type', () => {
    expect(starterQuery('kpi', 'orders', fields)).toMatchObject({ dimensions: [], measures: [{ field: 'amount', agg: 'sum' }] });
    expect(starterQuery('line-chart', 'orders', fields).dimensions).toEqual([{ field: 'order_date', grain: 'month' }]);
    // Without a profile: count rows, so the query is still valid.
    expect(starterQuery('kpi', 'orders', []).measures).toEqual([{ field: '*', agg: 'count' }]);
  });
});
