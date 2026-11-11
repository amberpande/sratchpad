import type { FunnelWidget as FunnelSpec } from '@yourorg/bi-spec';
import { formatValue, humanize, pickFormat } from '../format';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { useMarks } from './vizParts';

/**
 * Funnel: stages in result order (sort the query), bar width ∝ value, with the conversion from the
 * previous and the first stage (ratios of displayed values).
 */
export default function FunnelWidget({ widget, result, format }: WidgetProps<FunnelSpec>) {
  const { stage, value } = widget.encoding;
  const fmt = pickFormat(widget.options.numberFormats, value, widget.options.format);
  const marks = useMarks(stage);
  const rows = result.rows.filter((r) => typeof r[value] === 'number');
  if (!rows.length) return <Message title="No data" />;
  const max = Math.max(...rows.map((r) => r[value] as number), 0);
  const first = rows[0]![value] as number;
  const meta = column(result, value);
  const pct = (v: number) => formatValue(v, 'percent', undefined, format);
  return (
    <ol className="bi-funnel" aria-label={`Funnel of ${humanize(value)} by ${humanize(stage)}`} style={{ cursor: marks.cursor }}>
      {rows.map((r, i) => {
        const v = r[value] as number;
        const prev = i > 0 ? (rows[i - 1]![value] as number) : null;
        const s = r[stage] ?? null;
        return (
          <li key={i} onClick={(e) => marks.onSelect(s, e)} style={{ opacity: marks.opacity(s) }}>
            <span className="bi-funnel-stage">{formatValue(s, undefined, column(result, stage), format)}</span>
            <span className="bi-funnel-track">
              <span className="bi-funnel-bar" style={{ width: `${max > 0 ? Math.max(1, (v / max) * 100) : 0}%` }} />
            </span>
            <span className="bi-funnel-value">{formatValue(v, fmt, meta, format)}</span>
            {widget.options.showConversion && (
              <span className="bi-funnel-conv" title={first ? `${pct(v / first)} of the first stage` : undefined}>
                {prev ? `${pct(v / prev)} of previous` : ''}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
