import type { AreaChartWidget, BarChartWidget, Cell, LineChartWidget, QueryResult } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { formatValue, humanize, pickFormat, type FormatContext } from '../format';
import type { CartesianData } from './chartData';
import { column, yList } from './types';
import { referenceChildren, rowsByX, sharedDomain, useMarks } from './vizParts';

type Cartesian = LineChartWidget | BarChartWidget | AreaChartWidget;

/**
 * Spec 1.3 additions shared by line, bar and area charts: number formats, reference lines/bands/
 * annotations, tooltip fields, mark interactions, and the shared value domain for small multiples.
 */
export function useCartesianExtras(widget: Cartesian, result: QueryResult, data: CartesianData, format: FormatContext, opts: { horizontal?: boolean } = {}) {
  const o = widget.options;
  const { x } = widget.encoding;
  const marks = useMarks(x);
  const yColumn = data.series[0]?.column?.name;
  const xFormat = pickFormat(o.numberFormats, x, o.format?.x);
  const yFormat = pickFormat(o.numberFormats, yColumn, o.format?.y);
  const refs = referenceChildren(o, result.rows[0], { horizontal: opts.horizontal });
  const byX = useMemo(() => (o.tooltip && !widget.encoding.series ? rowsByX(result, x) : null), [o.tooltip, widget.encoding.series, result, x]);
  const extra = byX
    ? (label: string | number | undefined) => {
        const row = byX.get(JSON.stringify(label ?? null));
        if (!row) return [];
        return (o.tooltip?.fields ?? []).map((f): [string, string] => [humanize(f), formatValue(row[f], pickFormat(o.numberFormats, f), column(result, f), format)]);
      }
    : undefined;
  return { marks, xFormat, yFormat, refs, extra };
}

/** Recharts chart-level click → mark selection on the x value. */
export function chartClick(marks: ReturnType<typeof useMarks>) {
  return (state: { activeLabel?: string | number } | null, event?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
    if (state && state.activeLabel !== undefined) marks.onSelect(state.activeLabel as Cell, event);
  };
}

/** Value domain shared by every panel of a faceted chart. */
export function facetDomain(widget: Cartesian, result: QueryResult): [number, number] | undefined {
  return sharedDomain(result, yList(widget.encoding.y));
}
