import {
  DateRangeValueSchema,
  ScalarSchema,
  type DateRangeParam,
  type DateRangeValue,
  type Filter,
  type Param,
  type Query,
  type Scalar,
} from './schema';
import type { ValidDashboard } from './types';
import type { ExtraParam, MeasureParam } from './params-ext';

/**
 * Params are dashboard-level controls (date range, filters) bound into queries, so one date
 * picker re-filters every widget without rewriting them. The query layer applies them; the
 * renderer only uses these helpers to merge defaults and build cache keys.
 */

/** Multi-select and range params (1.3) take lists: values, or [low, high]. */
export type ParamValue = DateRangeValue | Scalar | Scalar[];
export type ParamValues = Record<string, ParamValue>;

const BIND_SUFFIXES = ['.filters', '.measures'] as const;

export function bindQueryId(target: string): string {
  const suffix = BIND_SUFFIXES.find((s) => target.endsWith(s));
  return suffix ? target.slice(0, -suffix.length) : target;
}

/** The source date column a daterange param filters on a given query. */
export function dateRangeField(param: DateRangeParam, query: Pick<Query, 'dimensions'>): string | undefined {
  return param.field ?? query.dimensions.find((d) => d.grain)?.field;
}

export type CoerceResult = { ok: true; value: ParamValue } | { ok: false; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 100;

function isListScalar(v: unknown): v is string | number | boolean {
  return (typeof v === 'string' && v.length <= 500) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
}

/** Values of the 1.3 param types: always checked against what the author declared. */
function coerceExtra(param: ExtraParam, value: unknown): CoerceResult {
  switch (param.type) {
    case 'multiselect': {
      if (!Array.isArray(value) || value.length > MAX_LIST || !value.every(isListScalar)) {
        return { ok: false, message: `expected a list of up to ${MAX_LIST} strings, numbers or booleans` };
      }
      if (param.options && value.some((v) => !param.options!.includes(v))) {
        return { ok: false, message: `expected values among ${param.options.map((o) => JSON.stringify(o)).join(', ')}` };
      }
      return { ok: true, value: [...new Set(value)] };
    }
    case 'range': {
      if (value === null) return { ok: true, value: null };
      const fits = (v: unknown) => v === null || (param.kind === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === 'string' && ISO_DATE.test(v));
      if (!Array.isArray(value) || value.length !== 2 || !value.every(fits)) {
        return { ok: false, message: `expected [low, high] (${param.kind === 'number' ? 'numbers' : '"YYYY-MM-DD" dates'}, either may be null), or null` };
      }
      const [lo, hi] = value as [number | string | null, number | string | null];
      if (lo !== null && hi !== null && lo > hi) return { ok: false, message: 'low must not be above high' };
      return { ok: true, value: [lo, hi] };
    }
    case 'search':
      return typeof value === 'string' && value.length <= 200 ? { ok: true, value: value.trim() } : { ok: false, message: 'expected text (max 200 characters)' };
    case 'measure':
      return typeof value === 'string' && param.options.some((o) => o.value === value)
        ? { ok: true, value }
        : { ok: false, message: `expected one of ${param.options.map((o) => JSON.stringify(o.value)).join(', ')}` };
  }
}

export function coerceParamValue(param: Param, value: unknown): CoerceResult {
  if (param.type === 'daterange') {
    const parsed = DateRangeValueSchema.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, message: 'expected a preset such as "last_30d" or {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}' };
  }
  if (param.type !== 'select') return coerceExtra(param, value);
  const parsed = ScalarSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: 'expected a string, number, boolean or null' };
  if (parsed.data !== null && param.options && !param.options.includes(parsed.data)) {
    return { ok: false, message: `expected one of ${param.options.map((o) => JSON.stringify(o)).join(', ')}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Merge provided values over each param's default. Unknown names are ignored; invalid values
 * fall back to the default and are reported through `onInvalid`.
 */
export function effectiveParamValues(
  dashboard: Pick<ValidDashboard, 'params'>,
  provided: Record<string, unknown> = {},
  onInvalid?: (name: string, message: string) => void,
): ParamValues {
  const values: ParamValues = {};
  for (const [name, param] of Object.entries(dashboard.params)) {
    const raw = provided[name];
    if (raw === undefined) {
      values[name] = param.default;
      continue;
    }
    const coerced = coerceParamValue(param, raw);
    if (coerced.ok) values[name] = coerced.value;
    else {
      onInvalid?.(name, coerced.message);
      values[name] = param.default;
    }
  }
  return values;
}

/** Only the params bound to one query — what its result (and cache key) depends on. */
export function paramsForQuery(dashboard: Pick<ValidDashboard, 'params'>, queryId: string, values: ParamValues): ParamValues {
  const subset: ParamValues = {};
  for (const [name, param] of Object.entries(dashboard.params)) {
    if (param.bind.some((t) => bindQueryId(t) === queryId)) subset[name] = values[name] ?? param.default;
  }
  return subset;
}

// ── Date ranges (UTC calendar days) ─────────────────────────────────────────

export interface ResolvedDateRange {
  from: string;
  /** Exclusive upper bound: the day after the last included day. */
  toExclusive: string;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

export function resolveDateRange(value: DateRangeValue, now: Date): ResolvedDateRange | null {
  const today = toIsoDate(now);
  const tomorrow = addDays(today, 1);
  if (typeof value === 'object') return { from: value.from, toExclusive: addDays(value.to, 1) };
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const ymd = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, '0')}-01`;
  switch (value) {
    case 'all':
      return null;
    case 'last_7d':
      return { from: addDays(today, -6), toExclusive: tomorrow };
    case 'last_30d':
      return { from: addDays(today, -29), toExclusive: tomorrow };
    case 'last_90d':
      return { from: addDays(today, -89), toExclusive: tomorrow };
    case 'last_365d':
      return { from: addDays(today, -364), toExclusive: tomorrow };
    case 'mtd':
      return { from: ymd(year, month), toExclusive: tomorrow };
    case 'qtd':
      return { from: ymd(year, month - (month % 3)), toExclusive: tomorrow };
    case 'ytd':
      return { from: ymd(year, 0), toExclusive: tomorrow };
  }
}

/** Filters a param value contributes to one query. */
export function paramFilters(param: Param, value: ParamValue, query: Query, now: Date): Filter[] {
  switch (param.type) {
    case 'multiselect': {
      const list = Array.isArray(value) ? value.filter((v) => v !== null) : [];
      return list.length ? [{ field: param.field, op: 'in', value: list as Array<string | number | boolean> }] : [];
    }
    case 'range': {
      if (!Array.isArray(value)) return [];
      const [lo, hi] = value as [string | number | null, string | number | null];
      if (lo !== null && hi !== null) return [{ field: param.field, op: 'between', value: [lo, hi] }];
      if (lo !== null) return [{ field: param.field, op: 'gte', value: lo }];
      if (hi !== null) return [{ field: param.field, op: 'lte', value: hi }];
      return [];
    }
    case 'search': {
      const text = typeof value === 'string' ? value.trim() : '';
      // contains / starts_with / ends_with: text filter ops of the query layer.
      return text ? [{ field: param.field, op: param.match, value: text }] : [];
    }
    case 'measure':
      return []; // swaps a measure instead (applyParams)
  }
  if (param.type === 'daterange') {
    const field = dateRangeField(param, query);
    const range = resolveDateRange(value as DateRangeValue, now);
    if (!field || !range) return [];
    return [
      { field, op: 'gte', value: range.from },
      { field, op: 'lt', value: range.toExclusive },
    ];
  }
  if (value === null || Array.isArray(value)) return [];
  return [{ field: param.field, op: 'eq', value: value as Exclude<Scalar, null> }];
}

/** Replaces the measure a measure param controls with the chosen, author-declared option. */
function swapMeasure(query: Query, param: MeasureParam, value: ParamValue): Query {
  const option = param.options.find((o) => o.value === value) ?? param.options.find((o) => o.value === param.default);
  if (!option) return query;
  const measures = query.measures.map((m) =>
    (m.as ?? `${m.agg}_${m.field}`) === param.as ? { field: option.field, agg: option.agg as Query['measures'][number]['agg'], as: param.as } : m,
  );
  return { ...query, measures };
}

/** The concrete query to execute: the stored query plus the filters its bound params produce. */
export function applyParams(dashboard: Pick<ValidDashboard, 'params' | 'queries'>, queryId: string, values: ParamValues, now: Date): Query {
  const query = dashboard.queries[queryId];
  if (!query) throw new Error(`Unknown query "${queryId}"`);
  const extra: Filter[] = [];
  let current = query;
  for (const [name, param] of Object.entries(dashboard.params)) {
    if (!param.bind.some((t) => bindQueryId(t) === queryId)) continue;
    const value = values[name] ?? param.default;
    if (param.type === 'measure') current = swapMeasure(current, param, value);
    else extra.push(...paramFilters(param, value, query, now));
  }
  return extra.length ? { ...current, filters: [...current.filters, ...extra] } : current;
}
