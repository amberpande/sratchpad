import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryEditor } from '../src/components/QueryEditor';
import { columnNames, compactQuery, normalizeQuery } from '../src/draft/query';
import type { FieldInfo } from '../src/draft/types';

afterEach(cleanup);

const q13 = {
  source: 'orders',
  dimensions: [{ field: 'order_date', grain: 'month' as const }],
  measures: [{ field: 'amount', agg: 'sum' as const, as: 'revenue' }, { field: '*', agg: 'count' as const, as: 'n' }],
  calcs: [{ as: 'ticket', expr: 'revenue / n' }],
  windows: [{ as: 'yoy', type: 'percent_change' as const, measure: 'revenue', order: 'order_date', offset: 12 }],
  topN: { dimension: 'order_date', n: 3, by: 'revenue' },
  joins: [{ source: 'targets', type: 'left' as const, on: [{ left: 'region', right: 'region' }] }],
  metrics: [{ metric: 'margin' }],
};

const fields: FieldInfo[] = [
  { name: 'order_date', kind: 'time', semanticType: 'temporal' },
  { name: 'amount', kind: 'measure', semanticType: 'numeric' },
];

describe('Studio: spec 1.3 query fields', () => {
  it('normalize/compact keep calcs, windows, topN, joins and metrics', () => {
    expect(compactQuery(normalizeQuery(q13))).toEqual(q13);
    expect(columnNames(q13).measures).toEqual(['revenue', 'n', 'margin', 'ticket', 'yoy']);
  });

  it('edits calcs and bins, and applies advanced JSON', () => {
    const onChange = vi.fn();
    const base = normalizeQuery({ source: 'orders', dimensions: [{ field: 'amount' }], measures: [{ field: '*', agg: 'count', as: 'n' }] });
    render(<QueryEditor queryId="q" query={base} fields={fields} issues={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Calc' }));
    expect(onChange.mock.calls.at(-1)![0].calcs).toEqual([{ as: 'calc_1', expr: 'n' }]);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Bin width' }), { target: { value: '50' } });
    expect(onChange.mock.calls.at(-1)![0].dimensions).toEqual([{ field: 'amount', bin: { width: 50 } }]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Advanced query JSON' }), { target: { value: '{"topN": {"dimension": "amount", "n": 3, "by": "n"}}' } });
    expect(onChange.mock.calls.at(-1)![0].topN).toEqual({ dimension: 'amount', n: 3, by: 'n' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Advanced query JSON' }), { target: { value: '{"nope": 1}' } });
    expect(screen.getByText(/Unknown key/)).toBeTruthy();
  });
});
