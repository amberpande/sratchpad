import type { LineChartWidget as LineSpec } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { CartesianGrid, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValue } from '../format';
import { chartClick, facetDomain, useCartesianExtras } from './cartesianExtras';
import { cartesianData, X_KEY } from './chartData';
import { AXIS_TICK, axisChrome, chartLabel, ChartTooltip, GRID_STROKE, SeriesLegend } from './chartParts';
import { column, type WidgetProps } from './types';
import { Facets } from './vizParts';

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
  const { curve, showPoints, showLegend, showGrid, dataLabels, axis } = widget.options;
  const data = useMemo(() => cartesianData(result, widget.encoding), [result, widget.encoding]);
  const { marks, xFormat, yFormat, refs, extra } = useCartesianExtras(widget, result, data, format);
  const pivoted = Boolean(seriesField);
  const xColumn = column(result, x);
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
          <LineChart data={data.rows} margin={chrome.margin} onClick={chartClick(marks) as never}>
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
            {selectedX.map((v, i) => (
              <ReferenceLine key={`sel${i}`} x={v as string | number} stroke="var(--bi-accent, var(--bi-series-1))" strokeWidth={2} />
            ))}
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
              >
                {dataLabels && <LabelList dataKey={s.key} position="top" className="bi-data-label" formatter={formatY} />}
              </Line>
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
