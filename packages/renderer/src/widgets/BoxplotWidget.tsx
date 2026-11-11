import type { BoxplotWidget as BoxplotSpec, Cell } from '@yourorg/bi-spec';
import { formatValue, humanize, pickFormat } from '../format';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { extent, useMarks, useSize } from './vizParts';

const KEYS = ['min', 'q1', 'median', 'q3', 'max'] as const;

/** Box plot from five precomputed statistics per category (the query computes them, e.g. p25/median/p75). */
export default function BoxplotWidget({ widget, result, format }: WidgetProps<BoxplotSpec>) {
  const e = widget.encoding;
  const o = widget.options;
  const fmt = pickFormat(o.numberFormats, e.median, o.format);
  const marks = useMarks(e.category);
  const [ref, size] = useSize<HTMLDivElement>();
  const boxes = result.rows
    .map((r) => ({ cat: r[e.category] ?? null, s: KEYS.map((k) => r[e[k]]) as Cell[] }))
    .filter((b) => b.s.every((v) => typeof v === 'number')) as Array<{ cat: Cell; s: number[] }>;
  if (!boxes.length) return <Message title="No data" detail="Every box needs numeric min, q1, median, q3 and max." />;
  const range = extent(boxes.flatMap((b) => b.s))!;
  const lo = o.axis?.y?.min ?? range[0];
  const hi = o.axis?.y?.max ?? range[1];
  const left = 56;
  const bottom = 22;
  const w = Math.max(0, size.width - left - 8);
  const h = Math.max(0, size.height - bottom - 8);
  const yOf = (v: number) => 8 + (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h);
  const band = w / boxes.length;
  const bw = Math.min(48, band * 0.5);
  const meta = column(result, e.median);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + (hi - lo) * t);

  return (
    <div ref={ref} style={{ height: '100%', cursor: marks.cursor }} role="img" aria-label={`Box plot of ${humanize(e.median)} by ${humanize(e.category)}`}>
      {size.width > 0 && (
        <svg width={size.width} height={size.height}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={left} x2={left + w} y1={yOf(t)} y2={yOf(t)} stroke="var(--bi-grid)" />
              <text x={left - 6} y={yOf(t)} textAnchor="end" dominantBaseline="middle" className="bi-axis-text">
                {formatValue(t, fmt, meta, format, { compact: true })}
              </text>
            </g>
          ))}
          {boxes.map((b, i) => {
            const cx = left + band * i + band / 2;
            const [mn, q1, md, q3, mx] = b.s;
            return (
              <g key={i} onClick={(ev) => marks.onSelect(b.cat, ev)} opacity={marks.opacity(b.cat)}>
                <title>{`${String(b.cat)}: min ${formatValue(mn!, fmt, meta, format)}, Q1 ${formatValue(q1!, fmt, meta, format)}, median ${formatValue(md!, fmt, meta, format)}, Q3 ${formatValue(q3!, fmt, meta, format)}, max ${formatValue(mx!, fmt, meta, format)}`}</title>
                <line x1={cx} x2={cx} y1={yOf(mx!)} y2={yOf(q3!)} stroke="var(--bi-text-3)" />
                <line x1={cx} x2={cx} y1={yOf(q1!)} y2={yOf(mn!)} stroke="var(--bi-text-3)" />
                <line x1={cx - bw / 4} x2={cx + bw / 4} y1={yOf(mx!)} y2={yOf(mx!)} stroke="var(--bi-text-3)" />
                <line x1={cx - bw / 4} x2={cx + bw / 4} y1={yOf(mn!)} y2={yOf(mn!)} stroke="var(--bi-text-3)" />
                <rect x={cx - bw / 2} y={yOf(q3!)} width={bw} height={Math.max(1, yOf(q1!) - yOf(q3!))} rx={2} fill="var(--bi-series-1)" fillOpacity={0.25} stroke="var(--bi-series-1)" />
                <line x1={cx - bw / 2} x2={cx + bw / 2} y1={yOf(md!)} y2={yOf(md!)} stroke="var(--bi-series-1)" strokeWidth={2} />
                <text x={cx} y={8 + h + 16} textAnchor="middle" className="bi-axis-text">
                  {formatValue(b.cat, undefined, column(result, e.category), format, { compact: true })}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
