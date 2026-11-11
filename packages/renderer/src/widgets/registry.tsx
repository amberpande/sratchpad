import type { Widget, WidgetType } from '@yourorg/bi-spec';
import { lazy, type ComponentType } from 'react';
import { KpiWidget } from './KpiWidget';
import { PivotWidget } from './PivotWidget';
import { TableWidget } from './TableWidget';
import { TextWidget } from './TextWidget';
import { ImageWidget } from './ImageWidget';
import type { WidgetProps } from './types';

/**
 * Widget registry: spec `type` → React component. Its keys must match the spec package's
 * WIDGET_TYPES (enforced by the type below), so authoring and rendering never drift.
 * Chart types are code-split: a host app only downloads the chart library when it renders a chart.
 * Tables, pivots, KPIs and text need no chart library, so they stay in the main chunk.
 */
type Registry = { [K in WidgetType]: ComponentType<WidgetProps<Extract<Widget, { type: K }>>> };

export const widgetComponents: Registry = {
  kpi: KpiWidget,
  table: TableWidget,
  pivot: PivotWidget,
  text: TextWidget,
  'line-chart': lazy(() => import('./LineChartWidget')),
  'bar-chart': lazy(() => import('./BarChartWidget')),
  'area-chart': lazy(() => import('./AreaChartWidget')),
  scatter: lazy(() => import('./ScatterWidget')),
  pie: lazy(() => import('./PieWidget')),
  // 1.3: every new chart is its own chunk (maps carry ~200 KB of geodata, sankey/treemap d3 layouts).
  image: ImageWidget,
  map: lazy(() => import('./MapWidget')),
  heatmap: lazy(() => import('./HeatmapWidget')),
  treemap: lazy(() => import('./TreemapWidget')),
  boxplot: lazy(() => import('./BoxplotWidget')),
  waterfall: lazy(() => import('./WaterfallWidget')),
  funnel: lazy(() => import('./FunnelWidget')),
  gauge: lazy(() => import('./GaugeWidget')),
  bullet: lazy(() => import('./BulletWidget')),
  sankey: lazy(() => import('./SankeyWidget')),
  combo: lazy(() => import('./ComboWidget')),
};

/** Chart types: these get a "View as table" toggle (the accessible alternative to the plot). */
export const CHART_TYPES: ReadonlySet<WidgetType> = new Set([
  'line-chart',
  'bar-chart',
  'area-chart',
  'scatter',
  'pie',
  'map',
  'heatmap',
  'treemap',
  'boxplot',
  'waterfall',
  'funnel',
  'gauge',
  'bullet',
  'sankey',
  'combo',
]);

export function componentFor(widget: Widget): ComponentType<WidgetProps<Widget>> {
  return widgetComponents[widget.type] as ComponentType<WidgetProps<Widget>>;
}
