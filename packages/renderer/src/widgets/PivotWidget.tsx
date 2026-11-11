import type { Cell, PivotWidget as PivotSpec } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { formatValue, humanize, pickFormat } from '../format';
import { conditionalStyle, extent } from './vizParts';
import { pivotData } from './chartData';
import { DataTable, type DataColumn } from './DataTable';
import { column, type WidgetProps } from './types';

/**
 * Rows × columns × value from a long result. Pure reshaping by cell lookup: the query groups by
 * exactly the row and column dimensions (validation enforces it), so no cell is ever summed here.
 */
export function PivotWidget({ widget, result, format }: WidgetProps<PivotSpec>) {
  const { rows, columns, value } = widget.encoding;
  const { columnOrder, maxColumns, title, conditionalFormats } = widget.options;
  const fmt = pickFormat(widget.options.numberFormats, value, widget.options.format);
  const { tableColumns, tableRows, note } = useMemo(() => {
    const pivot = pivotData(result, widget.encoding, columnOrder, maxColumns);
    const rowMeta = column(result, rows);
    const colMeta = column(result, columns);
    const valueMeta = column(result, value);
    // Conditional formats on the value column color every cell; a scale spans all displayed cells.
    const cfs = (conditionalFormats ?? []).filter((cf) => cf.field === value);
    const range = cfs.some((cf) => cf.scale) ? extent(result.rows.map((r) => r[value] ?? null)) : null;
    const tableColumns: DataColumn[] = [
      { key: 'r', label: humanize(rows), align: 'left', rowHeader: true, text: (row) => formatValue(row.r, undefined, rowMeta, format) },
      ...pivot.columnValues.map<DataColumn>((cv, ci) => ({
        key: `c${ci}`,
        label: formatValue(cv, undefined, colMeta, format),
        align: 'right',
        text: (row) => formatValue(row[`c${ci}`], fmt, valueMeta, format),
        ...(cfs.length ? { cellStyle: (row: Record<string, Cell>) => cfs.reduce<ReturnType<typeof conditionalStyle>>((acc, cf) => acc ?? conditionalStyle(cf, row[`c${ci}`], range), undefined) } : {}),
      })),
    ];
    const tableRows = pivot.rowValues.map((rv, ri) => {
      const out: Record<string, Cell> = { r: rv };
      pivot.columnValues.forEach((_, ci) => (out[`c${ci}`] = pivot.cell(ri, ci)));
      return out;
    });
    const note = pivot.hiddenColumns ? `${pivot.hiddenColumns} more ${humanize(columns).toLowerCase()} column(s) not shown.` : undefined;
    return { tableColumns, tableRows, note };
  }, [result, widget, rows, columns, value, columnOrder, maxColumns, fmt, format, conditionalFormats]);
  return <DataTable columns={tableColumns} rows={tableRows} label={title ?? `${humanize(value)} by ${humanize(rows)} and ${humanize(columns)}`} mode="scroll" truncated={result.truncated} note={note} />;
}
