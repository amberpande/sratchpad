import type { Cell, WaterfallWidget as WaterfallSpec } from '@yourorg/bi-spec';
import { formatValue, humanize, pickFormat } from '../format';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { useMarks, useSize } from './vizParts';

/**
 * Waterfall: each step's signed amount floats from the running total. The running total is a
 * display offset of already-aggregated steps (like stacking), not an aggregation of raw rows.
 */
export default function WaterfallWidget({ widget, result, format }: WidgetProps<WaterfallSpec>) {
  const { category, value } = widget.encoding;
  const o = widget.options;
  const fmt = pickFormat(o.numberFormats, value, o.format);
  const marks = useMarks(category);
  const [ref, size] = useSize<HTMLDivElement>();
  const steps: Array<{ label: Cell; from: number; to: number; kind: 'increase' | 'decrease' | 'total' }> = [];
  let run = 0;
  for (const r of result.rows) {
    const v = r[value];
    if (typeof v !== 'number') continue;
    steps.push({ label: r[category] ?? null, from: run, to: run + v, kind: v >= 0 ? 'increase' : 'decrease' });
    run += v;
  }
  if (!steps.length) return <Message title="No data" />;
  if (o.showTotal) steps.push({ label: o.totalLabel, from: 0, to: run, kind: 'total' });
  const all = steps.flatMap((s) => [s.from, s.to]);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const left = 56;
  const bottom = 22;
  const w = Math.max(0, size.width - left - 8);
  const h = Math.max(0, size.height - bottom - 14);
  const yOf = (v: number) => 14 + (hi === lo ? h : h - ((v - lo) / (hi - lo)) * h);
  const band = w / steps.length;
  const bw = band * 0.62;
  const meta = column(result, value);
  const color = { increase: o.colors?.increase ?? 'var(--bi-series-3)', decrease: o.colors?.decrease ?? 'var(--bi-series-8)', total: o.colors?.total ?? 'var(--bi-series-1)' };

  return (
    <div ref={ref} style={{ height: '100%', cursor: marks.cursor }} role="img" aria-label={`Waterfall of ${humanize(value)} by ${humanize(category)}`}>
      {size.width > 0 && (
        <svg width={size.width} height={size.height}>
          <line x1={left} x2={left + w} y1={yOf(0)} y2={yOf(0)} stroke="var(--bi-border)" />
          {steps.map((s, i) => {
            const x = left + band * i + (band - bw) / 2;
            const top = yOf(Math.max(s.from, s.to));
            const height = Math.max(1, Math.abs(yOf(s.from) - yOf(s.to)));
            const delta = s.to - s.from;
            const isTotal = s.kind === 'total';
            return (
              <g key={i} onClick={(e) => !isTotal && marks.onSelect(s.label, e)} opacity={isTotal ? 1 : marks.opacity(s.label)} data-kind={s.kind}>
                <rect x={x} y={top} width={bw} height={height} rx={2} fill={color[s.kind]}>
                  <title>{`${String(s.label)}: ${isTotal ? '' : delta >= 0 ? '+' : '−'}${formatValue(Math.abs(isTotal ? s.to : delta), fmt, meta, format)}`}</title>
                </rect>
                {i < steps.length - 1 && !isTotal && <line x1={x + bw} x2={x + band} y1={yOf(s.to)} y2={yOf(s.to)} stroke="var(--bi-text-3)" strokeDasharray="2 2" />}
                <text x={x + bw / 2} y={top - 4} textAnchor="middle" className="bi-data-label">
                  {formatValue(isTotal ? s.to : delta, fmt, meta, format, { compact: true })}
                </text>
                <text x={x + bw / 2} y={14 + h + 16} textAnchor="middle" className="bi-axis-text">
                  {formatValue(s.label, undefined, isTotal ? undefined : column(result, category), format, { compact: true })}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
