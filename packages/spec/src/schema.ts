import { z } from 'zod';
import { DashboardThemeSchema } from './style';
import { EXTRA_PARAM_SCHEMAS, type ExtraParam } from './params-ext';
import { QueryExtensionShape } from './query-ext';

/**
 * Structural schema for spec v1.
 *
 * A dashboard keeps three concerns apart:
 *   layout  – where widgets sit (a 12-column grid, the react-grid-layout shape)
 *   widgets – what each one is and how it looks
 *   queries – what data each one needs, declared as a semantic request (never SQL)
 *
 * Discriminators such as widget `type` are plain strings here; whether a value is *known*
 * depends on the reader's version, so that is decided in `validateDashboard`.
 */

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const idSchema = z
  .string()
  .regex(ID_PATTERN, 'must start with a letter and use only letters, digits, "_" or "-" (max 64)');
export const fieldSchema = z.string().min(1).max(128);

// ── Data sources ────────────────────────────────────────────────────────────

export const DATA_SOURCE_TYPES = ['sample', 'file', 'snowflake'] as const;
export type DataSourceType = (typeof DATA_SOURCE_TYPES)[number];

export const DataSourceSchema = z.object({
  type: z.string().min(1),
  ref: z.string().min(1).max(512),
});

// ── Semantic queries ────────────────────────────────────────────────────────

export const TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const TimeGrainSchema = z.enum(TIME_GRAINS);

export const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const FILTER_OPS = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'not_null',
  // Since 1.3: case-insensitive matching on string columns (search filters).
  'contains', 'starts_with', 'ends_with',
] as const;
/** Filter operators added in spec 1.3. */
export const FILTER_OPS_13: readonly string[] = ['contains', 'starts_with', 'ends_with'];

/** The value rules shared by filters and bucket rules. */
function checkOpValue(op: string, value: unknown, ctx: z.RefinementCtx) {
  const isList = Array.isArray(value);
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message });
  switch (op) {
    case 'is_null':
    case 'not_null':
      if (value !== undefined) fail(`"${op}" takes no value`);
      break;
    case 'in':
    case 'not_in':
      if (!isList || (value as unknown[]).length === 0) fail(`"${op}" needs a non-empty array value`);
      break;
    case 'between':
      if (!isList || (value as unknown[]).length !== 2) fail('"between" needs a [low, high] array value');
      break;
    case 'contains':
    case 'starts_with':
    case 'ends_with':
      if (typeof value !== 'string' || !value) fail(`"${op}" needs a non-empty string value`);
      break;
    default:
      if (value === undefined || value === null || isList) fail(`"${op}" needs a single non-null value`);
  }
}

/** Since 1.3: a CASE-style rule of a calculated (bucketed) dimension. */
export const BucketRuleSchema = z
  .object({
    op: z.enum(FILTER_OPS),
    value: z.union([ScalarSchema, z.array(ScalarSchema)]).optional(),
    label: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((rule, ctx) => checkOpValue(rule.op, rule.value, ctx));

export const DimensionSchema = z.object({
  field: fieldSchema,
  grain: TimeGrainSchema.optional(),
  as: fieldSchema.optional(),
  /** Since 1.4: group values into a dashboard set's label and "Other" (D-086). */
  set: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
  /** Since 1.3: numeric bins of `width` (histograms): floor((x - offset) / width) * width + offset. */
  bin: z
    .object({ width: z.number().positive().finite(), offset: z.number().finite().optional() })
    .strict()
    .optional(),
  /** Since 1.3: CASE-style buckets: the first matching rule's label, else `else` (default NULL). */
  buckets: z
    .object({ rules: z.array(BucketRuleSchema).min(1).max(50), else: z.string().max(200).nullable().optional() })
    .strict()
    .optional(),
});

export const AGGREGATIONS = [
  'sum', 'avg', 'min', 'max', 'count', 'count_distinct',
  // Since 1.3 (numeric columns): continuous percentiles and the sample standard deviation.
  'median', 'p25', 'p75', 'p90', 'stddev',
] as const;
/** Aggregations added in spec 1.3. */
export const AGGREGATIONS_13: readonly string[] = ['median', 'p25', 'p75', 'p90', 'stddev'];
export const MeasureSchema = z.object({
  /** A source column, or "*" with `count` to count rows. */
  field: fieldSchema,
  agg: z.enum(AGGREGATIONS),
  as: fieldSchema.optional(),
});

export const FilterSchema = z
  .object({
    field: fieldSchema,
    op: z.enum(FILTER_OPS),
    value: z.union([ScalarSchema, z.array(ScalarSchema)]).optional(),
    /** Since 1.4: with op in / not_in, the values of a dashboard set (instead of `value`) (D-086). */
    set: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
  })
  .superRefine((filter, ctx) => {
    if (filter.set === undefined) return checkOpValue(filter.op, filter.value, ctx);
    if (filter.op !== 'in' && filter.op !== 'not_in') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['op'], message: 'A set filter uses op "in" or "not_in".' });
    if (filter.value !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Give either "set" or "value", not both.' });
  });

/** Since 1.4: a named, reusable set of values of one column (e.g. "top customers") (D-086). */
export const ValueSetSchema = z
  .object({
    field: fieldSchema,
    values: z.array(ScalarSchema).min(1).max(1000),
    /** Label for members when the set groups a dimension (default: the set id). */
    label: z.string().min(1).max(200).optional(),
    /** Label for everything else (default "Other"). */
    otherLabel: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ValueSet = z.infer<typeof ValueSetSchema>;

export const OrderBySchema = z.object({
  /** An output column of the query: a dimension or a measure alias. */
  field: fieldSchema,
  dir: z.enum(['asc', 'desc']).default('asc'),
});

export const DEFAULT_QUERY_LIMIT = 1000;
/** Result-size cap. Widgets render small, already-aggregated result sets. */
export const MAX_QUERY_LIMIT = 10_000;

export const QuerySchema = z.object({
  source: idSchema,
  dimensions: z.array(DimensionSchema).max(8).default([]),
  measures: z.array(MeasureSchema).max(16).default([]),
  filters: z.array(FilterSchema).max(32).default([]),
  orderBy: z.array(OrderBySchema).max(8).default([]),
  limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(DEFAULT_QUERY_LIMIT),
  // Spec 1.3+ query features (workstream A): see query-ext.ts.
  ...QueryExtensionShape,
  /**
   * Since 1.4, level of detail (D-084): aggregate first at the query's dimensions plus these finer
   * dimensions (e.g. per customer), then the query's measures aggregate those results by name
   * ("average of each customer's total, by region"). Filters on a detail measure apply after it.
   */
  detail: z
    .object({
      dimensions: z.array(DimensionSchema).min(1).max(4),
      measures: z.array(MeasureSchema).min(1).max(8),
    })
    .strict()
    .optional(),
});

// ── Widgets & layout ────────────────────────────────────────────────────────

export const WidgetSchema = z.object({
  type: z.string().min(1),
  query: idSchema.optional(),
  encoding: z.record(z.unknown()).optional(),
  options: z.record(z.unknown()).optional(),
  /** Since 1.2. Validated by WidgetStyleSchema in validateDashboard (version-gated). */
  style: z.record(z.unknown()).optional(),
  /** Since 1.3 (workstream B): validated and version-gated in widget-ext.ts. Declared so parsing keeps them. */
  drill: z.unknown().optional(),
  drillThrough: z.unknown().optional(),
  interactions: z.unknown().optional(),
  /** Since 1.4: show the widget only when a dashboard control matches (widget-ext.ts, D-089). */
  visibleWhen: z.unknown().optional(),
});

export const GRID_COLUMNS = 12;
export const LayoutItemSchema = z.object({
  i: idSchema,
  x: z.number().int().min(0).max(GRID_COLUMNS - 1),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(GRID_COLUMNS),
  h: z.number().int().min(1).max(48),
  /** Since 1.3: the tab this item is on (see dashboard `tabs`; validated in dashboard-ext.ts). */
  tab: idSchema.optional(),
});

// ── Params (dashboard-level controls bound into queries) ────────────────────

export const DATE_PRESETS = ['last_7d', 'last_30d', 'last_90d', 'last_365d', 'mtd', 'qtd', 'ytd', 'all'] as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are "YYYY-MM-DD"');

export const DateRangeValueSchema = z.union([
  z.enum(DATE_PRESETS),
  z
    .object({ from: isoDate, to: isoDate })
    .strict()
    .refine((v) => v.from <= v.to, '"from" must not be after "to"'),
]);

export const BindTargetSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}\.filters$/, 'bind targets look like "<queryId>.filters"');

export const DateRangeParamSchema = z.object({
  type: z.literal('daterange'),
  label: z.string().max(100).optional(),
  /** Source date column to filter. Defaults to the bound query's first time dimension. */
  field: fieldSchema.optional(),
  default: DateRangeValueSchema.default('all'),
  bind: z.array(BindTargetSchema),
});

export const SelectParamSchema = z.object({
  type: z.literal('select'),
  label: z.string().max(100).optional(),
  field: fieldSchema,
  options: z.array(ScalarSchema).max(500).optional(),
  /** null means "no filter". */
  default: ScalarSchema.default(null),
  bind: z.array(BindTargetSchema),
});

export const PARAM_SCHEMAS: Record<string, z.AnyZodObject> & { daterange: typeof DateRangeParamSchema; select: typeof SelectParamSchema } = {
  // Spec 1.3+ param types (workstream B): see params-ext.ts. Built-ins below win on name clashes.
  ...EXTRA_PARAM_SCHEMAS,
  daterange: DateRangeParamSchema,
  select: SelectParamSchema,
};

// ── The document ────────────────────────────────────────────────────────────

export const DashboardSchema = z.object({
  specVersion: z.string(),
  id: idSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  dataSources: z.record(idSchema, DataSourceSchema),
  queries: z.record(idSchema, QuerySchema),
  widgets: z.record(idSchema, WidgetSchema),
  layout: z.array(LayoutItemSchema).max(200),
  params: z.record(idSchema, z.object({ type: z.string().min(1) }).passthrough()).default({}),
  /** Since 1.2. */
  theme: DashboardThemeSchema.optional(),
});

export type DataSource = z.infer<typeof DataSourceSchema>;
export type TimeGrain = z.infer<typeof TimeGrainSchema>;
export type Dimension = z.infer<typeof DimensionSchema>;
export type Aggregation = (typeof AGGREGATIONS)[number];
export type Measure = z.infer<typeof MeasureSchema>;
export type Scalar = z.infer<typeof ScalarSchema>;
export type FilterOp = (typeof FILTER_OPS)[number];
export type Filter = z.infer<typeof FilterSchema>;
export type OrderBy = z.infer<typeof OrderBySchema>;
/** A query with defaults applied. */
export type Query = z.infer<typeof QuerySchema>;
/** A query as an author may write it (defaults optional). */
export type QueryInput = z.input<typeof QuerySchema>;
export type LayoutItem = z.infer<typeof LayoutItemSchema>;
export type DatePreset = (typeof DATE_PRESETS)[number];
export type DateRangeValue = z.infer<typeof DateRangeValueSchema>;
export type DateRangeParam = z.infer<typeof DateRangeParamSchema>;
export type SelectParam = z.infer<typeof SelectParamSchema>;
export type Param = DateRangeParam | SelectParam | ExtraParam;
/** A dashboard as an author may write it. */
export type DashboardInput = z.input<typeof DashboardSchema>;
