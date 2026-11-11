import type { AxisOptions, Format, NumberFormat, ResultColumn } from '@yourorg/bi-spec';
import { formatValue, humanize, type FormatContext } from '../format';
import type { SeriesDef } from './chartData';

export const AXIS_TICK = { fill: 'var(--bi-text-3)', fontSize: 12 };
/** Recessive grid: hairline, one step off the surface, solid. */
export const GRID_STROKE = 'var(--bi-grid)';

interface TooltipEntry {
  dataKey?: string | number;
  value?: number | string | null;
}

/** y columns are named by their column; pivoted series by their value. */
export const seriesLabel = (s: SeriesDef, pivoted: boolean) => (pivoted ? s.label : humanize(s.label));

/** Hover tooltip: values in text ink, identity carried by the swatch. */
export function ChartTooltip(props: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  xColumn?: ResultColumn;
  xFormat?: Format | NumberFormat;
  yFormat?: Format | NumberFormat;
  series: SeriesDef[];
  pivoted: boolean;
  ctx: FormatContext;
  /** Spec 1.3 tooltip fields: extra [label, text] lines for the hovered x value. */
  extra?: (label: string | number | undefined) => Array<[string, string]>;
}) {
  const { active, payload, label, xColumn, xFormat, yFormat, series, pivoted, ctx, extra } = props;
  if (!active || !payload?.length) return null;
  const byKey = new Map(series.map((s) => [s.key, s]));
  // Stacked charts list series bottom-up in the payload; show them in legend order instead.
  const entries = [...payload].sort((a, b) => series.findIndex((s) => s.key === a.dataKey) - series.findIndex((s) => s.key === b.dataKey));
  return (
    <div className="bi-tooltip">
      <div className="bi-tooltip-label">{formatValue(label ?? null, xFormat, xColumn, ctx)}</div>
      {entries.map((entry) => {
        const s = byKey.get(String(entry.dataKey));
        if (!s) return null;
        return (
          <div className="bi-tooltip-row" key={s.key}>
            <span className="bi-tooltip-key">
              <span className="bi-tooltip-swatch" style={{ background: s.color }} />
              {seriesLabel(s, pivoted)}
            </span>
            <span className="bi-tooltip-value">{formatValue(entry.value ?? null, yFormat, s.column, ctx)}</span>
          </div>
        );
      })}
      {extra?.(label).map(([k, v]) => (
        <div className="bi-tooltip-row" key={`x-${k}`}>
          <span className="bi-tooltip-key">{k}</span>
          <span className="bi-tooltip-value">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** Legend only for 2+ series; a single series is named by the widget title. */
export function SeriesLegend({ series, pivoted, show }: { series: SeriesDef[]; pivoted: boolean; show?: boolean }) {
  if (!(show ?? series.length > 1)) return null;
  return (
    <div className="bi-legend">
      {series.map((s) => (
        <span key={s.key}>
          <span className="bi-tooltip-swatch" style={{ background: s.color }} />
          {seriesLabel(s, pivoted)}
        </span>
      ))}
    </div>
  );
}

/**
 * Spec 1.2 axis options → Recharts props. `value` is the measure axis (y, or x on horizontal bars),
 * `category` the other one. Margins grow only when a title is shown, so default charts are unchanged.
 */
export function axisChrome(axis: AxisOptions | undefined, horizontal = false) {
  const cat = axis?.x;
  const val = axis?.y;
  const domain: [number | 'auto', number | 'auto'] | undefined =
    val?.min !== undefined || val?.max !== undefined ? [val?.min ?? 'auto', val?.max ?? 'auto'] : undefined;
  const bottomLabel = horizontal ? val?.label : cat?.label;
  const leftLabel = horizontal ? cat?.label : val?.label;
  return {
    category: {
      hide: cat?.hide ?? false,
      ...(cat?.label ? { label: horizontal ? { value: cat.label, angle: -90, position: 'left' as const, offset: 2, className: 'bi-axis-label' } : { value: cat.label, position: 'insideBottom' as const, offset: -4, className: 'bi-axis-label' } } : {}),
    },
    value: {
      hide: val?.hide ?? false,
      ...(domain ? { domain, allowDataOverflow: true } : {}),
      ...(val?.label ? { label: horizontal ? { value: val.label, position: 'insideBottom' as const, offset: -4, className: 'bi-axis-label' } : { value: val.label, angle: -90, position: 'left' as const, offset: 2, className: 'bi-axis-label' } } : {}),
    },
    // A rotated title sits outside the tick labels, so the chart gives it its own strip on the left.
    margin: { top: 6, right: 8, bottom: bottomLabel ? 18 : 0, left: leftLabel ? 22 : 0 },
  };
}

export function chartLabel(kind: string, series: SeriesDef[], pivoted: boolean, x: string, seriesField?: string): string {
  const what = pivoted ? `${humanize(series[0]?.column?.name ?? 'value')} by ${humanize(seriesField ?? '')}` : series.map((s) => humanize(s.label)).join(', ');
  return `${kind} of ${what} by ${humanize(x)}`;
}
