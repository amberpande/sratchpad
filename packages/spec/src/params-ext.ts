import { z } from 'zod';
import { V13, type ExtContext } from './ext';
import type { Query } from './schema';
import { AGGREGATIONS } from './schema';

/**
 * OWNER: workstream B (interactivity). Spec 1.3 param types:
 *
 *   multiselect – several values of one field (filter `in`); options listed, or read from a saved
 *                 query's results (`optionsQuery`), which may itself be bound to another param
 *                 (cascading: pick a region, the country list narrows).
 *   range       – lower/upper bound on a numeric or date field (between / gte / lte).
 *   search      – free text matched against a field (contains / starts_with / ends_with).
 *   measure     – swaps one measure of the bound queries among author-declared alternatives
 *                 (e.g. Revenue ↔ Orders), keeping the output column name so widgets don't change.
 *
 * Every value a client may send is checked against what the author declared (coerceParamValue in
 * params.ts), so a param can never make the server run something the author did not save.
 *
 * NB: schema.ts imports this module's schemas, so nothing here may use schema.ts values while the
 * module loads (zod primitives are declared locally; AGGREGATIONS is only read inside functions).
 */

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const field = z.string().min(1).max(128);
const label = z.string().max(100).optional();
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const listScalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
const filtersBind = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}\.filters$/, 'bind targets look like "<queryId>.filters"');
const measuresBind = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}\.measures$/, 'measure params bind to "<queryId>.measures"');
const bound = z.union([z.number().finite(), z.string().regex(isoDate, 'dates are "YYYY-MM-DD"'), z.null()]);

export const MultiSelectParamSchema = z.object({
  type: z.literal('multiselect'),
  label,
  field,
  /** Fixed choices. Or use optionsQuery. */
  options: z.array(listScalar).max(500).optional(),
  /** Choices read from a saved query's result column (bind that query to other params to cascade). */
  optionsQuery: z.object({ query: z.string().regex(idPattern), field }).strict().optional(),
  /** Empty = no filter. */
  default: z.array(listScalar).max(100).default([]),
  bind: z.array(filtersBind).min(1),
});

export const RangeParamSchema = z.object({
  type: z.literal('range'),
  label,
  field,
  kind: z.enum(['number', 'date']).default('number'),
  min: z.union([z.number().finite(), z.string().regex(isoDate)]).optional(),
  max: z.union([z.number().finite(), z.string().regex(isoDate)]).optional(),
  step: z.number().positive().optional(),
  /** [low, high]; either end may be null (open). null = no filter. */
  default: z.tuple([bound, bound]).nullable().default(null),
  bind: z.array(filtersBind).min(1),
});

export const SearchParamSchema = z.object({
  type: z.literal('search'),
  label,
  field,
  match: z.enum(['contains', 'starts_with', 'ends_with']).default('contains'),
  /** Empty = no filter. */
  default: z.string().max(200).default(''),
  bind: z.array(filtersBind).min(1),
});

export const MeasureOptionSchema = z
  .object({
    value: z.string().regex(idPattern),
    label: z.string().max(100).optional(),
    field,
    agg: z.string().min(1),
  })
  .strict();

export const MeasureParamSchema = z.object({
  type: z.literal('measure'),
  label,
  /** Output column (measure alias) of the bound queries that this param swaps. */
  as: field,
  options: z.array(MeasureOptionSchema).min(2).max(12),
  default: z.string().regex(idPattern),
  bind: z.array(measuresBind).min(1),
});

export const EXTRA_PARAM_SCHEMAS: Record<string, z.AnyZodObject> = {
  multiselect: MultiSelectParamSchema,
  range: RangeParamSchema,
  search: SearchParamSchema,
  measure: MeasureParamSchema,
};

export type MultiSelectParam = z.infer<typeof MultiSelectParamSchema>;
export type RangeParam = z.infer<typeof RangeParamSchema>;
export type SearchParam = z.infer<typeof SearchParamSchema>;
export type MeasureParam = z.infer<typeof MeasureParamSchema>;
export type MeasureOption = z.infer<typeof MeasureOptionSchema>;

/** Spec version a param type arrived in (undefined for built-ins). */
export function paramTypeSince(type: string): string | undefined {
  return Object.hasOwn(EXTRA_PARAM_SCHEMAS, type) ? V13 : undefined;
}

/** Output column name of a measure (as validate/query.ts name it). */
function measureOutput(m: { field: string; agg: string; as?: string }): string {
  return m.as ?? `${m.agg}_${m.field}`;
}
function dimensionOutput(d: { field: string; as?: string }): string {
  return d.as ?? d.field;
}

/** Type-specific checks for a parsed extra param. */
export function validateParamExtension(paramId: string, param: Record<string, unknown>, ctx: ExtContext & { base: string; queries: Record<string, Query> }): void {
  const { base, errors } = ctx;
  const p = param as unknown as ExtraParam;
  switch (p.type) {
    case 'multiselect': {
      if (p.options && p.optionsQuery) errors.push({ path: `${base}.optionsQuery`, code: 'invalid_value', message: 'Give either "options" or "optionsQuery", not both.' });
      if (p.options) {
        p.default.forEach((v, i) => {
          if (!p.options!.includes(v)) errors.push({ path: `${base}.default.${i}`, code: 'invalid_value', message: 'default values must be among options.' });
        });
      }
      if (p.optionsQuery) {
        const q = ctx.queries[p.optionsQuery.query];
        if (!q) errors.push({ path: `${base}.optionsQuery.query`, code: 'unknown_reference', message: `Query "${p.optionsQuery.query}" is not defined in queries.` });
        else {
          const cols = [...q.dimensions.map(dimensionOutput), ...q.measures.map(measureOutput)];
          if (!cols.includes(p.optionsQuery.field)) {
            errors.push({ path: `${base}.optionsQuery.field`, code: 'unknown_column', message: `"${p.optionsQuery.field}" is not an output column of query "${p.optionsQuery.query}" (${cols.join(', ')}).` });
          }
          if (p.bind.some((t) => t === `${p.optionsQuery!.query}.filters`)) {
            errors.push({ path: `${base}.optionsQuery.query`, code: 'invalid_value', message: 'A param cannot read its options from a query it filters (its choices would shrink to its own selection).' });
          }
        }
      }
      break;
    }
    case 'range': {
      const [lo, hi] = p.default ?? [null, null];
      for (const [i, v] of [lo, hi].entries()) {
        if (v === null) continue;
        if (p.kind === 'number' && typeof v !== 'number') errors.push({ path: `${base}.default.${i}`, code: 'invalid_value', message: 'A number range takes numbers.' });
        if (p.kind === 'date' && typeof v !== 'string') errors.push({ path: `${base}.default.${i}`, code: 'invalid_value', message: 'A date range takes "YYYY-MM-DD" dates.' });
      }
      if (lo !== null && hi !== null && lo > hi) errors.push({ path: `${base}.default`, code: 'invalid_value', message: 'The low end must not be above the high end.' });
      for (const k of ['min', 'max'] as const) {
        const v = p[k];
        if (v !== undefined && (p.kind === 'number') !== (typeof v === 'number')) {
          errors.push({ path: `${base}.${k}`, code: 'invalid_value', message: `"${k}" must be a ${p.kind === 'number' ? 'number' : '"YYYY-MM-DD" date'}.` });
        }
      }
      break;
    }
    case 'measure': {
      const values = new Set<string>();
      p.options.forEach((o, i) => {
        if (values.has(o.value)) errors.push({ path: `${base}.options.${i}.value`, code: 'duplicate_value', message: `Option "${o.value}" appears twice.` });
        values.add(o.value);
        if (!(AGGREGATIONS as readonly string[]).includes(o.agg)) {
          errors.push({ path: `${base}.options.${i}.agg`, code: 'invalid_value', message: `"${o.agg}" is not an aggregation (${AGGREGATIONS.join(', ')}).` });
        }
        if (o.field === '*' && o.agg !== 'count') errors.push({ path: `${base}.options.${i}.field`, code: 'invalid_value', message: '"*" is only valid with agg "count".' });
      });
      if (!values.has(p.default)) errors.push({ path: `${base}.default`, code: 'invalid_value', message: 'default must be one of the option values.' });
      p.bind.forEach((target, i) => {
        const qid = target.slice(0, -'.measures'.length);
        const q = ctx.queries[qid];
        if (q && !q.measures.some((m) => measureOutput(m) === p.as)) {
          errors.push({ path: `${base}.bind.${i}`, code: 'unknown_column', message: `Query "${qid}" has no measure named "${p.as}" to switch.` });
        }
      });
      break;
    }
    case 'search':
      break;
  }
  void paramId;
}

/** Union of extra param types. */
export type ExtraParam = MultiSelectParam | RangeParam | SearchParam | MeasureParam;
