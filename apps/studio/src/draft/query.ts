import {
  measureAlias,
  outputColumns,
  type Aggregation,
  type Dimension,
  type Filter,
  type Measure,
  type OrderBy,
  type Calc,
  type Join,
  type MetricRef,
  type QueryInput,
  type SqlColumn,
  type TimeGrain,
  type TopN,
  type WindowCalc,
} from '@yourorg/bi-spec';
import type { FieldInfo, WidgetDraft } from './types';
import { widgetTypeInfo, type FieldSlot } from './widgetTypes';

/**
 * Builds semantic queries from fields: dimensions (with a time grain for temporal fields),
 * measures (with an aggregation), filters, sort and limit, then keeps the widget's encoding and
 * field options pointing at real output columns.
 */

export interface NormalQuery {
  source: string;
  dimensions: Dimension[];
  measures: Measure[];
  filters: Filter[];
  orderBy: OrderBy[];
  limit?: number;
  // Spec 1.3: carried through every edit so the canvas never drops them.
  calcs?: Calc[];
  windows?: WindowCalc[];
  topN?: TopN;
  joins?: Join[];
  metrics?: MetricRef[];
  // Spec 1.4: custom SQL (replaces dimensions/measures/calcs/…) and its declared result columns.
  sql?: string;
  columns?: SqlColumn[];
}

/** The spec 1.3 query fields edited in the "Calculations" section. */
export const EXTENSION_KEYS = ['calcs', 'windows', 'topN', 'joins', 'metrics'] as const;

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Fills in the optional arrays so callers can read a query without guards. */
export function normalizeQuery(q: QueryInput | undefined): NormalQuery {
  return {
    source: typeof q?.source === 'string' ? q.source : '',
    dimensions: arr<Dimension>(q?.dimensions),
    measures: arr<Measure>(q?.measures),
    filters: arr<Filter>(q?.filters),
    orderBy: arr<OrderBy>(q?.orderBy).map((o) => ({ field: o.field, dir: o.dir ?? 'asc' })),
    ...(typeof q?.limit === 'number' ? { limit: q.limit } : {}),
    ...(Array.isArray(q?.calcs) ? { calcs: q.calcs as Calc[] } : {}),
    ...(Array.isArray(q?.windows) ? { windows: q.windows as WindowCalc[] } : {}),
    ...(q?.topN ? { topN: q.topN as TopN } : {}),
    ...(Array.isArray(q?.joins) ? { joins: q.joins as Join[] } : {}),
    ...(Array.isArray(q?.metrics) ? { metrics: q.metrics as MetricRef[] } : {}),
    ...(typeof q?.sql === 'string' ? { sql: q.sql } : {}),
    ...(Array.isArray(q?.columns) ? { columns: q.columns as SqlColumn[] } : {}),
  };
}

/** Writes a query back without empty optional arrays, so the JSON stays tidy. */
export function compactQuery(q: NormalQuery): QueryInput {
  return {
    source: q.source,
    ...(q.dimensions.length ? { dimensions: q.dimensions } : {}),
    ...(q.measures.length ? { measures: q.measures } : {}),
    ...(q.filters.length ? { filters: q.filters } : {}),
    ...(q.orderBy.length ? { orderBy: q.orderBy } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.calcs?.length ? { calcs: q.calcs } : {}),
    ...(q.windows?.length ? { windows: q.windows } : {}),
    ...(q.topN ? { topN: q.topN } : {}),
    ...(q.joins?.length ? { joins: q.joins } : {}),
    ...(q.metrics?.length ? { metrics: q.metrics } : {}),
    ...(q.sql !== undefined ? { sql: q.sql } : {}),
    ...(q.sql !== undefined && q.columns?.length ? { columns: q.columns } : {}),
  };
}

export function columnNames(q: QueryInput | undefined): { all: string[]; dimensions: string[]; measures: string[]; time: string[] } {
  const n = normalizeQuery(q);
  const cols = outputColumns(n);
  return {
    all: cols.map((c) => c.name),
    dimensions: cols.filter((c) => c.role === 'dimension').map((c) => c.name),
    measures: cols.filter((c) => c.role === 'measure').map((c) => c.name),
    time: [...cols.filter((c) => c.grain).map((c) => c.name), ...(n.sql !== undefined ? (n.columns ?? []).filter((c) => c.type === 'time').map((c) => c.name) : [])],
  };
}

export const DEFAULT_GRAIN: TimeGrain = 'month';

export function defaultAgg(field: FieldInfo): Aggregation {
  if (field.semanticType === 'numeric' && field.kind === 'measure') return 'sum';
  if (field.semanticType === 'numeric' && !field.secondary) return 'sum';
  return 'count_distinct';
}

/** Adds a dimension; a temporal field gets a time grain. Re-adding a field just updates its grain. */
export function addDimension(q: NormalQuery, field: FieldInfo, grain?: TimeGrain): NormalQuery {
  const g = field.kind === 'time' ? (grain ?? DEFAULT_GRAIN) : undefined;
  const existing = q.dimensions.findIndex((d) => d.field === field.name && !d.as);
  if (existing >= 0) {
    const dimensions = q.dimensions.map((d, i) => (i === existing ? { field: d.field, ...(g ? { grain: g } : {}) } : d));
    return { ...q, dimensions };
  }
  const taken = new Set(columnNames(q).all);
  const dim: Dimension = { field: field.name, ...(g ? { grain: g } : {}) };
  if (taken.has(field.name)) dim.as = uniqueName(`${field.name}_${g ?? 'dim'}`, taken);
  let next: NormalQuery = { ...q, dimensions: [...q.dimensions, dim] };
  // Time series read left to right: sort by the time column unless the author chose a sort.
  if (g && next.orderBy.length === 0) next = { ...next, orderBy: [{ field: dim.as ?? dim.field, dir: 'asc' }] };
  return next;
}

/** Adds a measure with an aggregation; the output column gets an alias only if its default name is taken. */
export function addMeasure(q: NormalQuery, field: string, agg: Aggregation): NormalQuery {
  const taken = new Set(columnNames(q).all);
  const m: Measure = { field, agg };
  const name = measureAlias(m);
  if (taken.has(name)) m.as = uniqueName(name, taken);
  return { ...q, measures: [...q.measures, m] };
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Drops sort entries that no longer name an output column. */
export function pruneOrderBy(q: NormalQuery): NormalQuery {
  const names = new Set(columnNames(q).all);
  const orderBy = q.orderBy.filter((o) => names.has(o.field));
  return orderBy.length === q.orderBy.length ? q : { ...q, orderBy };
}

/** Adds a field to a query in the role it is dropped as (default: what the profiler says it is). */
export function addField(q: NormalQuery, field: FieldInfo, as?: 'dimension' | 'measure'): { query: NormalQuery; added: string } {
  const role = as ?? (field.kind === 'measure' ? 'measure' : 'dimension');
  if (role === 'measure') {
    const next = addMeasure(q, field.name, field.kind === 'measure' || field.semanticType === 'numeric' ? defaultAgg(field) : 'count_distinct');
    return { query: next, added: measureAlias(next.measures[next.measures.length - 1]!) };
  }
  const next = addDimension(q, field);
  const d = next.dimensions.find((x) => x.field === field.name)!;
  return { query: next, added: d.as ?? d.field };
}

// ── encoding ────────────────────────────────────────────────────────────────

export interface EncodeHint {
  /** An output column just added, so multi-series slots can pick it up. */
  added?: string;
}

function slotValue(widget: WidgetDraft, slot: FieldSlot): unknown {
  return (slot.container === 'encoding' ? widget.encoding : widget.options)?.[slot.key];
}

function withSlot(widget: WidgetDraft, slot: FieldSlot, value: unknown): WidgetDraft {
  const container = { ...((slot.container === 'encoding' ? widget.encoding : widget.options) ?? {}) };
  if (value === undefined) delete container[slot.key];
  else container[slot.key] = value;
  return { ...widget, [slot.container]: container };
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/**
 * Points every field slot of the widget at real output columns of its query: keeps valid choices,
 * fills empty required slots with a sensible column (a measure where a measure belongs), adds a
 * newly added measure as a series, and clears optional slots whose column is gone. An optional
 * dimension slot (e.g. line "series", scatter "label") picks up a newly added, otherwise unused
 * dimension, which is what dropping that field means.
 */
export function autoEncode(widget: WidgetDraft, query: QueryInput | undefined, hint: EncodeHint = {}): WidgetDraft {
  const info = widgetTypeInfo(widget.type);
  if (!info || !query) return widget;
  const cols = columnNames(query);
  const valid = new Set(cols.all);
  const preferredDims = [...cols.time, ...cols.dimensions.filter((d) => !cols.time.includes(d))];
  let next = widget;
  const used = new Set<string>();
  // Required slots first, so optional ones only get what is left over.
  const ordered = [...info.slots].sort((a, b) => Number(b.required) - Number(a.required));

  for (const slot of ordered) {
    const current = slotValue(next, slot);
    if (slot.columns) {
      if (!Array.isArray(current)) continue; // undefined = every column
      const kept = current.filter((c): c is { field: string } => typeof c === 'object' && c !== null && valid.has((c as { field?: string }).field ?? ''));
      if (hint.added && valid.has(hint.added) && !kept.some((c) => c.field === hint.added)) kept.push({ field: hint.added });
      next = withSlot(next, slot, kept.length ? kept : undefined);
      continue;
    }
    if (slot.multiple && slot.role !== 'dimension') {
      let list = asList(current).filter((f) => valid.has(f));
      const addedIsMeasure = hint.added !== undefined && cols.measures.includes(hint.added);
      if (addedIsMeasure && !list.includes(hint.added!)) list.push(hint.added!);
      if (list.length === 0 && slot.required) list = cols.measures.filter((m) => !used.has(m));
      if (list.length === 0 && slot.required) list = cols.all.filter((c) => !used.has(c)).slice(0, 1);
      list.forEach((f) => used.add(f));
      next = withSlot(next, slot, list.length === 0 ? undefined : list.length === 1 ? list[0] : list);
      continue;
    }
    const single = typeof current === 'string' ? current : Array.isArray(current) ? asList(current)[0] : undefined;
    if (single && valid.has(single)) {
      used.add(single);
      if (single !== current) next = withSlot(next, slot, single);
      continue;
    }
    if (!slot.required) {
      const added = hint.added;
      const multiSeries = info.slots.some((s) => s.multiple && Array.isArray(slotValue(next, s)) && (slotValue(next, s) as unknown[]).length > 1);
      const take = slot.role === 'dimension' && added && cols.dimensions.includes(added) && !used.has(added) && !multiSeries ? added : undefined;
      if (take) used.add(take);
      next = withSlot(next, slot, take);
      continue;
    }
    const pool = slot.role === 'dimension' ? preferredDims : slot.role === 'measure' ? cols.measures : cols.all;
    const pick = pool.find((c) => !used.has(c)) ?? (slot.role === 'measure' ? undefined : cols.all.find((c) => !used.has(c)));
    if (pick) used.add(pick);
    next = withSlot(next, slot, pick);
  }
  return next;
}

/** A readable default title, e.g. "Sum amount by order date". */
export function autoTitle(query: QueryInput | undefined): string | undefined {
  const n = normalizeQuery(query);
  const m = n.measures[0];
  if (!m) return undefined;
  const what = m.field === '*' ? 'Count' : `${m.agg === 'count_distinct' ? 'Distinct' : m.agg.charAt(0).toUpperCase() + m.agg.slice(1)} ${m.field.replace(/_/g, ' ')}`;
  const by = n.dimensions[0];
  return by ? `${what} by ${by.field.replace(/_/g, ' ')}` : what;
}

/**
 * A starter query for a new widget of `type`, built from the source's fields: as many dimensions
 * and measures as the type's required slots ask for, so the widget renders straight away.
 */
export function starterQuery(type: string, sourceId: string, fields: FieldInfo[]): NormalQuery {
  const info = widgetTypeInfo(type);
  let q: NormalQuery = { source: sourceId, dimensions: [], measures: [], filters: [], orderBy: [] };
  const slots = info?.slots ?? [];
  const required = slots.filter((s) => s.required && !s.columns);
  const requiredDims = required.filter((s) => s.role === 'dimension').length;
  const hasColumns = slots.some((s) => s.columns);
  const optionalDim = slots.some((s) => !s.required && s.role === 'dimension');
  // A table shows one category; a type with only optional dimension slots (scatter "label") gets one so it has several points.
  const needDims = requiredDims || (hasColumns || optionalDim ? 1 : 0);
  const needMeasures = Math.max(1, required.filter((s) => s.role === 'measure').length);

  const time = fields.filter((f) => f.kind === 'time');
  const dims = fields.filter((f) => f.kind === 'dimension' && !f.secondary);
  const timeFirst = /line|area|trend|time/.test(type) && requiredDims > 0;
  for (const dim of (timeFirst ? [...time, ...dims] : [...dims, ...time]).slice(0, needDims)) q = addDimension(q, dim);

  const measures = fields.filter((f) => f.kind === 'measure' && !f.secondary);
  for (const m of measures.slice(0, needMeasures)) q = addMeasure(q, m.name, defaultAgg(m));
  if (q.measures.length < needMeasures) q = addMeasure(q, '*', 'count');
  for (const f of fields.filter((x) => x.secondary)) {
    if (q.measures.length >= needMeasures) break;
    q = addMeasure(q, f.name, 'count_distinct');
  }
  if (q.dimensions.length && !q.dimensions.some((d) => d.grain) && q.orderBy.length === 0) {
    q = { ...q, orderBy: [{ field: measureAlias(q.measures[0]!), dir: 'desc' }] };
  }
  return q;
}

/**
 * Switches a query to custom SQL (spec 1.4). The visual fields are dropped; a starting SELECT is
 * written from them so the author edits rather than starts blank. Filters, sort and limit stay.
 */
export function toSqlQuery(q: NormalQuery, sourceId: string): NormalQuery {
  const dims = q.dimensions.map((d) => (d.grain ? `date_trunc('${d.grain}', ${d.field}) AS ${d.as ?? d.field}` : d.as ? `${d.field} AS ${d.as}` : d.field));
  const measures = q.measures.map((m) => `${aggSql(m.agg, m.field)} AS ${measureAlias(m)}`);
  const select = [...dims, ...measures];
  const sql = select.length
    ? `SELECT ${select.join(', ')}\nFROM ${sourceId}${dims.length && measures.length ? `\nGROUP BY ${dims.map((_, i) => i + 1).join(', ')}` : ''}`
    : `SELECT *\nFROM ${sourceId}`;
  return { source: q.source, dimensions: [], measures: [], filters: [], orderBy: [], ...(q.limit !== undefined ? { limit: q.limit } : {}), sql, columns: [] };
}

const PCT: Partial<Record<Aggregation, number>> = { p25: 0.25, p75: 0.75, p90: 0.9 };
/** SQL both DuckDB and Snowflake accept for an aggregation (a starting point the author edits). */
function aggSql(agg: Aggregation, field: string): string {
  if (field === '*') return 'count(*)';
  if (agg === 'count_distinct') return `count(DISTINCT ${field})`;
  const p = PCT[agg];
  if (p !== undefined) return `percentile_cont(${p}) WITHIN GROUP (ORDER BY ${field})`;
  return `${agg}(${field})`;
}

/** Back to the visual builder: drops the SQL and its columns. */
export function toVisualQuery(q: NormalQuery): NormalQuery {
  return { source: q.source, dimensions: [], measures: [], filters: [], orderBy: [], ...(q.limit !== undefined ? { limit: q.limit } : {}) };
}

/** Declared columns from a run of the SQL: numbers become measures (unless they were declared otherwise), the rest dimensions. */
export function detectedColumns(result: { columns: Array<{ name: string; type: string }> }, previous: SqlColumn[] = []): SqlColumn[] {
  return result.columns.map((c) => {
    const before = previous.find((p) => p.name === c.name);
    const type = (['string', 'number', 'time', 'boolean'] as const).find((t) => t === c.type) ?? 'string';
    const role = before?.role ?? (type === 'number' ? 'measure' : 'dimension');
    return { name: c.name, role, ...(role === 'dimension' ? { type } : {}) };
  });
}
