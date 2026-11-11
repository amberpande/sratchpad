import type { Cell, HeatmapWidget as HeatmapSpec } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { formatValue, humanize, pickFormat } from '../format';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { extent, norm, scaleFill, useMarks, useSize } from './vizParts';

/**
 * Heatmap: x × y grid colored by value. Reshaping by cell lookup only (validation restricts the
 * query to the two dimensions, so each cell is exactly one result row).
 */
export default function HeatmapWidget({ widget, result, format }: WidgetProps<HeatmapSpec>) {
  const { x, y, value } = widget.encoding;
  const { colors, showValues } = widget.options;
  const fmt = pickFormat(widget.options.numberFormats, value, widget.options.format);
  const marks = useMarks(x);
  const [ref, size] = useSize<HTMLDivElement>();
  const grid = useMemo(() => {
    const xs: Cell[] = [];
    const ys: Cell[] = [];
    const seenX = new Set<string>();
    const seenY = new Set<string>();
    const cells = new Map<string, Cell>();
    for (const r of result.rows) {
      const kx = JSON.stringify(r[x] ?? null);
      const ky = JSON.stringify(r[y] ?? null);
      if (!seenX.has(kx)) (seenX.add(kx), xs.push(r[x] ?? null));
      if (!seenY.has(ky)) (seenY.add(ky), ys.push(r[y] ?? null));
      if (!cells.has(`${kx}|${ky}`)) cells.set(`${kx}|${ky}`, r[value] ?? null);
    }
    return { xs, ys, cells, range: extent([...cells.values()]) };
  }, [result, x, y, value]);

  if (!grid.xs.length) return <Message title="No data" />;
  const xMeta = column(result, x);
  const yMeta = column(result, y);
  const vMeta = column(result, value);
  const labelW = Math.min(140, 12 + Math.max(...grid.ys.map((v) => formatValue(v, undefined, yMeta, format).length), 3) * 7);
  const headH = 22;
  const w = Math.max(0, size.width - labelW);
  const h = Math.max(0, size.height - headH);
  const cw = w / grid.xs.length;
  const ch = h / grid.ys.length;

  return (
    <div ref={ref} style={{ height: '100%', cursor: marks.cursor }} role="img" aria-label={`Heatmap of ${humanize(value)} by ${humanize(x)} and ${humanize(y)}`}>
      {size.width > 0 && (
        <svg width={size.width} height={size.height} className="bi-heatmap">
          {grid.xs.map((xv, i) => (
            <text key={`x${i}`} x={labelW + i * cw + cw / 2} y={14} textAnchor="middle" className="bi-axis-text">
              {formatValue(xv, undefined, xMeta, format, { compact: true })}
            </text>
          ))}
          {grid.ys.map((yv, j) => (
            <text key={`y${j}`} x={labelW - 6} y={headH + j * ch + ch / 2} dominantBaseline="middle" textAnchor="end" className="bi-axis-text">
              {formatValue(yv, undefined, yMeta, format, { compact: true })}
            </text>
          ))}
          {grid.ys.map((yv, j) =>
            grid.xs.map((xv, i) => {
              const v = grid.cells.get(`${JSON.stringify(xv)}|${JSON.stringify(yv)}`);
              const has = typeof v === 'number' && grid.range;
              const fill = has ? scaleFill(norm(v as number, grid.range!), colors) : { fill: 'var(--bi-hover)', fillOpacity: 1 };
              const text = formatValue(v ?? null, fmt, vMeta, format);
              return (
                <g key={`${i}-${j}`} onClick={(e) => marks.onSelect(xv, e)} opacity={marks.opacity(xv)}>
                  <rect x={labelW + i * cw + 1} y={headH + j * ch + 1} width={Math.max(0, cw - 2)} height={Math.max(0, ch - 2)} rx={3} fill={fill.fill} fillOpacity={fill.fillOpacity}>
                    <title>{`${formatValue(yv, undefined, yMeta, format)} · ${formatValue(xv, undefined, xMeta, format)}: ${text}`}</title>
                  </rect>
                  {showValues && cw > 34 && ch > 16 && (
                    <text x={labelW + i * cw + cw / 2} y={headH + j * ch + ch / 2} textAnchor="middle" dominantBaseline="middle" className="bi-cell-text">
                      {formatValue(v ?? null, fmt, vMeta, format, { compact: true })}
                    </text>
                  )}
                </g>
              );
            }),
          )}
        </svg>
      )}
    </div>
  );
}
