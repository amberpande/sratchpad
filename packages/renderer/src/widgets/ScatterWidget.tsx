import type { Cell, ScatterWidget as ScatterSpec } from '@yourorg/bi-spec';
import { useMemo, type MouseEvent } from 'react';
import { CartesianGrid, Cell as Mark, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { formatValue, humanize, pickFormat } from '../format';
import { referenceChildren, useMarks } from './vizParts';
import { seriesColor } from '../styles';
import { AXIS_TICK, axisChrome, GRID_STROKE } from './chartParts';
import { column, type WidgetProps } from './types';

interface PointTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: Record<string, Cell> }>;
}

/**
 * Scatter: two numeric measures, optional size. One series, so no legend (the title names it);
 * semi-opaque dots with a 2px surface ring keep overlaps legible.
 */
export default function ScatterWidget({ widget, result, format }: WidgetProps<ScatterSpec>) {
  const { x, y, size, label } = widget.encoding;
  const o = widget.options;
  const nf = o.numberFormats;
  // Custom number formats (1.3) win over the enum formats per column.
  const fmt = { x: pickFormat(nf, x, o.format?.x), y: pickFormat(nf, y, o.format?.y), size: pickFormat(nf, size, o.format?.size) };
  const marks = useMarks(label);
  const chrome = axisChrome(widget.options.axis);
  const xColumn = column(result, x);
  const yColumn = column(result, y);
  const sizeColumn = size ? column(result, size) : undefined;
  const labelColumn = label ? column(result, label) : undefined;
  // Points with a missing coordinate can't be placed; drop them rather than pin them to 0.
  const rows = useMemo(() => result.rows.filter((r) => typeof r[x] === 'number' && typeof r[y] === 'number'), [result, x, y]);
  const color = seriesColor(0);
  // Many points: smaller marks so the cloud stays readable.
  const range: [number, number] = size ? (rows.length > 300 ? [12, 160] : [24, 360]) : rows.length > 300 ? [28, 28] : [64, 64];

  const PointTooltip = ({ active, payload }: PointTooltipProps) => {
    const row = active ? payload?.[0]?.payload : undefined;
    if (!row) return null;
    const line = (name: string, value: string) => (
      <div className="bi-tooltip-row" key={name}>
        <span className="bi-tooltip-key">{name}</span>
        <span className="bi-tooltip-value">{value}</span>
      </div>
    );
    return (
      <div className="bi-tooltip">
        {label && <div className="bi-tooltip-label">{formatValue(row[label], undefined, labelColumn, format)}</div>}
        {line(humanize(x), formatValue(row[x], fmt?.x, xColumn, format))}
        {line(humanize(y), formatValue(row[y], fmt?.y, yColumn, format))}
        {size && line(humanize(size), formatValue(row[size], fmt?.size, sizeColumn, format))}
        {(o.tooltip?.fields ?? []).map((f) => line(humanize(f), formatValue(row[f], pickFormat(nf, f), column(result, f), format)))}
      </div>
    );
  };

  return (
    <div style={{ height: '100%' }} role="img" aria-label={`Scatter plot of ${humanize(y)} against ${humanize(x)}${size ? `, sized by ${humanize(size)}` : ''}`}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ ...chrome.margin, right: 12 }}>
          {widget.options.showGrid !== false && <CartesianGrid stroke={GRID_STROKE} />}
          <XAxis
            type="number"
            dataKey={(r: Record<string, Cell>) => r[x]}
            name={humanize(x)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--bi-border)' }}
            domain={['auto', 'auto']}
            tickFormatter={(v) => formatValue(v, fmt?.x, xColumn, format, { compact: true })}
            {...chrome.category}
          />
          <YAxis
            type="number"
            dataKey={(r: Record<string, Cell>) => r[y]}
            name={humanize(y)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            domain={['auto', 'auto']}
            tickFormatter={(v) => formatValue(v, fmt?.y, yColumn, format, { compact: true })}
            {...chrome.value}
          />
          <ZAxis type="number" dataKey={size ? (r: Record<string, Cell>) => r[size] : undefined} range={range} />
          <Tooltip cursor={{ stroke: 'var(--bi-text-3)', strokeWidth: 1, strokeDasharray: '3 3' }} content={<PointTooltip />} isAnimationActive={false} />
          {referenceChildren({ referenceLines: o.referenceLines }, result.rows[0])}
          <Scatter
            data={rows}
            fill={color}
            fillOpacity={0.7}
            stroke="var(--bi-surface)"
            strokeWidth={size ? 1 : 2}
            isAnimationActive={false}
            cursor={marks.cursor}
            onClick={(p: { payload?: Record<string, Cell> }, _i: number, e: MouseEvent) => label && p?.payload && marks.onSelect(p.payload[label] ?? null, e)}
          >
            {rows.map((r, i) => (
              <Mark key={i} fillOpacity={0.7 * (label ? marks.opacity(r[label] ?? null) : 1)} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
