import type { GaugeWidget as GaugeSpec } from '@yourorg/bi-spec';
import { formatValue, humanize, pickFormat } from '../format';
import { reduceColumn } from './KpiWidget';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { useSize } from './vizParts';

const polar = (cx: number, cy: number, r: number, t: number) => {
  // t in 0..1 over a 180° arc from left to right.
  const a = Math.PI * (1 - t);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
};
function arc(cx: number, cy: number, r: number, t0: number, t1: number) {
  const [x0, y0] = polar(cx, cy, r, t0);
  const [x1, y1] = polar(cx, cy, r, t1);
  // The gauge spans at most 180°, so the small-arc flag is always right.
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

/** Gauge: one value on a half-circle scale (min..max), optional target tick and colored bands. */
export default function GaugeWidget({ widget, result, format }: WidgetProps<GaugeSpec>) {
  const o = widget.options;
  const [ref, size] = useSize<HTMLDivElement>();
  const value = reduceColumn(result.rows.map((r) => r[o.field] ?? null), o.reduce);
  const first = result.rows[0];
  const max = o.max ?? (o.maxField && typeof first?.[o.maxField] === 'number' ? (first[o.maxField] as number) : undefined);
  const target = o.target ?? (o.targetField && typeof first?.[o.targetField] === 'number' ? (first[o.targetField] as number) : undefined);
  if (value === null) return <Message title="No data" />;
  if (max === undefined || max <= o.min) return <Message title="Gauge needs a maximum" detail="Set max, or a maxField with a value above min." />;
  const fmt = pickFormat(o.numberFormats, o.field, o.format);
  const meta = column(result, o.field);
  const t = (v: number) => Math.min(1, Math.max(0, (v - o.min) / (max - o.min)));
  // Fit the arc and its stroke inside the box: half the stroke sits outside the radius.
  const base = Math.max(10, Math.min(size.width / 2 - 8, size.height - 40));
  const stroke = Math.max(8, base * 0.16);
  const r = Math.max(6, base - stroke / 2);
  const cx = size.width / 2;
  const cy = r + stroke / 2 + 4;
  const text = formatValue(value, fmt, meta, format);
  let prev = o.min;
  return (
    <div ref={ref} style={{ height: '100%' }} role="img" aria-label={`${o.label ?? humanize(o.field)}: ${text} of ${formatValue(max, fmt, meta, format)}${target !== undefined ? `, target ${formatValue(target, fmt, meta, format)}` : ''}`}>
      {size.width > 0 && (
        <svg width={size.width} height={size.height} className="bi-gauge">
          <path d={arc(cx, cy, r, 0, 1)} stroke="var(--bi-hover)" strokeWidth={stroke} fill="none" />
          {(o.bands ?? []).map((b, i) => {
            const d = arc(cx, cy, r, t(prev), t(b.to));
            prev = b.to;
            return <path key={i} d={d} stroke={b.color} strokeOpacity={0.35} strokeWidth={stroke} fill="none" />;
          })}
          <path d={arc(cx, cy, r, 0, Math.max(0.001, t(value)))} stroke="var(--bi-accent, var(--bi-series-1))" strokeWidth={stroke * 0.55} strokeLinecap="butt" fill="none" data-part="value" />
          {target !== undefined &&
            (() => {
              const [x0, y0] = polar(cx, cy, r - stroke / 1.4, t(target));
              const [x1, y1] = polar(cx, cy, r + stroke / 1.4, t(target));
              return <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--bi-text)" strokeWidth={2} data-part="target" />;
            })()}
          <text x={cx} y={cy - 4} textAnchor="middle" className="bi-gauge-value">
            {text}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="bi-axis-text">
            {o.label ?? humanize(o.field)}
          </text>
          <text x={cx - r} y={cy + 18} textAnchor="middle" className="bi-axis-text">
            {formatValue(o.min, fmt, meta, format, { compact: true })}
          </text>
          <text x={cx + r} y={cy + 18} textAnchor="middle" className="bi-axis-text">
            {formatValue(max, fmt, meta, format, { compact: true })}
          </text>
        </svg>
      )}
    </div>
  );
}
