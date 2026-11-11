import type { Format, NumberFormat, QueryResult, Widget } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { formatValue, humanize, type FormatContext } from '../format';
import { DataTable, type DataColumn } from './DataTable';
import { yList } from './types';

/** Format hints a chart's spec gives for each result column, so its table view reads the same. */
function columnFormats(widget: Widget): Record<string, Format | NumberFormat | undefined> {
  const custom = ('numberFormats' in widget.options ? (widget.options as { numberFormats?: Record<string, NumberFormat> }).numberFormats : undefined) ?? {};
  return { ...enumFormats(widget), ...custom };
}

function enumFormats(widget: Widget): Record<string, Format | undefined> {
  switch (widget.type) {
    case 'line-chart':
    case 'bar-chart':
    case 'area-chart': {
      const f = widget.options.format;
      return { [widget.encoding.x]: f?.x, ...Object.fromEntries(yList(widget.encoding.y).map((y) => [y, f?.y])) };
    }
    case 'scatter': {
      const f = widget.options.format;
      const e = widget.encoding;
      return { [e.x]: f?.x, [e.y]: f?.y, ...(e.size ? { [e.size]: f?.size } : {}) };
    }
    case 'pie':
      return { [widget.encoding.value]: widget.options.format };
    default:
      return {};
  }
}

/** "View as table": the chart's exact result, every column, as an accessible table. */
export function ResultTable({ widget, result, format, label }: { widget: Widget; result: QueryResult; format: FormatContext; label: string }) {
  const columns = useMemo<DataColumn[]>(() => {
    const formats = columnFormats(widget);
    return result.columns.map((c) => ({
      key: c.name,
      label: humanize(c.name),
      align: c.type === 'number' ? 'right' : 'left',
      text: (row) => formatValue(row[c.name], formats[c.name], c, format),
    }));
  }, [widget, result, format]);
  return <DataTable columns={columns} rows={result.rows} label={label} mode="scroll" truncated={result.truncated} sortable />;
}
