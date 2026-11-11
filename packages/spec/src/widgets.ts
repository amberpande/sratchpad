import { z } from 'zod';
import { AxisOptionsSchema, HexColorSchema, STYLE_SINCE, type WidgetStyle } from './style';
import { V13 } from './ext';
import { widgetExtensionSince, type WidgetExtensionFields } from './widget-ext';
import { queryExtensionSince } from './query-ext';
import { dashboardExtensionSince } from './dashboard-ext';
import type { OutputColumn } from './query';
import { fieldSchema, type Query } from './schema';
import { compareSpecVersions, formatSpecVersion, parseSpecVersion, type SpecVersion } from './version';

/**
 * The widget-type registry: the single source of truth that authoring and the renderer both
 * validate against. Registering a type here (and a component in the renderer) is how the
 * catalog grows; a new type is a minor spec bump and records the version it arrived in.
 *
 * Versioning in practice (spec 1.1 is the worked example):
 * - a new type records `since` ("area-chart" arrived in 1.1), so a 1.0 document that uses it is
 *   an error, and a 1.0 renderer shows a placeholder for it instead of crashing;
 * - a new optional field on an existing type records its path in `fieldsSince`
 *   ("encoding.series" on line/bar charts arrived in 1.1), with the same two behaviours.
 */

export const FORMATS = ['number', 'integer', 'currency', 'percent', 'compact', 'date', 'month', 'text'] as const;
export const FormatSchema = z.enum(FORMATS);
export type Format = z.infer<typeof FormatSchema>;

const title = z.string().max(200).optional();

// ── 1.3 building blocks (formatting, references, tooltips) ─────────────────

/**
 * Since 1.3. A custom number format, used through `options.numberFormats` (keyed by result column),
 * which wins over the column's enum `format`. Constrained on purpose: no free format strings.
 */
export const NumberFormatSchema = z
  .object({
    decimals: z.number().int().min(0).max(6).optional(),
    prefix: z.string().max(8).optional(),
    suffix: z.string().max(8).optional(),
    /** Divide by 1e3/1e6/1e9 and append k/M/B; "auto" picks by magnitude. */
    scale: z.enum(['none', 'k', 'M', 'B', 'auto']).optional(),
    /** Multiply by 100 and append "%" (unless a suffix is given). */
    percent: z.boolean().optional(),
    /** Thousands separators (default true). */
    thousands: z.boolean().optional(),
  })
  .strict();
export type NumberFormat = z.infer<typeof NumberFormatSchema>;
const numberFormats = z.record(fieldSchema, NumberFormatSchema).optional();

/** A comparison against a constant, with the colors to apply when it matches. First match wins. */
export const ThresholdRuleSchema = z
  .object({
    op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between']),
    value: z.union([z.number(), z.array(z.number()).length(2)]),
    color: HexColorSchema.optional(),
    background: HexColorSchema.optional(),
  })
  .strict()
  .refine((r) => (r.op === 'between') === Array.isArray(r.value), '"between" takes [low, high]; other ops take one number')
  .refine((r) => Boolean(r.color || r.background), 'set "color" and/or "background"');
export type ThresholdRule = z.infer<typeof ThresholdRuleSchema>;

/** Since 1.3. Cell colors for one column: threshold rules, or a two/three-color scale over its values. */
export const ConditionalFormatSchema = z
  .object({
    field: fieldSchema,
    rules: z.array(ThresholdRuleSchema).min(1).max(10).optional(),
    scale: z.object({ from: HexColorSchema, to: HexColorSchema, mid: HexColorSchema.optional() }).strict().optional(),
  })
  .strict()
  .refine((c) => Boolean(c.rules) !== Boolean(c.scale), 'give either "rules" or "scale"');
export type ConditionalFormat = z.infer<typeof ConditionalFormatSchema>;
const conditionalFormats = z.array(ConditionalFormatSchema).max(20).optional();

const refValue = z.union([z.number(), z.string().max(64)]);
/** Since 1.3. A constant line (value) or a line at a column's value in the first row (field, e.g. a target). */
export const ReferenceLineSchema = z
  .object({
    axis: z.enum(['x', 'y']).default('y'),
    value: refValue.optional(),
    field: fieldSchema.optional(),
    label: z.string().max(60).optional(),
    color: HexColorSchema.optional(),
    dashed: z.boolean().optional(),
  })
  .strict()
  .refine((r) => (r.value === undefined) !== (r.field === undefined), 'give either "value" or "field"');
export const ReferenceBandSchema = z
  .object({ axis: z.enum(['x', 'y']).default('y'), from: refValue, to: refValue, label: z.string().max(60).optional(), color: HexColorSchema.optional() })
  .strict();
export const AnnotationSchema = z.object({ x: refValue, y: z.number().optional(), text: z.string().min(1).max(80) }).strict();
/** Since 1.3. Extra result columns shown in a chart's tooltip. */
export const TooltipSchema = z.object({ fields: z.array(fieldSchema).min(1).max(8) }).strict();
export type ReferenceLine = z.infer<typeof ReferenceLineSchema>;
export type ReferenceBand = z.infer<typeof ReferenceBandSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type TooltipOptions = z.infer<typeof TooltipSchema>;

const references = {
  referenceLines: z.array(ReferenceLineSchema).max(10).optional(),
  referenceBands: z.array(ReferenceBandSchema).max(5).optional(),
  annotations: z.array(AnnotationSchema).max(10).optional(),
};
const since13 = (...paths: string[]) => Object.fromEntries(paths.map((p) => [p, V13]));
/** 1.3 options shared by line, bar and area charts (and facets on their encoding). */
const CARTESIAN_V13 = since13('options.referenceLines', 'options.referenceBands', 'options.annotations', 'options.tooltip', 'options.numberFormats', 'encoding.facet');
const httpsUrl = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      return new URL(u).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https:// URL');
const yEncoding = z.union([fieldSchema, z.array(fieldSchema).min(1).max(8)]);
const axisFormat = z.object({ x: FormatSchema.optional(), y: FormatSchema.optional() }).strict();
const curve = z.enum(['linear', 'monotone', 'step']).default('monotone');

export const KpiOptionsSchema = z.object({
  title,
  /** Result column to show. */
  field: fieldSchema,
  /** How to collapse the result rows into one number (the result is already aggregated). */
  reduce: z.enum(['sum', 'avg', 'min', 'max', 'first', 'last', 'count']).default('sum'),
  label: z.string().max(200).optional(),
  format: FormatSchema.optional(),
  /** Since 1.3. Color the value by the first matching rule. */
  thresholds: z.array(ThresholdRuleSchema).max(10).optional(),
  /**
   * Since 1.3. A change column to show under the value (e.g. a percent_change window column):
   * ▲/▼ and the value, green when the change is good (`positiveIs`).
   */
  comparison: z
    .object({
      field: fieldSchema,
      label: z.string().max(60).optional(),
      positiveIs: z.enum(['up', 'down']).default('up'),
      display: z.enum(['percent', 'number']).default('percent'),
    })
    .strict()
    .optional(),
  numberFormats,
});

export const CartesianEncodingSchema = z.object({
  x: fieldSchema,
  /** One column, or several for multiple series. */
  y: yEncoding,
  /**
   * Since 1.1. Split one `y` column into a series per value of this column (long → wide), e.g.
   * revenue by month *per channel*. Needs a single `y`. More than 8 values fold into "Other".
   */
  series: fieldSchema.optional(),
  /** Since 1.3. Small multiples: one panel per value of this column (max 12), shared scales. */
  facet: fieldSchema.optional(),
});

/** Since 1.2 on line, bar and area charts (scatter: grid and axis). */
const chartChrome = {
  /** Gridlines (default on). */
  showGrid: z.boolean().optional(),
  /** Value labels on the marks. */
  dataLabels: z.boolean().optional(),
  axis: AxisOptionsSchema.optional(),
};
const CHROME_SINCE = { 'options.showGrid': STYLE_SINCE, 'options.dataLabels': STYLE_SINCE, 'options.axis': STYLE_SINCE } as const;

export const LineChartOptionsSchema = z.object({
  title,
  format: axisFormat.optional(),
  curve,
  showPoints: z.boolean().default(false),
  showLegend: z.boolean().optional(),
  ...chartChrome,
  ...references,
  tooltip: TooltipSchema.optional(),
  numberFormats,
});

export const BarChartOptionsSchema = z.object({
  title,
  format: axisFormat.optional(),
  orientation: z.enum(['vertical', 'horizontal']).default('vertical'),
  stacked: z.boolean().default(false),
  showLegend: z.boolean().optional(),
  ...chartChrome,
  ...references,
  tooltip: TooltipSchema.optional(),
  numberFormats,
});

export const TableColumnSchema = z
  .object({
    field: fieldSchema,
    label: z.string().max(200).optional(),
    format: FormatSchema.optional(),
    align: z.enum(['left', 'right']).optional(),
  })
  .strict();

export const TableOptionsSchema = z.object({
  title,
  /** Columns to show, in order. Defaults to every result column. */
  columns: z.array(TableColumnSchema).max(50).optional(),
  pageSize: z.number().int().min(1).max(500).default(50),
  /**
   * Since 1.1. "pages" shows a pager of `pageSize` rows; "scroll" shows every row in one
   * virtualized scroll area; "auto" pages short results and virtualizes long ones.
   */
  pagination: z.enum(['auto', 'pages', 'scroll']).default('auto'),
  /** Since 1.3. Click a header to sort the (already aggregated) rows. Default true. */
  sortable: z.boolean().optional(),
  conditionalFormats,
  /**
   * Since 1.3. Collapse a long result into one row per remaining columns with a mini line of
   * `value` over `by` (e.g. revenue by month per category). Reshaping only: values are not summed.
   */
  sparkline: z.object({ by: fieldSchema, value: fieldSchema, label: z.string().max(60).optional() }).strict().optional(),
  numberFormats,
});

// ── 1.1 types ───────────────────────────────────────────────────────────────

export const AreaChartOptionsSchema = z.object({
  title,
  format: axisFormat.optional(),
  curve,
  /** Stack series on top of each other (part-to-whole over time). */
  stacked: z.boolean().default(false),
  showLegend: z.boolean().optional(),
  ...chartChrome,
  ...references,
  tooltip: TooltipSchema.optional(),
  numberFormats,
});

export const ScatterEncodingSchema = z.object({
  /** Numeric result column on the horizontal axis. */
  x: fieldSchema,
  /** Numeric result column on the vertical axis. */
  y: fieldSchema,
  /** Optional numeric column mapped to mark area. */
  size: fieldSchema.optional(),
  /** Optional column naming each point in the tooltip (e.g. the region). */
  label: fieldSchema.optional(),
});

export const ScatterOptionsSchema = z.object({
  title,
  format: z.object({ x: FormatSchema.optional(), y: FormatSchema.optional(), size: FormatSchema.optional() }).strict().optional(),
  showGrid: chartChrome.showGrid,
  axis: chartChrome.axis,
  referenceLines: references.referenceLines,
  tooltip: TooltipSchema.optional(),
  numberFormats,
});

export const PIE_MAX_SLICES = 6;

export const PieEncodingSchema = z.object({
  /** Dimension column: one slice per value. */
  category: fieldSchema,
  /** Additive measure column (sum or count): slices are parts of one whole. */
  value: fieldSchema,
});

export const PieOptionsSchema = z.object({
  title,
  format: FormatSchema.optional(),
  /** At most 6 slices; the smallest categories beyond that fold into "Other". */
  maxSlices: z.number().int().min(2).max(PIE_MAX_SLICES).default(PIE_MAX_SLICES),
  /** Donut (default) or full pie. */
  donut: z.boolean().default(true),
  numberFormats,
});

export const PivotEncodingSchema = z.object({
  /** Dimension whose values become rows. */
  rows: fieldSchema,
  /** Dimension whose values become columns. */
  columns: fieldSchema,
  /** Measure shown in each cell. */
  value: fieldSchema,
});

export const PivotOptionsSchema = z.object({
  title,
  format: FormatSchema.optional(),
  /** Column order: as the query returned them, or sorted by value label. */
  columnOrder: z.enum(['data', 'asc', 'desc']).default('data'),
  /** Columns beyond this are not shown (never folded: that would aggregate in the browser). */
  maxColumns: z.number().int().min(1).max(100).default(50),
  /** Since 1.3. Color cells (use the value column's name as `field`). */
  conditionalFormats,
  numberFormats,
});

export const TextOptionsSchema = z.object({
  title,
  /**
   * Markdown-lite: paragraphs, "#"–"###" headings, "-" and "1." lists, **bold**, *italic*,
   * `code` and [links](https://…). Rendered as plain React elements, never as HTML.
   */
  text: z.string().max(10_000),
  align: z.enum(['left', 'center']).default('left'),
});

// ── 1.3 types ───────────────────────────────────────────────────────────────

const colorRange = z.object({ from: HexColorSchema, to: HexColorSchema }).strict();

export const MapEncodingSchema = z.object({
  /** Choropleth: country (name or ISO 3166 numeric code) or US state (name or postal code). */
  region: fieldSchema.optional(),
  value: fieldSchema.optional(),
  /** Symbol map: point coordinates (decimal degrees). */
  lat: fieldSchema.optional(),
  lon: fieldSchema.optional(),
  size: fieldSchema.optional(),
  label: fieldSchema.optional(),
});
export const MapOptionsSchema = z.object({
  title,
  basemap: z.enum(['world', 'usa']).default('world'),
  kind: z.enum(['choropleth', 'symbol']).default('choropleth'),
  /** Color scale for the value (default: the first series color, light to full). */
  colors: colorRange.optional(),
  format: FormatSchema.optional(),
  tooltip: TooltipSchema.optional(),
  numberFormats,
});

export const HeatmapEncodingSchema = z.object({ x: fieldSchema, y: fieldSchema, value: fieldSchema });
export const HeatmapOptionsSchema = z.object({
  title,
  colors: colorRange.optional(),
  showValues: z.boolean().default(false),
  format: FormatSchema.optional(),
  numberFormats,
});

export const TreemapEncodingSchema = z.object({ category: fieldSchema, value: fieldSchema, group: fieldSchema.optional() });
export const TreemapOptionsSchema = z.object({
  title,
  /** Largest rectangles shown; smaller ones are left out (never summed in the browser). */
  maxNodes: z.number().int().min(2).max(200).default(60),
  format: FormatSchema.optional(),
  numberFormats,
});

/** Columns of a five-number summary (e.g. min, p25, median, p75, max measures). */
export const BoxplotEncodingSchema = z.object({ category: fieldSchema, min: fieldSchema, q1: fieldSchema, median: fieldSchema, q3: fieldSchema, max: fieldSchema });
export const BoxplotOptionsSchema = z.object({ title, format: FormatSchema.optional(), axis: chartChrome.axis, numberFormats });

export const WaterfallEncodingSchema = z.object({ category: fieldSchema, value: fieldSchema });
export const WaterfallOptionsSchema = z.object({
  title,
  showTotal: z.boolean().default(true),
  totalLabel: z.string().max(40).default('Total'),
  colors: z.object({ increase: HexColorSchema.optional(), decrease: HexColorSchema.optional(), total: HexColorSchema.optional() }).strict().optional(),
  format: FormatSchema.optional(),
  numberFormats,
});

export const FunnelEncodingSchema = z.object({ stage: fieldSchema, value: fieldSchema });
export const FunnelOptionsSchema = z.object({ title, showConversion: z.boolean().default(true), format: FormatSchema.optional(), numberFormats });

export const GaugeOptionsSchema = z.object({
  title,
  /** Result column with the value (one-row result, or collapsed with `reduce`). */
  field: fieldSchema,
  reduce: z.enum(['sum', 'avg', 'min', 'max', 'first', 'last']).default('first'),
  min: z.number().default(0),
  /** Scale maximum: a constant, or a result column (`maxField`). One of the two is required. */
  max: z.number().optional(),
  maxField: fieldSchema.optional(),
  target: z.number().optional(),
  targetField: fieldSchema.optional(),
  /** Background bands up to a value (ascending). */
  bands: z.array(z.object({ to: z.number(), color: HexColorSchema }).strict()).max(5).optional(),
  label: z.string().max(200).optional(),
  format: FormatSchema.optional(),
  numberFormats,
});

export const BulletEncodingSchema = z.object({ value: fieldSchema, target: fieldSchema.optional(), category: fieldSchema.optional() });
export const BulletOptionsSchema = z.object({
  title,
  /** Qualitative ranges (absolute values, ascending), drawn as background shades. */
  ranges: z.array(z.number()).max(3).optional(),
  max: z.number().optional(),
  format: FormatSchema.optional(),
  numberFormats,
});

export const SankeyEncodingSchema = z.object({ source: fieldSchema, target: fieldSchema, value: fieldSchema });
export const SankeyOptionsSchema = z.object({
  title,
  nodeAlign: z.enum(['justify', 'left']).default('justify'),
  format: FormatSchema.optional(),
  numberFormats,
});

const fieldOrList = z.union([fieldSchema, z.array(fieldSchema).min(1).max(4)]);
/** Bars and lines on one x. `lines` may be left empty while authoring (it then draws bars only). */
export const ComboEncodingSchema = z.object({ x: fieldSchema, bars: fieldOrList, lines: fieldOrList.optional() });
export const ComboOptionsSchema = z.object({
  title,
  format: z.object({ x: FormatSchema.optional(), y: FormatSchema.optional(), y2: FormatSchema.optional() }).strict().optional(),
  /** Lines on their own right-hand axis (default true). */
  secondaryAxis: z.boolean().default(true),
  y2Label: z.string().max(80).optional(),
  stacked: z.boolean().default(false),
  curve,
  showLegend: z.boolean().optional(),
  ...chartChrome,
  ...references,
  tooltip: TooltipSchema.optional(),
  numberFormats,
});

export const ImageOptionsSchema = z.object({
  title,
  /** https:// only; other schemes are refused here and by the renderer. */
  src: httpsUrl,
  alt: z.string().min(1).max(300),
  fit: z.enum(['contain', 'cover']).default('contain'),
  href: httpsUrl.optional(),
  caption: z.string().max(200).optional(),
});

export type MapEncoding = z.infer<typeof MapEncodingSchema>;
export type MapOptions = z.infer<typeof MapOptionsSchema>;
export type HeatmapEncoding = z.infer<typeof HeatmapEncodingSchema>;
export type HeatmapOptions = z.infer<typeof HeatmapOptionsSchema>;
export type TreemapEncoding = z.infer<typeof TreemapEncodingSchema>;
export type TreemapOptions = z.infer<typeof TreemapOptionsSchema>;
export type BoxplotEncoding = z.infer<typeof BoxplotEncodingSchema>;
export type BoxplotOptions = z.infer<typeof BoxplotOptionsSchema>;
export type WaterfallEncoding = z.infer<typeof WaterfallEncodingSchema>;
export type WaterfallOptions = z.infer<typeof WaterfallOptionsSchema>;
export type FunnelEncoding = z.infer<typeof FunnelEncodingSchema>;
export type FunnelOptions = z.infer<typeof FunnelOptionsSchema>;
export type GaugeOptions = z.infer<typeof GaugeOptionsSchema>;
export type BulletEncoding = z.infer<typeof BulletEncodingSchema>;
export type BulletOptions = z.infer<typeof BulletOptionsSchema>;
export type SankeyEncoding = z.infer<typeof SankeyEncodingSchema>;
export type SankeyOptions = z.infer<typeof SankeyOptionsSchema>;
export type ComboEncoding = z.infer<typeof ComboEncodingSchema>;
export type ComboOptions = z.infer<typeof ComboOptionsSchema>;
export type ImageOptions = z.infer<typeof ImageOptionsSchema>;

export type KpiOptions = z.infer<typeof KpiOptionsSchema>;
export type CartesianEncoding = z.infer<typeof CartesianEncodingSchema>;
export type LineChartOptions = z.infer<typeof LineChartOptionsSchema>;
export type BarChartOptions = z.infer<typeof BarChartOptionsSchema>;
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type TableOptions = z.infer<typeof TableOptionsSchema>;
export type AreaChartOptions = z.infer<typeof AreaChartOptionsSchema>;
export type ScatterEncoding = z.infer<typeof ScatterEncodingSchema>;
export type ScatterOptions = z.infer<typeof ScatterOptionsSchema>;
export type PieEncoding = z.infer<typeof PieEncodingSchema>;
export type PieOptions = z.infer<typeof PieOptionsSchema>;
export type PivotEncoding = z.infer<typeof PivotEncodingSchema>;
export type PivotOptions = z.infer<typeof PivotOptionsSchema>;
export type TextOptions = z.infer<typeof TextOptionsSchema>;

/** Since 1.2, on every widget type; 1.3 extension fields (workstream B) ride along. */
interface Styled extends WidgetExtensionFields {
  style?: WidgetStyle;
}

export interface KpiWidget extends Styled {
  type: 'kpi';
  query: string;
  options: KpiOptions;
}
export interface LineChartWidget extends Styled {
  type: 'line-chart';
  query: string;
  encoding: CartesianEncoding;
  options: LineChartOptions;
}
export interface BarChartWidget extends Styled {
  type: 'bar-chart';
  query: string;
  encoding: CartesianEncoding;
  options: BarChartOptions;
}
export interface TableWidget extends Styled {
  type: 'table';
  query: string;
  options: TableOptions;
}
export interface AreaChartWidget extends Styled {
  type: 'area-chart';
  query: string;
  encoding: CartesianEncoding;
  options: AreaChartOptions;
}
export interface ScatterWidget extends Styled {
  type: 'scatter';
  query: string;
  encoding: ScatterEncoding;
  options: ScatterOptions;
}
export interface PieWidget extends Styled {
  type: 'pie';
  query: string;
  encoding: PieEncoding;
  options: PieOptions;
}
export interface PivotWidget extends Styled {
  type: 'pivot';
  query: string;
  encoding: PivotEncoding;
  options: PivotOptions;
}
/** Static content: the one widget type with no query. */
export interface TextWidget extends Styled {
  type: 'text';
  query?: undefined;
  options: TextOptions;
}

export interface MapWidget extends Styled {
  type: 'map';
  query: string;
  encoding: MapEncoding;
  options: MapOptions;
}
export interface HeatmapWidget extends Styled {
  type: 'heatmap';
  query: string;
  encoding: HeatmapEncoding;
  options: HeatmapOptions;
}
export interface TreemapWidget extends Styled {
  type: 'treemap';
  query: string;
  encoding: TreemapEncoding;
  options: TreemapOptions;
}
export interface BoxplotWidget extends Styled {
  type: 'boxplot';
  query: string;
  encoding: BoxplotEncoding;
  options: BoxplotOptions;
}
export interface WaterfallWidget extends Styled {
  type: 'waterfall';
  query: string;
  encoding: WaterfallEncoding;
  options: WaterfallOptions;
}
export interface FunnelWidget extends Styled {
  type: 'funnel';
  query: string;
  encoding: FunnelEncoding;
  options: FunnelOptions;
}
export interface GaugeWidget extends Styled {
  type: 'gauge';
  query: string;
  options: GaugeOptions;
}
export interface BulletWidget extends Styled {
  type: 'bullet';
  query: string;
  encoding: BulletEncoding;
  options: BulletOptions;
}
export interface SankeyWidget extends Styled {
  type: 'sankey';
  query: string;
  encoding: SankeyEncoding;
  options: SankeyOptions;
}
export interface ComboWidget extends Styled {
  type: 'combo';
  query: string;
  encoding: ComboEncoding;
  options: ComboOptions;
}
/** Static image (no query). */
export interface ImageWidget extends Styled {
  type: 'image';
  query?: undefined;
  options: ImageOptions;
}

/** A widget this reader does not know (only produced when rendering a newer minor version). */
export interface UnsupportedWidget {
  type: '__unsupported__';
  originalType: string;
  query?: string;
  title?: string;
  reason: string;
}

export type Widget =
  | KpiWidget
  | LineChartWidget
  | BarChartWidget
  | TableWidget
  | AreaChartWidget
  | ScatterWidget
  | PieWidget
  | PivotWidget
  | TextWidget
  | MapWidget
  | HeatmapWidget
  | TreemapWidget
  | BoxplotWidget
  | WaterfallWidget
  | FunnelWidget
  | GaugeWidget
  | BulletWidget
  | SankeyWidget
  | ComboWidget
  | ImageWidget;
export type RenderableWidget = Widget | UnsupportedWidget;
export type WidgetType = Widget['type'];

export interface FieldRef {
  /** Path inside the widget, e.g. "encoding.y.1". */
  path: string;
  field: string;
}

/** A problem a type-specific check found; `path` is relative to the widget. */
export interface WidgetIssue {
  path: string;
  code: string;
  message: string;
}

export interface WidgetCheckContext {
  /** Output columns of the widget's query (absent if the query itself is malformed). */
  columns?: OutputColumn[];
  query?: Query;
}

type WidgetShape = { encoding?: Record<string, unknown>; options: Record<string, unknown> };

export interface WidgetTypeDefinition {
  /** Spec version that introduced this type. */
  since: string;
  /** "none" for static widgets (text). Default "required". */
  query?: 'required' | 'none';
  /** Optional fields added after `since`, by path inside the widget: { "encoding.series": "1.1" }. */
  fieldsSince?: Record<string, string>;
  encoding?: z.AnyZodObject;
  options: z.AnyZodObject;
  /** Result columns the widget reads, so validation can check them against the query. */
  fieldRefs(widget: WidgetShape): FieldRef[];
  /** Type-specific rules that need the query (e.g. a pie must show an additive measure). */
  check?(widget: WidgetShape, ctx: WidgetCheckContext): WidgetIssue[];
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Column references inside 1.3 options (tooltips, reference lines, conditional formats). */
function optionRefs(options: Record<string, unknown> | undefined): FieldRef[] {
  const o = (options ?? {}) as { tooltip?: TooltipOptions; referenceLines?: ReferenceLine[]; conditionalFormats?: ConditionalFormat[] };
  const refs: FieldRef[] = [];
  (o.tooltip?.fields ?? []).forEach((f, i) => isStr(f) && refs.push({ path: `options.tooltip.fields.${i}`, field: f }));
  (o.referenceLines ?? []).forEach((r, i) => isStr(r.field) && refs.push({ path: `options.referenceLines.${i}.field`, field: r.field }));
  (o.conditionalFormats ?? []).forEach((c, i) => isStr(c.field) && refs.push({ path: `options.conditionalFormats.${i}.field`, field: c.field }));
  return refs;
}

function cartesianRefs(encoding: Record<string, unknown> | undefined, options?: Record<string, unknown>): FieldRef[] {
  const e = (encoding ?? {}) as CartesianEncoding;
  const ys = Array.isArray(e.y)
    ? e.y.map((field, i) => ({ path: `encoding.y.${i}`, field }))
    : isStr(e.y)
      ? [{ path: 'encoding.y', field: e.y }]
      : [];
  return [
    ...(isStr(e.x) ? [{ path: 'encoding.x', field: e.x }] : []),
    ...ys,
    ...(e.series ? [{ path: 'encoding.series', field: e.series }] : []),
    ...(e.facet ? [{ path: 'encoding.facet', field: e.facet }] : []),
    ...optionRefs(options),
  ];
}

/** Refs for every string-valued key of an encoding (new types name each column explicitly). */
function encodingRefs(encoding: Record<string, unknown> | undefined): FieldRef[] {
  const refs: FieldRef[] = [];
  for (const [k, v] of Object.entries(encoding ?? {})) {
    if (isStr(v)) refs.push({ path: `encoding.${k}`, field: v });
    else if (Array.isArray(v)) v.forEach((f, i) => isStr(f) && refs.push({ path: `encoding.${k}.${i}`, field: f }));
  }
  return refs;
}

/** Queries of reshape-only widgets may group by exactly the widget's dimensions (like pivot). */
function onlyDimensions(ctx: WidgetCheckContext, allowed: Array<string | undefined>, what: string): WidgetIssue[] {
  const keep = new Set(allowed.filter(isStr));
  const extra = ctx.columns?.filter((c) => c.role === 'dimension' && !keep.has(c.name)) ?? [];
  return extra.length
    ? [{ path: 'query', code: 'invalid_query_shape', message: `A ${what}'s query may only group by its own dimensions; remove ${extra.map((c) => `"${c.name}"`).join(', ')}.` }]
    : [];
}

function additive(ctx: WidgetCheckContext, path: string, field: string, what: string): WidgetIssue[] {
  const agg = roleOf(ctx, field)?.agg;
  return agg && agg !== 'sum' && agg !== 'count'
    ? [{ path, code: 'not_part_to_whole', message: `A ${what} shows parts of a whole, so its value must be a sum or count, not "${agg}".` }]
    : [];
}

function cartesianCheck({ encoding }: WidgetShape): WidgetIssue[] {
  const e = encoding as CartesianEncoding;
  if (e.series && Array.isArray(e.y) && e.y.length > 1) {
    return [{ path: 'encoding.series', code: 'invalid_value', message: '"series" splits a single y column; give y one column.' }];
  }
  return [];
}

const roleOf = (ctx: WidgetCheckContext, field: string) => ctx.columns?.find((c) => c.name === field);

function requireRole(ctx: WidgetCheckContext, path: string, field: string, role: OutputColumn['role'], why: string): WidgetIssue[] {
  const col = roleOf(ctx, field);
  // Unknown columns are reported by the generic fieldRefs check; don't double-report.
  if (!col || col.role === role) return [];
  return [{ path, code: 'invalid_role', message: `"${field}" must be a ${role} of the query: ${why}` }];
}

const CARTESIAN = { encoding: CartesianEncodingSchema, fieldsSince: { 'encoding.series': '1.1', ...CHROME_SINCE, ...CARTESIAN_V13 } } as const;

function cartesianCheckWithFacet(widget: WidgetShape, ctx: WidgetCheckContext): WidgetIssue[] {
  const e = widget.encoding as CartesianEncoding;
  const issues = cartesianCheck(widget);
  if (e.facet) issues.push(...requireRole(ctx, 'encoding.facet', e.facet, 'dimension', 'each panel is one value of a dimension.'));
  if (e.facet && (e.facet === e.x || e.facet === e.series)) issues.push({ path: 'encoding.facet', code: 'invalid_value', message: '"facet" must differ from x and series.' });
  return issues;
}

export const WIDGET_TYPES: Record<WidgetType, WidgetTypeDefinition> = {
  kpi: {
    since: '1.0',
    fieldsSince: since13('options.thresholds', 'options.comparison', 'options.numberFormats'),
    options: KpiOptionsSchema,
    fieldRefs: ({ options }) => {
      const o = options as KpiOptions;
      return [
        ...(isStr(o.field) ? [{ path: 'options.field', field: o.field }] : []),
        ...(o.comparison && isStr(o.comparison.field) ? [{ path: 'options.comparison.field', field: o.comparison.field }] : []),
      ];
    },
  },
  'line-chart': {
    since: '1.0',
    ...CARTESIAN,
    options: LineChartOptionsSchema,
    fieldRefs: ({ encoding, options }) => cartesianRefs(encoding, options),
    check: cartesianCheckWithFacet,
  },
  'bar-chart': {
    since: '1.0',
    ...CARTESIAN,
    options: BarChartOptionsSchema,
    fieldRefs: ({ encoding, options }) => cartesianRefs(encoding, options),
    check: cartesianCheckWithFacet,
  },
  table: {
    since: '1.0',
    fieldsSince: { 'options.pagination': '1.1', ...since13('options.sortable', 'options.conditionalFormats', 'options.sparkline', 'options.numberFormats') },
    options: TableOptionsSchema,
    fieldRefs: ({ options }) => {
      const o = options as TableOptions;
      return [
        ...(o.columns ?? []).map((c, i) => ({ path: `options.columns.${i}.field`, field: c.field })),
        ...optionRefs(options),
        ...(o.sparkline ? [{ path: 'options.sparkline.by', field: o.sparkline.by }, { path: 'options.sparkline.value', field: o.sparkline.value }] : []),
      ];
    },
  },
  'area-chart': {
    since: '1.1',
    encoding: CartesianEncodingSchema,
    fieldsSince: { ...CHROME_SINCE, ...CARTESIAN_V13 },
    options: AreaChartOptionsSchema,
    fieldRefs: ({ encoding, options }) => cartesianRefs(encoding, options),
    check: cartesianCheckWithFacet,
  },
  scatter: {
    since: '1.1',
    encoding: ScatterEncodingSchema,
    fieldsSince: { 'options.showGrid': STYLE_SINCE, 'options.axis': STYLE_SINCE, ...since13('options.referenceLines', 'options.tooltip', 'options.numberFormats') },
    options: ScatterOptionsSchema,
    fieldRefs: ({ encoding, options }) => [...encodingRefs(encoding), ...optionRefs(options)],
    check: ({ encoding }, ctx) => {
      const e = encoding as ScatterEncoding;
      const why = 'scatter axes are numeric.';
      return [
        ...requireRole(ctx, 'encoding.x', e.x, 'measure', why),
        ...requireRole(ctx, 'encoding.y', e.y, 'measure', why),
        ...(e.size ? requireRole(ctx, 'encoding.size', e.size, 'measure', 'size is numeric.') : []),
      ];
    },
  },
  pie: {
    since: '1.1',
    encoding: PieEncodingSchema,
    fieldsSince: since13('options.numberFormats'),
    options: PieOptionsSchema,
    fieldRefs: ({ encoding }) => {
      const e = encoding as PieEncoding;
      return [
        { path: 'encoding.category', field: e.category },
        { path: 'encoding.value', field: e.value },
      ];
    },
    check: ({ encoding }, ctx) => {
      const e = encoding as PieEncoding;
      const issues = [
        ...requireRole(ctx, 'encoding.category', e.category, 'dimension', 'each slice is one category.'),
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'slices are sized by a measure.'),
      ];
      // Pies are only for part-to-whole: slices must add up to a meaningful total.
      const agg = roleOf(ctx, e.value)?.agg;
      if (agg && agg !== 'sum' && agg !== 'count') {
        issues.push({
          path: 'encoding.value',
          code: 'not_part_to_whole',
          message: `A pie shows parts of a whole, so its value must be a sum or count, not "${agg}". Use a bar chart to compare ${agg} values.`,
        });
      }
      if (ctx.query && ctx.query.dimensions.length !== 1) {
        issues.push({ path: 'query', code: 'invalid_query_shape', message: 'A pie needs a query with exactly one dimension (its category).' });
      }
      return issues;
    },
  },
  pivot: {
    since: '1.1',
    encoding: PivotEncodingSchema,
    fieldsSince: since13('options.conditionalFormats', 'options.numberFormats'),
    options: PivotOptionsSchema,
    fieldRefs: ({ encoding, options }) => [...encodingRefs(encoding), ...optionRefs(options)],
    check: ({ encoding }, ctx) => {
      const e = encoding as PivotEncoding;
      const issues = [
        ...requireRole(ctx, 'encoding.rows', e.rows, 'dimension', 'pivot rows are dimension values.'),
        ...requireRole(ctx, 'encoding.columns', e.columns, 'dimension', 'pivot columns are dimension values.'),
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'pivot cells show a measure.'),
      ];
      if (e.rows === e.columns) issues.push({ path: 'encoding.columns', code: 'invalid_value', message: 'rows and columns must be different columns.' });
      // The renderer only reshapes. Any other dimension would put several rows in one cell,
      // which would force the browser to aggregate them.
      const extra = ctx.columns?.filter((c) => c.role === 'dimension' && c.name !== e.rows && c.name !== e.columns) ?? [];
      if (extra.length) {
        issues.push({
          path: 'query',
          code: 'invalid_query_shape',
          message: `A pivot's query may only group by its rows and columns; remove ${extra.map((c) => `"${c.name}"`).join(', ')}.`,
        });
      }
      return issues;
    },
  },
  text: {
    since: '1.1',
    query: 'none',
    options: TextOptionsSchema,
    fieldRefs: () => [],
  },

  // ── 1.3 ──
  map: {
    since: V13,
    encoding: MapEncodingSchema,
    options: MapOptionsSchema,
    fieldRefs: ({ encoding, options }) => [...encodingRefs(encoding), ...optionRefs(options)],
    check: ({ encoding, options }, ctx) => {
      const e = encoding as MapEncoding;
      const o = options as MapOptions;
      const issues: WidgetIssue[] = [];
      if (o.kind === 'symbol') {
        if (!e.lat || !e.lon) issues.push({ path: 'encoding', code: 'missing_field', message: 'A symbol map needs "lat" and "lon" columns.' });
        if (e.size) issues.push(...requireRole(ctx, 'encoding.size', e.size, 'measure', 'symbol size is numeric.'));
      } else {
        if (!e.region || !e.value) issues.push({ path: 'encoding', code: 'missing_field', message: 'A choropleth map needs "region" and "value" columns.' });
        if (e.region) issues.push(...requireRole(ctx, 'encoding.region', e.region, 'dimension', 'each shape is one region.'));
        if (e.value) issues.push(...requireRole(ctx, 'encoding.value', e.value, 'measure', 'regions are colored by a measure.'));
      }
      return issues;
    },
  },
  heatmap: {
    since: V13,
    encoding: HeatmapEncodingSchema,
    options: HeatmapOptionsSchema,
    fieldRefs: ({ encoding }) => encodingRefs(encoding),
    check: ({ encoding }, ctx) => {
      const e = encoding as HeatmapEncoding;
      return [
        ...requireRole(ctx, 'encoding.x', e.x, 'dimension', 'heatmap columns are dimension values.'),
        ...requireRole(ctx, 'encoding.y', e.y, 'dimension', 'heatmap rows are dimension values.'),
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'cells are colored by a measure.'),
        ...(e.x === e.y ? [{ path: 'encoding.y', code: 'invalid_value', message: 'x and y must be different columns.' }] : []),
        ...onlyDimensions(ctx, [e.x, e.y], 'heatmap'),
      ];
    },
  },
  treemap: {
    since: V13,
    encoding: TreemapEncodingSchema,
    options: TreemapOptionsSchema,
    fieldRefs: ({ encoding }) => encodingRefs(encoding),
    check: ({ encoding }, ctx) => {
      const e = encoding as TreemapEncoding;
      return [
        ...requireRole(ctx, 'encoding.category', e.category, 'dimension', 'each rectangle is one category.'),
        ...(e.group ? requireRole(ctx, 'encoding.group', e.group, 'dimension', 'groups are dimension values.') : []),
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'rectangles are sized by a measure.'),
        ...additive(ctx, 'encoding.value', e.value, 'treemap'),
        ...onlyDimensions(ctx, [e.category, e.group], 'treemap'),
      ];
    },
  },
  boxplot: {
    since: V13,
    encoding: BoxplotEncodingSchema,
    options: BoxplotOptionsSchema,
    fieldRefs: ({ encoding }) => encodingRefs(encoding),
    check: ({ encoding }, ctx) => {
      const e = encoding as BoxplotEncoding;
      const why = 'box plot statistics are measures (e.g. min, p25, median, p75, max).';
      return [
        ...requireRole(ctx, 'encoding.category', e.category, 'dimension', 'each box is one category.'),
        ...(['min', 'q1', 'median', 'q3', 'max'] as const).flatMap((k) => requireRole(ctx, `encoding.${k}`, e[k], 'measure', why)),
        ...onlyDimensions(ctx, [e.category], 'box plot'),
      ];
    },
  },
  waterfall: {
    since: V13,
    encoding: WaterfallEncodingSchema,
    options: WaterfallOptionsSchema,
    fieldRefs: ({ encoding }) => encodingRefs(encoding),
    check: ({ encoding }, ctx) => {
      const e = encoding as WaterfallEncoding;
      return [
        ...requireRole(ctx, 'encoding.category', e.category, 'dimension', 'each step is one category.'),
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'steps are signed amounts.'),
        ...onlyDimensions(ctx, [e.category], 'waterfall'),
      ];
    },
  },
  funnel: {
    since: V13,
    encoding: FunnelEncodingSchema,
    options: FunnelOptionsSchema,
    fieldRefs: ({ encoding }) => encodingRefs(encoding),
    check: ({ encoding }, ctx) => {
      const e = encoding as FunnelEncoding;
      return [
        ...requireRole(ctx, 'encoding.stage', e.stage, 'dimension', 'each step is one stage.'),
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'stages are sized by a measure.'),
        ...onlyDimensions(ctx, [e.stage], 'funnel'),
      ];
    },
  },
  gauge: {
    since: V13,
    options: GaugeOptionsSchema,
    fieldRefs: ({ options }) => {
      const o = options as GaugeOptions;
      return [
        ...(isStr(o.field) ? [{ path: 'options.field', field: o.field }] : []),
        ...(isStr(o.maxField) ? [{ path: 'options.maxField', field: o.maxField }] : []),
        ...(isStr(o.targetField) ? [{ path: 'options.targetField', field: o.targetField }] : []),
      ];
    },
    check: ({ options }) => {
      const o = options as GaugeOptions;
      const issues: WidgetIssue[] = [];
      if (o.max === undefined && !o.maxField) issues.push({ path: 'options.max', code: 'missing_field', message: 'A gauge needs "max" (a number) or "maxField" (a column).' });
      if (o.max !== undefined && o.max <= o.min) issues.push({ path: 'options.max', code: 'invalid_value', message: '"max" must be above "min".' });
      const tos = (o.bands ?? []).map((b) => b.to);
      if (tos.some((t, i) => i > 0 && t <= tos[i - 1]!)) issues.push({ path: 'options.bands', code: 'invalid_value', message: 'bands must be in ascending order of "to".' });
      return issues;
    },
  },
  bullet: {
    since: V13,
    encoding: BulletEncodingSchema,
    options: BulletOptionsSchema,
    fieldRefs: ({ encoding }) => encodingRefs(encoding),
    check: ({ encoding, options }, ctx) => {
      const e = encoding as BulletEncoding;
      const o = options as BulletOptions;
      const ranges = o.ranges ?? [];
      return [
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'the bar shows a measure.'),
        ...(e.target ? requireRole(ctx, 'encoding.target', e.target, 'measure', 'the target is a measure.') : []),
        ...(e.category ? requireRole(ctx, 'encoding.category', e.category, 'dimension', 'each bullet is one category.') : []),
        ...(ranges.some((r, i) => i > 0 && r <= ranges[i - 1]!) ? [{ path: 'options.ranges', code: 'invalid_value', message: 'ranges must be ascending.' }] : []),
        ...onlyDimensions(ctx, [e.category], 'bullet chart'),
      ];
    },
  },
  sankey: {
    since: V13,
    encoding: SankeyEncodingSchema,
    options: SankeyOptionsSchema,
    fieldRefs: ({ encoding }) => encodingRefs(encoding),
    check: ({ encoding }, ctx) => {
      const e = encoding as SankeyEncoding;
      return [
        ...requireRole(ctx, 'encoding.source', e.source, 'dimension', 'flows start at dimension values.'),
        ...requireRole(ctx, 'encoding.target', e.target, 'dimension', 'flows end at dimension values.'),
        ...requireRole(ctx, 'encoding.value', e.value, 'measure', 'flows are sized by a measure.'),
        ...additive(ctx, 'encoding.value', e.value, 'sankey'),
        ...(e.source === e.target ? [{ path: 'encoding.target', code: 'invalid_value', message: 'source and target must be different columns.' }] : []),
        ...onlyDimensions(ctx, [e.source, e.target], 'sankey'),
      ];
    },
  },
  combo: {
    since: V13,
    encoding: ComboEncodingSchema,
    options: ComboOptionsSchema,
    fieldRefs: ({ encoding, options }) => [...encodingRefs(encoding), ...optionRefs(options)],
    check: ({ encoding }, ctx) => {
      const e = encoding as ComboEncoding;
      const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
      return [
        ...list(e.bars).flatMap((f, i) => requireRole(ctx, Array.isArray(e.bars) ? `encoding.bars.${i}` : 'encoding.bars', f, 'measure', 'bars show measures.')),
        ...list(e.lines).flatMap((f, i) => requireRole(ctx, Array.isArray(e.lines) ? `encoding.lines.${i}` : 'encoding.lines', f, 'measure', 'lines show measures.')),
      ];
    },
  },
  image: {
    since: V13,
    query: 'none',
    options: ImageOptionsSchema,
    fieldRefs: () => [],
  },
};

export function isKnownWidgetType(type: string): type is WidgetType {
  return Object.prototype.hasOwnProperty.call(WIDGET_TYPES, type);
}

/** Whether a reader that understands `supported` knows this type (false for unknown types too). */
export function isWidgetTypeSupported(type: string, supported: SpecVersion): type is WidgetType {
  return isKnownWidgetType(type) && compareSpecVersions(parseSpecVersion(WIDGET_TYPES[type].since)!, supported) <= 0;
}

/** Whether this widget type runs a query (every type except static ones like "text"). */
export function widgetNeedsQuery(type: WidgetType): boolean {
  return WIDGET_TYPES[type].query !== 'none';
}

/** The query a widget reads, if any. Use instead of `widget.query` now that text widgets have none. */
export function widgetQueryId(widget: RenderableWidget): string | undefined {
  return widget.query;
}

/** Read a dotted path ("encoding.series") from a raw widget object. */
export function readWidgetPath(widget: Record<string, unknown>, path: string): unknown {
  let value: unknown = widget;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * The lowest specVersion a set of widgets needs. Authoring can write this instead of always
 * writing the newest version, so documents that use no 1.1 features still render fully on 1.0 SDKs.
 */
export function requiredSpecVersion(
  widgets: Record<string, { type: string; encoding?: unknown; options?: unknown; style?: unknown }>,
  doc: { theme?: unknown; queries?: unknown; [key: string]: unknown } = {},
): string {
  let need: SpecVersion = { major: 1, minor: 0 };
  const raise = (v: string) => {
    const parsed = parseSpecVersion(v);
    if (parsed && compareSpecVersions(parsed, need) > 0) need = parsed;
  };
  if (doc.theme !== undefined) raise(STYLE_SINCE);
  // 1.3 extensions: queries (A), dashboard-level and widget-level fields (B).
  if (doc.queries && typeof doc.queries === 'object') {
    for (const q of Object.values(doc.queries as Record<string, unknown>)) {
      const v = queryExtensionSince(q);
      if (v) raise(v);
    }
  }
  const dv = dashboardExtensionSince(doc);
  if (dv) raise(dv);
  for (const w of Object.values(widgets)) {
    if (!isKnownWidgetType(w.type)) continue;
    const def = WIDGET_TYPES[w.type];
    if (w.style !== undefined) raise(STYLE_SINCE);
    const wv = widgetExtensionSince(w as Record<string, unknown>);
    if (wv) raise(wv);
    raise(def.since);
    for (const [path, since] of Object.entries(def.fieldsSince ?? {})) {
      if (readWidgetPath(w as Record<string, unknown>, path) !== undefined) raise(since);
    }
  }
  return formatSpecVersion(need);
}
