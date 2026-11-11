import type { Cell, ComboWidget as ComboSpec } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { Bar, CartesianGrid, Cell as Mark, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValue, humanize, pickFormat } from '../format';
import { seriesColor } from '../styles';
import { X_KEY, type SeriesDef } from './chartData';
import { AXIS_TICK, axisChrome, ChartTooltip, GRID_STROKE, SeriesLegend } from './chartParts';
import { column, type WidgetProps } from './types';
import { referenceChildren, rowsByX, useMarks } from './vizParts';

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Combo: bars and lines on a shared x, lines optionally on their own right-hand axis. */
export default function ComboWidget({ widget, result, format }: WidgetProps<ComboSpec>) {
  const { x } = widget.encoding;
  const o = widget.options;
  const bars = list(widget.encoding.bars);
  const lines = list(widget.encoding.lines);
  const marks = useMarks(x);
  const chrome = axisChrome(o.axis);
  const nf = o.numberFormats;
  const xFormat = pickFormat(nf, x, o.format?.x);
  const yFormat = pickFormat(nf, bars[0], o.format?.y);
  const y2Format = pickFormat(nf, lines[0], o.format?.y2 ?? o.format?.y);
  const series: SeriesDef[] = [...bars, ...lines].map((f, i) => ({ key: `s${i}`, label: f, color: seriesColor(i), column: column(result, f) }));
  const rows = useMemo(
    () =>
      result.rows.map((r) => {
        const out: Record<string, Cell> = { [X_KEY]: r[x] ?? null };
        [...bars, ...lines].forEach((f, i) => (out[`s${i}`] = r[f] ?? null));
        return out;
      }),
    [result, x, bars, lines],
  );
  const byX = useMemo(() => (o.tooltip ? rowsByX(result, x) : null), [o.tooltip, result, x]);
  const extra = byX
    ? (label: string | number | undefined) => {
        const row = byX.get(JSON.stringify(label ?? null));
        return row ? (o.tooltip?.fields ?? []).map((f): [string, string] => [humanize(f), formatValue(row[f], pickFormat(nf, f), column(result, f), format)]) : [];
      }
    : undefined;
  const right = o.secondaryAxis ? 'right' : 'left';
  const xColumn = column(result, x);
  const fmtY = (v: unknown) => formatValue(v as never, yFormat, series[0]?.column, format, { compact: true });
  const fmtY2 = (v: unknown) => formatValue(v as never, y2Format, series[bars.length]?.column, format, { compact: true });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', cursor: marks.cursor }} role="img" aria-label={`Combo chart of ${bars.map(humanize).join(', ')} (bars)${lines.length ? ` and ${lines.map(humanize).join(', ')} (lines)` : ''} by ${humanize(x)}`}>
      <SeriesLegend series={series} pivoted={false} show={o.showLegend ?? true} />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ ...chrome.margin, right: o.secondaryAxis ? (o.y2Label ? 22 : 8) : chrome.margin.right }}
            onClick={((s: { activeLabel?: string | number } | null, e?: { shiftKey?: boolean }) => s?.activeLabel !== undefined && marks.onSelect(s.activeLabel, e)) as never}
          >
            {o.showGrid !== false && <CartesianGrid vertical={false} stroke={GRID_STROKE} />}
            <XAxis dataKey={X_KEY} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--bi-border)' }} minTickGap={16} tickFormatter={(v) => formatValue(v, xFormat, xColumn, format, { compact: true })} {...chrome.category} />
            <YAxis yAxisId="left" tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} tickFormatter={fmtY} {...chrome.value} />
            {o.secondaryAxis && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={fmtY2}
                {...(o.y2Label ? { label: { value: o.y2Label, angle: 90, position: 'right', offset: 2, className: 'bi-axis-label' } } : {})}
              />
            )}
            <Tooltip cursor={{ fill: 'var(--bi-hover)' }} content={<ChartTooltip xColumn={xColumn} xFormat={xFormat} yFormat={yFormat} series={series} pivoted={false} ctx={format} extra={extra} />} />
            {bars.map((_, i) => (
              <Bar key={`b${i}`} yAxisId="left" dataKey={`s${i}`} name={bars[i]} fill={series[i]!.color} stackId={o.stacked ? 'stack' : undefined} radius={o.stacked ? 0 : [4, 4, 0, 0]} isAnimationActive={false}>
                {rows.map((r, j) => (
                  <Mark key={j} fillOpacity={marks.opacity(r[X_KEY] ?? null)} />
                ))}
                {o.dataLabels && <LabelList dataKey={`s${i}`} position="top" className="bi-data-label" formatter={fmtY} />}
              </Bar>
            ))}
            {lines.map((_, k) => {
              const i = bars.length + k;
              return (
                <Line key={`l${k}`} yAxisId={right} dataKey={`s${i}`} name={lines[k]} type={o.curve === 'step' ? 'stepAfter' : o.curve} stroke={series[i]!.color} strokeWidth={2} dot={false} isAnimationActive={false}>
                  {o.dataLabels && <LabelList dataKey={`s${i}`} position="top" className="bi-data-label" formatter={fmtY2} />}
                </Line>
              );
            })}
            {referenceChildren(o, result.rows[0], { yAxisId: 'left' })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
