import { z } from 'zod';
import { calcRefs, parseCalcExpr } from './calc-expr';
import { V13, type ExtContext } from './ext';
import type { Query } from './schema';

export * from './calc-expr';

/**
 * OWNER: workstream A (calculations & query engine). Spec 1.3 query features, merged into
 * QuerySchema (schema.ts), so parsed queries carry them. Every field is optional and version-gated.
 *
 *   calcs    calculated measures: expressions over measure aliases and aggregate calls
 *   windows  table calculations over the aggregated rows (running total, % of total, rank, …)
 *   topN     keep the top N values of a dimension, the rest folded into "Other" (server-side)
 *   joins    join other data sources of the same engine type
 *   metrics  measures from the team's metric catalog, expanded on the server
 *
 * Dimension `bin` / `buckets`, the aggregations median/p25/p75/p90/stddev and the filter operators
 * contains/starts_with/ends_with live on the base schemas in schema.ts and are gated here too.
 *
 * No value imports from schema.ts (it imports this file): primitives are redefined locally.
 */

const field = z.string().min(1).max(128);
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const id = z.string().regex(ID, 'must start with a letter and use only letters, digits, "_" or "-" (max 64)');
/** Catalog metric names: lower-case identifiers. */
export const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const WINDOW_TYPES = ['running_total', 'percent_of_total', 'rank', 'moving_average', 'difference', 'percent_change'] as const;
export type WindowType = (typeof WINDOW_TYPES)[number];
/** Window calcs whose value depends on row order along `order`. */
export const ORDERED_WINDOWS: readonly WindowType[] = ['running_total', 'moving_average', 'difference', 'percent_change'];

export const CalcSchema = z
  .object({
    /** Output column name. */
    as: field,
    expr: z.string().min(1).max(2000),
  })
  .strict();

export const WindowSchema = z
  .object({
    as: field,
    type: z.enum(WINDOW_TYPES),
    /** The measure, metric or calc alias it computes over. */
    measure: field,
    /** Dimension alias the rows are ordered by (running_total, moving_average, difference, percent_change). */
    order: field.optional(),
    /** Dimension aliases that restart the calculation (e.g. per region). */
    partition: z.array(field).max(8).optional(),
    /** difference / percent_change: compare with the row this many steps earlier (default 1; 12 on months = year over year). */
    offset: z.number().int().min(1).max(1000).optional(),
    /** moving_average: rows in the window, including the current one (default 3). */
    window: z.number().int().min(2).max(1000).optional(),
    /** rank: "desc" (default, biggest first) or "asc". */
    dir: z.enum(['asc', 'desc']).optional(),
    /** rank: dense ranking (1, 2, 2, 3) instead of standard (1, 2, 2, 4). */
    dense: z.boolean().optional(),
  })
  .strict();

export const TopNSchema = z
  .object({
    /** Dimension alias to limit. */
    dimension: field,
    n: z.number().int().min(1).max(1000),
    /** Measure, metric or calc alias that ranks the values (biggest first). */
    by: field,
    /** Label of the folded remainder (default "Other"); null drops the remainder instead. */
    otherLabel: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();

export const JoinSchema = z
  .object({
    /** A dataSources id of the same engine type as the query's source. */
    source: id,
    type: z.enum(['inner', 'left']).default('left'),
    /** Equality keys: `left` is a column of the query's source (or "src.column" of an earlier join), `right` a column of this source. */
    on: z.array(z.object({ left: field, right: field }).strict()).min(1).max(4),
  })
  .strict();

export const MetricRefSchema = z
  .object({
    metric: z.string().regex(METRIC_NAME, 'metric names are lower-case letters, digits and "_"'),
    as: field.optional(),
  })
  .strict();

export const QueryExtensionShape = {
  calcs: z.array(CalcSchema).max(32).optional(),
  windows: z.array(WindowSchema).max(16).optional(),
  topN: TopNSchema.optional(),
  joins: z.array(JoinSchema).max(3).optional(),
  metrics: z.array(MetricRefSchema).max(32).optional(),
};

export type Calc = z.infer<typeof CalcSchema>;
export type WindowCalc = z.infer<typeof WindowSchema>;
export type TopN = z.infer<typeof TopNSchema>;
export type Join = z.infer<typeof JoinSchema>;
export type MetricRef = z.infer<typeof MetricRefSchema>;

const NEW_AGGS = new Set(['median', 'p25', 'p75', 'p90', 'stddev']);
const NEW_OPS = new Set(['contains', 'starts_with', 'ends_with']);
const EXT_KEYS = ['calcs', 'windows', 'topN', 'joins', 'metrics'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** The lowest spec version a raw query needs because of 1.3 features (undefined = none). */
export function queryExtensionSince(query: unknown): string | undefined {
  if (!isRecord(query)) return undefined;
  if (EXT_KEYS.some((k) => query[k] !== undefined)) return V13;
  if (list(query.measures).some((m) => NEW_AGGS.has(String(m.agg)))) return V13;
  if (list(query.filters).some((f) => NEW_OPS.has(String(f.op)))) return V13;
  if (list(query.dimensions).some((d) => d.bin !== undefined || d.buckets !== undefined)) return V13;
  return undefined;
}

/** Output alias of a catalog metric reference. */
export const metricAlias = (m: MetricRef) => m.as ?? m.metric;

/** Cross-field checks for the 1.3 fields of one parsed query (version gate first). */
export function validateQueryExtension(_queryId: string, q: Query, ctx: ExtContext & { base: string; dataSourceIds: Set<string> }): void {
  const { base } = ctx;
  const err = (path: string, code: string, message: string) => ctx.errors.push({ path: `${base}.${path}`, code, message });

  // Base-schema additions.
  q.measures.forEach((m, i) => NEW_AGGS.has(m.agg) && ctx.gate(`${base}.measures.${i}.agg`, V13));
  q.filters.forEach((f, i) => NEW_OPS.has(f.op) && ctx.gate(`${base}.filters.${i}.op`, V13));
  q.dimensions.forEach((d, i) => {
    if (d.bin === undefined && d.buckets === undefined) return;
    if (!ctx.gate(`${base}.dimensions.${i}.${d.bin !== undefined ? 'bin' : 'buckets'}`, V13)) return;
    const kinds = [d.grain && 'grain', d.bin && 'bin', d.buckets && 'buckets'].filter(Boolean);
    if (kinds.length > 1) err(`dimensions.${i}`, 'invalid_value', `A dimension can have only one of ${kinds.join(', ')}.`);
  });

  const present = EXT_KEYS.filter((k) => q[k] !== undefined && ctx.gate(`${base}.${k}`, V13));
  if (!present.length) return;

  const dims = new Set(q.dimensions.map((d) => d.as ?? d.field));
  const measures = new Set<string>(q.measures.map((m) => m.as ?? (m.field === '*' ? m.agg : `${m.agg}_${m.field}`)));
  for (const m of q.metrics ?? []) measures.add(metricAlias(m));

  // calcs: parse, and refer only to measures, metrics and earlier calcs.
  const calcs = new Set<string>();
  if (present.includes('calcs')) {
    (q.calcs ?? []).forEach((c, i) => {
      const parsed = parseCalcExpr(c.expr);
      if (!parsed.ok) err(`calcs.${i}.expr`, 'invalid_expression', parsed.message);
      else {
        for (const ref of calcRefs(parsed.node)) {
          if (!measures.has(ref) && !calcs.has(ref)) {
            err(`calcs.${i}.expr`, 'unknown_column', `"${ref}" is not a measure, metric or earlier calc of this query (wrap a source column in an aggregation, e.g. sum(${ref})).`);
          }
        }
      }
      calcs.add(c.as);
    });
  }
  const values = new Set([...measures, ...calcs]);

  if (present.includes('windows')) {
    const dimList = [...dims];
    (q.windows ?? []).forEach((w, i) => {
      if (!values.has(w.measure)) err(`windows.${i}.measure`, 'unknown_column', `"${w.measure}" is not a measure, metric or calc of this query.`);
      for (const [j, p] of (w.partition ?? []).entries()) {
        if (!dims.has(p)) err(`windows.${i}.partition.${j}`, 'unknown_column', `"${p}" is not a dimension of this query.`);
      }
      if ((ORDERED_WINDOWS as readonly string[]).includes(w.type)) {
        if (!w.order) err(`windows.${i}.order`, 'missing_order', `"${w.type}" needs "order": the dimension the rows run along.`);
        else if (!dims.has(w.order)) err(`windows.${i}.order`, 'unknown_column', `"${w.order}" is not a dimension of this query.`);
        else {
          // Row order must be total within each partition, or engines could disagree.
          const covered = new Set([w.order, ...(w.partition ?? [])]);
          const missing = dimList.filter((d) => !covered.has(d));
          if (missing.length) err(`windows.${i}.partition`, 'ambiguous_window_order', `Add ${missing.map((m) => `"${m}"`).join(', ')} to "partition": every dimension must be the order or a partition of an ordered window.`);
        }
      } else if (w.order !== undefined) {
        err(`windows.${i}.order`, 'invalid_value', `"${w.type}" does not use "order".`);
      }
      if (w.window !== undefined && w.type !== 'moving_average') err(`windows.${i}.window`, 'invalid_value', '"window" only applies to moving_average.');
      if (w.offset !== undefined && w.type !== 'difference' && w.type !== 'percent_change') err(`windows.${i}.offset`, 'invalid_value', '"offset" only applies to difference and percent_change.');
      if ((w.dir !== undefined || w.dense !== undefined) && w.type !== 'rank') err(`windows.${i}`, 'invalid_value', '"dir" and "dense" only apply to rank.');
    });
  }

  if (present.includes('topN') && q.topN) {
    if (!dims.has(q.topN.dimension)) err('topN.dimension', 'unknown_column', `"${q.topN.dimension}" is not a dimension of this query.`);
    else {
      const d = q.dimensions.find((x) => (x.as ?? x.field) === q.topN!.dimension)!;
      if (d.bin) err('topN.dimension', 'invalid_value', 'Top N works on text-like dimensions (columns, time buckets, buckets), not bins.');
    }
    if (!values.has(q.topN.by)) err('topN.by', 'unknown_column', `"${q.topN.by}" is not a measure, metric or calc of this query.`);
  }

  if (present.includes('joins')) {
    const seen = new Set<string>();
    (q.joins ?? []).forEach((j, i) => {
      if (j.source === q.source) err(`joins.${i}.source`, 'invalid_value', 'A query cannot join its own source.');
      else if (!ctx.dataSourceIds.has(j.source)) err(`joins.${i}.source`, 'unknown_reference', `Data source "${j.source}" is not defined in dataSources.`);
      if (seen.has(j.source)) err(`joins.${i}.source`, 'invalid_value', `"${j.source}" is joined twice.`);
      seen.add(j.source);
    });
  }
}
