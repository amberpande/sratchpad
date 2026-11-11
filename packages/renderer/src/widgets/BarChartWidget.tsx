import type { BarChartWidget as BarSpec } from '@yourorg/bi-spec';
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValue } from '../format';
import { chartClick, facetDomain, useCartesianExtras } from './cartesianExtras';
import { cartesianData, X_KEY } from './chartData';
import { AXIS_TICK, axisChrome, chartLabel, ChartTooltip, GRID_STROKE, SeriesLegend } from './chartParts';
import { column, type WidgetProps } from './types';
import { Facets } from './vizParts';

export default function BarChartWidget(props: WidgetProps<BarSpec>) {
  const { widget, result, format } = props;
  const { facet } = widget.encoding;
  if (facet) {
    const domain = widget.options.stacked ? undefined : facetDomain(widget, result);
    return <Facets result={result} facet={facet} label={(v) => formatValue(v, undefined, column(result, facet), format)} render={(r) => <BarPlot {...props} result={r} domain={domain} />} />;
  }
  return <BarPlot {...props} />;
}

function BarPlot({ widget, result, format, domain }: WidgetProps<BarSpec> & { domain?: [number, number] }) {
  const { x, series: seriesField } = widget.encoding;
  const { orientation, stacked, showLegend, showGrid, dataLabels, axis } = widget.options;
  const data = useMemo(() => cartesianData(result, widget.encoding), [result, widget.encoding]);
  const horizontal = orientation === 'horizontal';
  const { marks, xFormat, yFormat, refs, extra } = useCartesianExtras(widget, result, data, format, { horizontal });
  const pivoted = Boolean(seriesField);
  const chrome = axisChrome(axis, horizontal);
  const xColumn = column(result, x);
  const formatX = (v: unknown) => formatValue(v as never, xFormat, xColumn, format, { compact: true });
  const formatY = (v: unknown) => formatValue(v as never, yFormat, data.series[0]?.column, format, { compact: true });
  // Rounded corners only on the data end (away from the baseline).
  const end: [number, number, number, number] = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
  const labelWidth = horizontal ? Math.min(140, 12 + Math.max(...data.rows.map((r) => formatX(r[X_KEY]).length), 4) * 7) : 0;
  const valueProps = { ...(domain && !chrome.value.domain ? { domain } : {}), ...chrome.value };

  const categoryAxis = horizontal ? (
    <YAxis type="category" dataKey={X_KEY} tick={AXIS_TICK} tickLine={false} axisLine={false} width={labelWidth} tickFormatter={formatX} {...chrome.category} />
  ) : (
    <XAxis dataKey={X_KEY} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--bi-border)' }} minTickGap={8} tickFormatter={formatX} {...chrome.category} />
  );
  const valueAxis = horizontal ? (
    <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={formatY} {...valueProps} />
  ) : (
    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} tickFormatter={formatY} {...valueProps} />
  );
  const last = data.series.length - 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', cursor: marks.cursor }} role="img" aria-label={chartLabel('Bar chart', data.series, pivoted, x, seriesField)}>
      <SeriesLegend series={data.series} pivoted={pivoted} show={showLegend} />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data.rows}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={{ ...chrome.margin, right: dataLabels && horizontal ? 40 : chrome.margin.right, top: dataLabels && !horizontal ? 18 : chrome.margin.top }}
            barCategoryGap="24%"
            barGap={2}
            onClick={chartClick(marks) as never}
          >
            {showGrid !== false && <CartesianGrid horizontal={!horizontal} vertical={horizontal} stroke={GRID_STROKE} />}
            {categoryAxis}
            {valueAxis}
            <Tooltip
              cursor={{ fill: 'var(--bi-hover)' }}
              content={<ChartTooltip xColumn={xColumn} xFormat={xFormat} yFormat={yFormat} series={data.series} pivoted={pivoted} ctx={format} extra={extra} />}
            />
            {data.series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                stackId={stacked ? 'stack' : undefined}
                radius={!stacked || i === last ? end : 0}
                stroke={stacked ? 'var(--bi-surface)' : undefined}
                strokeWidth={stacked ? 2 : 0}
                isAnimationActive={false}
              >
                {data.rows.map((r, j) => (
                  <Cell key={j} fillOpacity={marks.opacity(r[X_KEY] ?? null)} />
                ))}
                {dataLabels && (
                  <LabelList dataKey={s.key} position={stacked ? 'center' : horizontal ? 'right' : 'top'} className="bi-data-label" formatter={formatY} />
                )}
              </Bar>
            ))}
            {/* After the marks, so reference labels are never hidden behind bars. */}
            {refs}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
