import { z } from 'zod';
import { calcRefs, parseCalcExpr } from './calc-expr';
import { V13, V14, type ExtContext } from './ext';
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
 * Spec 1.4 adds custom SQL (see SqlColumnSchema): `sql` replaces dimensions/measures/calcs/windows/
 * topN/joins/metrics; `columns` declares the result columns widgets bind to. The server checks and
 * wraps the SQL (data/sql/custom.ts); the spec only checks its shape.
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
    /**
     * Since 1.4 (difference, percent_change): `offset` counts calendar periods of the order dimension's grain,
     * not rows, so a missing month still compares "same month last year" correctly (D-082).
     */
    calendar: z.boolean().optional(),
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

/** Custom SQL text: one SELECT (or WITH … SELECT) statement. */
export const MAX_SQL_LENGTH = 20_000;
export const SQL_COLUMN_TYPES = ['string', 'number', 'time', 'boolean'] as const;
export type SqlColumnType = (typeof SQL_COLUMN_TYPES)[number];

/** A result column of a custom SQL query, as the author declares it (Studio fills these by running the SQL). */
export const SqlColumnSchema = z
  .object({
    /** The column name exactly as the SQL returns it (Snowflake upper-cases unquoted aliases). */
    name: field,
    role: z.enum(['dimension', 'measure']),
    /** Wire type; inferred from the values when omitted (measures are always numbers). */
    type: z.enum(SQL_COLUMN_TYPES).optional(),
    /** For time columns: the period each value starts (axis labels and drill-free formatting). */
    grain: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
  })
  .strict();

/** Since 1.4: a row-level calculated field, usable by name like a source column (D-083). */
export const RowFieldSchema = z
  .object({
    as: field,
    expr: z.string().min(1).max(2000),
  })
  .strict();

export const QueryExtensionShape = {
  /** Since 1.4: row-level fields (`amount * fx_rate`, `year(order_date)`), computed before filters and grouping. */
  fields: z.array(RowFieldSchema).max(32).optional(),
  calcs: z.array(CalcSchema).max(32).optional(),
  windows: z.array(WindowSchema).max(16).optional(),
  topN: TopNSchema.optional(),
  joins: z.array(JoinSchema).max(3).optional(),
  metrics: z.array(MetricRefSchema).max(32).optional(),
  /** Since 1.4: custom SQL instead of the visual query fields. */
  sql: z.string().min(1).max(MAX_SQL_LENGTH).optional(),
  /** Since 1.4: the result columns of `sql`. */
  columns: z.array(SqlColumnSchema).max(64).optional(),
};

export type Calc = z.infer<typeof CalcSchema>;
export type WindowCalc = z.infer<typeof WindowSchema>;
export type TopN = z.infer<typeof TopNSchema>;
export type Join = z.infer<typeof JoinSchema>;
export type MetricRef = z.infer<typeof MetricRefSchema>;
export type SqlColumn = z.infer<typeof SqlColumnSchema>;
export type RowField = z.infer<typeof RowFieldSchema>;

const NEW_AGGS = new Set(['median', 'p25', 'p75', 'p90', 'stddev']);
const NEW_OPS = new Set(['contains', 'starts_with', 'ends_with']);
const EXT_KEYS = ['calcs', 'windows', 'topN', 'joins', 'metrics'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** The lowest spec version a raw query needs because of 1.3 features (undefined = none). */
export function queryExtensionSince(query: unknown): string | undefined {
  if (!isRecord(query)) return undefined;
  if (query.sql !== undefined || query.columns !== undefined || query.fields !== undefined || query.detail !== undefined) return V14;
  if (list(query.windows).some((w) => w.calendar !== undefined)) return V14;
  if (list(query.dimensions).some((d) => d.set !== undefined) || list(query.filters).some((f) => f.set !== undefined)) return V14;
  if (EXT_KEYS.some((k) => query[k] !== undefined)) return V13;
  if (list(query.measures).some((m) => NEW_AGGS.has(String(m.agg)))) return V13;
  if (list(query.filters).some((f) => NEW_OPS.has(String(f.op)))) return V13;
  if (list(query.dimensions).some((d) => d.bin !== undefined || d.buckets !== undefined)) return V13;
  return undefined;
}

/** Output alias of a catalog metric reference. */
export const metricAlias = (m: MetricRef) => m.as ?? m.metric;

/** Param ids a custom SQL query names with {{param}} / {{param.from}} placeholders (D-080). */
export function sqlParamRefs(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,63})(?:\.(?:from|to|low|high))?\s*\}\}/g)].map((m) => m[1]!))];
}

/** True for a custom SQL query (spec 1.4). */
export const isSqlQuery = (q: Pick<Query, 'sql'>): boolean => typeof q.sql === 'string';

/** Visual-query fields that a custom SQL query must not use. */
const NOT_WITH_SQL = ['dimensions', 'measures', 'calcs', 'windows', 'topN', 'joins', 'metrics', 'fields', 'detail'] as const;

/**
 * True when `sql` has a ";" outside string literals, quoted identifiers and comments, other than one
 * trailing ";". The server re-checks (the statement also runs wrapped in a subquery, where anything
 * but a SELECT is a syntax error); this gives the author the error early.
 */
export function sqlHasMultipleStatements(sql: string, dialect: 'snowflake' | 'duckdb' | 'any' = 'any'): boolean {
  // Snowflake-only syntax: backslash escapes in strings ('it\'s'), "//" comments, $$…$$ strings. In
  // DuckDB "//" is integer division. "any" (the spec's early check) accepts both; the server passes
  // the engine's dialect, so its check is exact.
  const sf = dialect !== 'duckdb';
  let i = 0;
  let lastSemicolon = -1;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) i += 2;
          else break;
        } else if (sf && ch === "'" && sql[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
    } else if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
    } else if (sf && ch === '/' && next === '/') {
      while (i < n && sql[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (sf && ch === '$' && next === '$') {
      const end = sql.indexOf('$$', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      if (ch === ';') {
        if (lastSemicolon >= 0) return true;
        lastSemicolon = i;
      } else if (lastSemicolon >= 0 && !/\s/.test(ch)) return true;
      i += 1;
    }
  }
  return false;
}

function validateSqlQuery(q: Query, raw: Record<string, unknown> | undefined, ctx: ExtContext & { base: string }): void {
  const { base } = ctx;
  const err = (path: string, code: string, message: string) => ctx.errors.push({ path: `${base}${path ? `.${path}` : ''}`, code, message });
  if (q.sql === undefined) {
    if (q.columns !== undefined && ctx.gate(`${base}.columns`, V14)) err('columns', 'invalid_value', '"columns" only applies to a query with "sql".');
    return;
  }
  if (!ctx.gate(`${base}.sql`, V14)) return;
  for (const k of NOT_WITH_SQL) {
    const v = raw ? raw[k] : q[k];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) err(k, 'invalid_value', `A custom SQL query cannot also use "${k}"; compute it in the SQL instead.`);
  }
  if (!q.sql.trim()) err('sql', 'invalid_value', 'The SQL is empty.');
  else if (sqlHasMultipleStatements(q.sql)) err('sql', 'invalid_sql', 'Write one SELECT statement (no ";" between statements).');
  const names = new Set<string>();
  (q.columns ?? []).forEach((c, i) => {
    if (names.has(c.name)) err(`columns.${i}.name`, 'duplicate_column', `Column "${c.name}" is declared twice.`);
    names.add(c.name);
    if (c.role === 'measure' && c.type !== undefined && c.type !== 'number') err(`columns.${i}.type`, 'invalid_value', 'A measure column must be a number.');
    if (c.grain !== undefined && c.type !== 'time') err(`columns.${i}.grain`, 'invalid_value', '"grain" only applies to a column with type "time".');
  });
  if (!q.columns?.length) {
    ctx.warnings.push({ path: `${base}.columns`, code: 'missing_columns', message: 'Declare the SQL result columns (Studio: "Run and detect columns") so widgets can use them.' });
  }
  // Filters (from the author, params or cross-filters) apply to the SQL's result columns.
  q.filters.forEach((f, i) => {
    if (!names.has(f.field)) err(`filters.${i}.field`, 'unknown_column', `"${f.field}" is not a declared column of this SQL query.`);
  });
}

/** Cross-field checks for the 1.3 and 1.4 fields of one parsed query (version gate first). */
export function validateQueryExtension(_queryId: string, q: Query, ctx: ExtContext & { base: string; dataSourceIds: Set<string>; raw?: Record<string, unknown> }): void {
  const { base } = ctx;
  const err = (path: string, code: string, message: string) => ctx.errors.push({ path: `${base}.${path}`, code, message });
  validateSqlQuery(q, ctx.raw, ctx);
  if (isSqlQuery(q)) return;
  if (q.detail !== undefined && ctx.gate(`${base}.detail`, V14)) {
    const detailNames = new Set(q.detail.measures.map((m) => m.as ?? (m.field === '*' ? m.agg : `${m.agg}_${m.field}`)));
    const dimNames = new Set(q.dimensions.map((d) => d.as ?? d.field));
    q.detail.dimensions.forEach((d, i) => {
      if (dimNames.has(d.as ?? d.field)) err(`detail.dimensions.${i}`, 'invalid_value', `"${d.as ?? d.field}" is already a dimension of the query; a detail dimension must be finer.`);
    });
    q.measures.forEach((m, i) => {
      if (m.field !== '*' && !detailNames.has(m.field)) err(`measures.${i}.field`, 'unknown_column', `With "detail", measures aggregate detail measures: "${m.field}" is not one (${[...detailNames].join(', ')}).`);
    });
    if (q.metrics?.length) err('metrics', 'invalid_value', 'Catalog metrics cannot be combined with "detail" yet.');
  }
  if (q.fields !== undefined && ctx.gate(`${base}.fields`, V14)) {
    const seen = new Set<string>();
    q.fields.forEach((f, i) => {
      const parsed = parseCalcExpr(f.expr, { rowLevel: true });
      if (!parsed.ok) err(`fields.${i}.expr`, 'invalid_expression', parsed.message);
      else if (calcRefs(parsed.node).includes(f.as)) err(`fields.${i}.expr`, 'invalid_expression', 'A field cannot refer to itself.');
      if (seen.has(f.as)) err(`fields.${i}.as`, 'duplicate_column', `Field "${f.as}" is defined twice.`);
      seen.add(f.as);
    });
  }

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
      if (w.calendar !== undefined && ctx.gate(`${base}.windows.${i}.calendar`, V14)) {
        if (w.type !== 'difference' && w.type !== 'percent_change') err(`windows.${i}.calendar`, 'invalid_value', '"calendar" only applies to difference and percent_change.');
        else if (w.order && !q.dimensions.find((d) => (d.as ?? d.field) === w.order)?.grain) {
          err(`windows.${i}.calendar`, 'invalid_value', `"calendar" needs "order" to be a time dimension with a grain (e.g. month).`);
        }
      }
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
