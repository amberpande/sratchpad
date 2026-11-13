import type { LineChartWidget as LineSpec } from '@yourorg/bi-spec';
import { useMemo, useRef, useState } from 'react';
import { useWidgetInteractions } from '../interactions';
import { Area, CartesianGrid, ComposedChart, LabelList, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValue } from '../format';
import { chartClick, facetDomain, useCartesianExtras } from './cartesianExtras';
import { cartesianData, X_KEY } from './chartData';
import { AXIS_TICK, axisChrome, chartLabel, ChartTooltip, GRID_STROKE, SeriesLegend } from './chartParts';
import { column, type WidgetProps } from './types';
import { Facets, useMarks } from './vizParts';
import { withTrend } from './trend';

export default function LineChartWidget(props: WidgetProps<LineSpec>) {
  const { widget, result, format } = props;
  const { facet } = widget.encoding;
  if (facet) {
    const domain = facetDomain(widget, result);
    return <Facets result={result} facet={facet} label={(v) => formatValue(v, undefined, column(result, facet), format)} render={(r) => <LinePlot {...props} result={r} domain={domain} />} />;
  }
  return <LinePlot {...props} />;
}

function LinePlot({ widget, result, format, domain }: WidgetProps<LineSpec> & { domain?: [number, number] }) {
  const { x, series: seriesField } = widget.encoding;
  const xColumn = column(result, x);
  const { curve, showPoints, showLegend, showGrid, dataLabels, axis } = widget.options;
  const base = useMemo(() => cartesianData(result, widget.encoding), [result, widget.encoding]);
  const { trend } = widget.options as { trend?: { type?: 'linear' | 'moving_average'; forecast?: number; window?: number } };
  // Trend lines and forecasts (1.4): extra keys on the rows; forecast rows extend the x axis.
  const trended = useMemo(
    () => (trend ? withTrend(base.rows as never, base.series.map((s) => s.key), X_KEY, column(result, x), trend) : null),
    [base, trend, result, x],
  );
  const data = trended ? { ...base, rows: trended.rows as typeof base.rows } : base;
  const { marks, xFormat, yFormat, refs, extra } = useCartesianExtras(widget, result, data, format);
  const seriesMarks = useMarks(seriesField);
  // Brush (1.4, D-090): drag across a time axis to cross-filter by the whole range.
  const it = useWidgetInteractions();
  const brushable = Boolean(it.selectRange) && it.interactive && xColumn?.type === 'time';
  const [drag, setDrag] = useState<{ from: string; to: string } | null>(null);
  const dragged = useRef(false);
  const label = (s: { activeLabel?: string | number } | null) => (s && typeof s.activeLabel === 'string' ? s.activeLabel : null);
  const brush = brushable
    ? {
        onMouseDown: (s: { activeLabel?: string | number } | null) => {
          const v = label(s);
          dragged.current = false;
          if (v) setDrag({ from: v, to: v });
        },
        onMouseMove: (s: { activeLabel?: string | number } | null) => {
          const v = label(s);
          if (drag && v && v !== drag.to) setDrag({ ...drag, to: v });
        },
        onMouseUp: () => {
          if (drag && drag.from !== drag.to) {
            dragged.current = true;
            it.selectRange!({ field: x, from: drag.from, to: drag.to });
          }
          setDrag(null);
        },
      }
    : {};
  const click = chartClick(marks);
  const onChartClick = (state: Parameters<typeof click>[0], event?: Parameters<typeof click>[1]) => {
    if (dragged.current) {
      dragged.current = false; // the click that ends a drag is not a second selection
      return;
    }
    click(state, event);
  };
  const pivoted = Boolean(seriesField);
  const curveType = curve === 'step' ? 'stepAfter' : curve;
  const chrome = axisChrome(axis);
  const formatY = (v: unknown) => formatValue(v as never, yFormat, data.series[0]?.column, format, { compact: true });
  const valueAxis = { ...(domain && !chrome.value.domain ? { domain } : {}), ...chrome.value };
  const selectedX = data.rows.map((r) => r[X_KEY]).filter((v) => marks.selected(v ?? null));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', cursor: marks.cursor }} role="img" aria-label={chartLabel('Line chart', data.series, pivoted, x, seriesField)}>
      <SeriesLegend series={data.series} pivoted={pivoted} show={showLegend} />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data.rows} margin={chrome.margin} onClick={onChartClick as never} {...(brush as object)}>
            {showGrid !== false && <CartesianGrid vertical={false} stroke={GRID_STROKE} />}
            <XAxis
              dataKey={X_KEY}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: 'var(--bi-border)' }}
              minTickGap={24}
              tickFormatter={(v) => formatValue(v, xFormat, xColumn, format, { compact: true })}
              {...chrome.category}
            />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} tickFormatter={formatY} {...valueAxis} />
            <Tooltip
              cursor={{ stroke: 'var(--bi-text-3)', strokeWidth: 1, strokeDasharray: '3 3' }}
              content={<ChartTooltip xColumn={xColumn} xFormat={xFormat} yFormat={yFormat} series={data.series} pivoted={pivoted} ctx={format} extra={extra} />}
            />
            {refs}
            {drag && drag.from !== drag.to && <ReferenceArea x1={drag.from} x2={drag.to} fill="var(--bi-accent, var(--bi-series-1))" fillOpacity={0.12} />}
            {selectedX.length > 2 ? (
              // A brushed range: one band, not a line per bucket.
              <ReferenceArea x1={selectedX[0] as string} x2={selectedX[selectedX.length - 1] as string} fill="var(--bi-accent, var(--bi-series-1))" fillOpacity={0.1} stroke="var(--bi-accent, var(--bi-series-1))" strokeOpacity={0.4} />
            ) : (
              selectedX.map((v, i) => <ReferenceLine key={`sel${i}`} x={v as string | number} stroke="var(--bi-accent, var(--bi-series-1))" strokeWidth={2} />)
            )}
            {data.series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                type={curveType}
                stroke={s.color}
                strokeWidth={2}
                dot={showPoints ? { r: 4, strokeWidth: 2, stroke: 'var(--bi-surface)', fill: s.color } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--bi-surface)', fill: s.color }}
                isAnimationActive={false}
                connectNulls={false}
                onClick={seriesField ? (_p: unknown, e?: { shiftKey?: boolean }) => seriesMarks.onSelect(s.value ?? null, e) : undefined}
              >
                {dataLabels && <LabelList dataKey={s.key} position="top" className="bi-data-label" formatter={formatY} />}
              </Line>
            ))}
            {trended?.bandKeys.map((k) => {
              const s = data.series.find((x) => `${x.key}__band` === k);
              return <Area key={k} dataKey={k} name={`${s?.label ?? ''} forecast range`} stroke="none" fill={s?.color} fillOpacity={0.12} isAnimationActive={false} legendType="none" />;
            })}
            {trended?.trendKeys.map((k) => {
              const s = data.series.find((x) => `${x.key}__trend` === k);
              return (
                <Line key={k} dataKey={k} name={`${s?.label ?? ''} ${trend?.type === 'moving_average' ? 'moving average' : 'trend'}`} stroke={s?.color} strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} legendType="none" connectNulls />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
