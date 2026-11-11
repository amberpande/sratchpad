import type { Cell, QueryResult, TableColumn, TableWidget as TableSpec } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { formatValue, humanize, pickFormat } from '../format';
import { DataTable, type DataColumn } from './DataTable';
import { Sparkline } from './Sparkline';
import { column, type WidgetProps } from './types';
import { conditionalStyle, extent, useMarks } from './vizParts';

const SPARK_KEY = '__spark';

/**
 * Spec 1.3 sparklines: rows that differ only in `by`/`value` collapse into one row with the series
 * of values in result order. Grouping keys are the remaining columns' values; nothing is summed.
 */
export function sparklineRows(result: QueryResult, by: string, value: string): Array<Record<string, Cell>> {
  const keyCols = result.columns.map((c) => c.name).filter((n) => n !== by && n !== value);
  const groups = new Map<string, Record<string, Cell> & { [SPARK_KEY]?: never }>();
  const series = new Map<string, Array<{ x: Cell; y: Cell }>>();
  for (const r of result.rows) {
    const key = JSON.stringify(keyCols.map((k) => r[k] ?? null));
    if (!groups.has(key)) {
      groups.set(key, Object.fromEntries(keyCols.map((k) => [k, r[k] ?? null])) as Record<string, Cell>);
      series.set(key, []);
    }
    series.get(key)!.push({ x: r[by] ?? null, y: r[value] ?? null });
  }
  return [...groups.entries()].map(([k, row]) => ({ ...row, [SPARK_KEY]: JSON.stringify(series.get(k)) }));
}

export function TableWidget({ widget, result, format }: WidgetProps<TableSpec>) {
  const { pageSize, pagination, title, numberFormats, conditionalFormats, sparkline, sortable } = widget.options;
  // Row clicks select by the first text/time column (the row's identity), if any.
  const idColumn = result.columns.find((c) => c.type !== 'number')?.name;
  const marks = useMarks(idColumn);

  const rows = useMemo(() => (sparkline ? sparklineRows(result, sparkline.by, sparkline.value) : result.rows), [result, sparkline]);
  const columns = useMemo<DataColumn[]>(() => {
    const hidden = sparkline ? new Set([sparkline.by, sparkline.value]) : new Set<string>();
    const specColumns: TableColumn[] = (widget.options.columns ?? result.columns.map((c) => ({ field: c.name }))).filter((c) => !hidden.has(c.field));
    const out = specColumns.map<DataColumn>((c) => {
      const meta = column(result, c.field);
      const fmt = pickFormat(numberFormats, c.field, c.format);
      const cfs = (conditionalFormats ?? []).filter((cf) => cf.field === c.field);
      const range = cfs.some((cf) => cf.scale) ? extent(rows.map((r) => r[c.field] ?? null)) : null;
      return {
        key: c.field,
        label: c.label ?? humanize(c.field),
        align: c.align ?? (meta?.type === 'number' ? 'right' : 'left'),
        text: (row) => formatValue(row[c.field], fmt, meta, format),
        ...(cfs.length
          ? { cellStyle: (row: Record<string, Cell>) => cfs.reduce<ReturnType<typeof conditionalStyle>>((acc, cf) => acc ?? conditionalStyle(cf, row[c.field], range), undefined) }
          : {}),
      };
    });
    if (sparkline) {
      const valueMeta = column(result, sparkline.value);
      const fmt = pickFormat(numberFormats, sparkline.value);
      out.push({
        key: SPARK_KEY,
        label: sparkline.label ?? humanize(sparkline.value),
        align: 'left',
        sortable: false,
        text: (row) => {
          const pts = JSON.parse(String(row[SPARK_KEY])) as Array<{ x: Cell; y: Cell }>;
          const last = pts[pts.length - 1];
          return `${pts.length} points, latest ${formatValue(last?.y ?? null, fmt, valueMeta, format)}`;
        },
        render: (row) => <Sparkline points={JSON.parse(String(row[SPARK_KEY]))} label={`${humanize(sparkline.value)} over ${humanize(sparkline.by)}`} />,
      });
    }
    return out;
  }, [widget, result, rows, format, numberFormats, conditionalFormats, sparkline]);

  return (
    <DataTable
      columns={columns}
      rows={rows}
      label={title ?? 'Table'}
      mode={pagination}
      pageSize={pageSize}
      truncated={result.truncated}
      sortable={sortable !== false}
      onRowClick={marks.interactive && idColumn ? (row, e) => marks.onSelect(row[idColumn] ?? null, e) : undefined}
      rowOpacity={idColumn ? (row) => marks.opacity(row[idColumn] ?? null) : undefined}
    />
  );
}
