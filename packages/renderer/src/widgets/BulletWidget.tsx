import type { BulletWidget as BulletSpec, Cell } from '@yourorg/bi-spec';
import { formatValue, humanize, pickFormat } from '../format';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { useMarks } from './vizParts';

/** Bullet chart: value bar against a target tick over qualitative ranges; one row per category. */
export default function BulletWidget({ widget, result, format }: WidgetProps<BulletSpec>) {
  const e = widget.encoding;
  const o = widget.options;
  const fmt = pickFormat(o.numberFormats, e.value, o.format);
  const marks = useMarks(e.category);
  const rows = (e.category ? result.rows : result.rows.slice(0, 1)).filter((r) => typeof r[e.value] === 'number');
  if (!rows.length) return <Message title="No data" />;
  const ranges = o.ranges ?? [];
  const max =
    o.max ??
    Math.max(...rows.flatMap((r) => [r[e.value] as number, e.target && typeof r[e.target] === 'number' ? (r[e.target] as number) : 0]), ...ranges, 0) * 1.05;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / (max || 1)) * 100))}%`;
  const meta = column(result, e.value);
  return (
    <ul className="bi-bullets" aria-label={`Bullet chart of ${humanize(e.value)}${e.target ? ` against ${humanize(e.target)}` : ''}`} style={{ cursor: marks.cursor }}>
      {rows.map((r, i) => {
        const v = r[e.value] as number;
        const target = e.target ? (r[e.target] as Cell) : null;
        const cat = e.category ? (r[e.category] ?? null) : null;
        return (
          <li key={i} onClick={(ev) => marks.onSelect(cat, ev)} style={{ opacity: marks.opacity(cat) }}>
            {e.category && <span className="bi-bullet-label">{formatValue(cat, undefined, column(result, e.category), format)}</span>}
            <span className="bi-bullet-track" title={`${formatValue(v, fmt, meta, format)}${typeof target === 'number' ? ` of target ${formatValue(target, fmt, meta, format)}` : ''}`}>
              {[...ranges].reverse().map((rg, k) => (
                <span key={k} className="bi-bullet-range" data-level={ranges.length - k} style={{ width: pct(rg) }} />
              ))}
              <span className="bi-bullet-bar" style={{ width: pct(v) }} />
              {typeof target === 'number' && <span className="bi-bullet-target" style={{ left: pct(target) }} />}
            </span>
            <span className="bi-bullet-value">{formatValue(v, fmt, meta, format)}</span>
          </li>
        );
      })}
    </ul>
  );
}
