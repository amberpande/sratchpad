import type { PieWidget as PieSpec } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { Cell as Slice, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatValue, humanize, pickFormat } from '../format';
import { useMarks } from './vizParts';
import { pieData, type PieSlice } from './chartData';
import { Message } from './Message';
import { column, type WidgetProps } from './types';

interface SliceTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: PieSlice }>;
}

/**
 * Donut for part-to-whole only (validation requires a sum/count measure; negatives refuse to
 * draw). At most 6 slices, largest first; the rest fold into a neutral "Other". Slices are
 * separated by a 2px surface gap, and the legend carries values in text ink.
 */
export default function PieWidget({ widget, result, format }: WidgetProps<PieSpec>) {
  const { value } = widget.encoding;
  const { maxSlices, donut } = widget.options;
  const fmt = pickFormat(widget.options.numberFormats, value, widget.options.format);
  const marks = useMarks(widget.encoding.category);
  // "Other" folds several categories: it is not one value, so it can't be selected.
  const pick = (s: PieSlice, e?: { shiftKey?: boolean }) => !s.other && marks.onSelect(s.label, e);
  const data = useMemo(() => pieData(result, widget.encoding, maxSlices), [result, widget.encoding, maxSlices]);
  const valueColumn = column(result, value);
  const fmtValue = (v: number) => formatValue(v, fmt, valueColumn, format);
  const pct = (share: number) => formatValue(share, 'percent', undefined, format);

  if (data.negative > 0) {
    return <Message title="Can’t show as a pie" detail={`${humanize(value)} has negative values; a pie only shows parts of a positive whole.`} />;
  }
  if (!data.slices.length) return <Message title="No data" />;

  const SliceTooltip = ({ active, payload }: SliceTooltipProps) => {
    const s = active ? payload?.[0]?.payload : undefined;
    if (!s) return null;
    return (
      <div className="bi-tooltip">
        <div className="bi-tooltip-row">
          <span className="bi-tooltip-key">
            <span className="bi-tooltip-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
          <span className="bi-tooltip-value">{fmtValue(s.value)}</span>
        </div>
        <div className="bi-tooltip-label" style={{ margin: '4px 0 0' }}>
          {pct(s.share)} of total
        </div>
      </div>
    );
  };

  return (
    <div className="bi-pie" role="img" aria-label={`Pie chart of ${humanize(value)} by ${humanize(widget.encoding.category)}`}>
      <div className="bi-pie-plot">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data.slices}
              dataKey="value"
              nameKey="label"
              innerRadius={donut ? '62%' : 0}
              outerRadius="92%"
              startAngle={90}
              endAngle={-270}
              stroke="var(--bi-surface)"
              strokeWidth={2}
              cornerRadius={donut ? 3 : 0}
              isAnimationActive={false}
              onClick={(d: { payload?: PieSlice }, _i: number, e: { shiftKey?: boolean }) => d?.payload && pick(d.payload, e)}
              cursor={marks.cursor}
            >
              {data.slices.map((s) => (
                <Slice key={s.key} fill={s.color} fillOpacity={s.other ? 1 : marks.opacity(s.label)} />
              ))}
            </Pie>
            <Tooltip content={<SliceTooltip />} isAnimationActive={false} />
          </PieChart>
        </ResponsiveContainer>
        {donut && (
          <div className="bi-pie-total">
            <strong>{formatValue(data.total, fmt, valueColumn, format, { compact: true })}</strong>
            <span>Total</span>
          </div>
        )}
      </div>
      <ul className="bi-pie-legend">
        {data.slices.map((s) => (
          <li key={s.key} title={`${s.label}: ${fmtValue(s.value)}`} onClick={(e) => pick(s, e)} style={{ cursor: s.other ? undefined : marks.cursor, opacity: s.other ? 1 : marks.opacity(s.label) }}>
            <span className="bi-tooltip-swatch" style={{ background: s.color }} />
            <span>{s.label}</span>
            <span>{pct(s.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
