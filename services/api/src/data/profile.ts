import type {
  Cardinality,
  Cell,
  ColumnProfile,
  ColumnType,
  DataSource,
  DetectedFormat,
  FieldRole,
  SemanticType,
  SourceProfile,
} from '@yourorg/bi-spec';
import type { Row } from './sample/execute';
import type { BindValue, Relation } from './sql/compile';
import { quoteIdent, type ColumnKind, type Dialect } from './sql/dialect';
import { toCell } from './sql/result';

/**
 * The metadata profiler. It runs once per source and feeds the authoring UI's field panel and the
 * AI recommender, so it reports summaries only: counts, ranges and at most five sample values per
 * column, never rows.
 *
 * Gathering stats is engine-specific (in-memory rows, or two SQL statements pushed down to DuckDB
 * or Snowflake); classifying them is shared, so every source type is described by the same rules.
 */

/** Per-column facts gathered from a source; everything else is derived by `buildProfile`. */
export interface ColumnStats {
  name: string;
  kind: ColumnKind;
  nonNull: number;
  distinct: number;
  min?: Cell;
  max?: Cell;
  /** Up to 5 distinct non-null values, most frequent first. */
  samples: Cell[];
}

export interface SourceStats {
  rowCount: number;
  /** Rows the column stats were computed over, when that differs from rowCount (a sample). */
  scannedRows?: number;
  sampled: boolean;
  columns: ColumnStats[];
}

export const SAMPLE_VALUES = 5;
/** Distinct counts at or below this are "low" cardinality: good chart dimensions. */
export const LOW_CARDINALITY = 20;
/** Distinct counts at or below this are "medium": usable as dimensions (tables, filters). */
export const MEDIUM_CARDINALITY = 1000;

const ID_SUFFIX = /(^|[_\s-])(id|uuid|guid|key|sku)$/i;
const ID_CAMEL = /[a-z](Id|ID)$/;
const isIdName = (name: string) => ID_SUFFIX.test(name) || ID_CAMEL.test(name);
const GEO_NAME = /(^|_)(country|region|state|province|city|zip|zipcode|postal|postcode|continent|county|lat|latitude|lon|lng|longitude|geo|location)(_|$)/i;
const CALENDAR_NAME = /(^|_)(year|quarter|month|week|weekday|day|hour)$/i;
const CURRENCY_NAME = /(amount|price|revenue|cost|sales|spend|fee|income|profit|salary|budget|usd|eur|gbp)/i;
const PERCENT_NAME = /(pct|percent|percentage|rate|ratio|share)(_|$)/i;
const CURRENCY_TEXT = /^[-+]?[$€£¥]\s?\d[\d,]*(\.\d+)?$/;
const PERCENT_TEXT = /^[-+]?\d+(\.\d+)?\s?%$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

function physicalType(kind: ColumnKind): ColumnType {
  if (kind === 'integer' || kind === 'number') return 'number';
  if (kind === 'boolean') return 'boolean';
  if (kind === 'date' || kind === 'timestamp') return 'time';
  return 'string';
}

function cardinalityOf(c: ColumnStats): Cardinality {
  if (c.nonNull > 1 && c.distinct >= c.nonNull) return 'unique';
  if (c.distinct <= LOW_CARDINALITY) return 'low';
  if (c.distinct <= MEDIUM_CARDINALITY) return 'medium';
  return 'high';
}

function looksLikeProse(samples: Cell[]): boolean {
  const strings = samples.filter((s): s is string => typeof s === 'string');
  if (!strings.length) return false;
  const avg = strings.reduce((n, s) => n + s.length, 0) / strings.length;
  return avg > 30 || strings.filter((s) => /\s/.test(s.trim())).length > strings.length / 2;
}

function semanticTypeOf(c: ColumnStats, cardinality: Cardinality): SemanticType {
  if (c.kind === 'boolean') return 'boolean';
  if (c.kind === 'date' || c.kind === 'timestamp') return 'temporal';
  const numeric = c.kind === 'integer' || c.kind === 'number';
  if (isIdName(c.name)) return 'id';
  if (GEO_NAME.test(c.name)) return 'geo';
  if (numeric) return c.kind === 'integer' && CALENDAR_NAME.test(c.name) ? 'categorical' : 'numeric';
  if (c.distinct <= MEDIUM_CARDINALITY || c.distinct <= c.nonNull / 2) return 'categorical';
  if (looksLikeProse(c.samples)) return 'text';
  return cardinality === 'unique' ? 'id' : 'text';
}

function roleOf(c: ColumnStats, semantic: SemanticType, cardinality: Cardinality): FieldRole {
  if (c.nonNull === 0) return 'ignore';
  switch (semantic) {
    case 'temporal':
      return 'time';
    case 'numeric':
      return 'measure';
    case 'id':
      // A low-cardinality id (store_id with 12 stores) still makes a fine dimension.
      return cardinality === 'low' || cardinality === 'medium' ? 'dimension' : 'key';
    case 'geo':
      return c.kind === 'integer' || c.kind === 'number' ? 'ignore' : 'dimension'; // lat/lng need a map widget
    case 'boolean':
    case 'categorical':
      return 'dimension';
    case 'text':
      return 'ignore';
  }
}

function formatOf(c: ColumnStats): DetectedFormat | undefined {
  if (c.kind === 'date') return 'date';
  if (c.kind === 'timestamp') return 'datetime';
  if (c.kind === 'integer' || c.kind === 'number') {
    if (isIdName(c.name) || CALENDAR_NAME.test(c.name)) return c.kind === 'integer' ? 'integer' : 'decimal';
    if (CURRENCY_NAME.test(c.name)) return 'currency';
    if (PERCENT_NAME.test(c.name)) return 'percent';
    return c.kind === 'integer' ? 'integer' : 'decimal';
  }
  if (c.kind === 'string' && c.samples.length) {
    const strings = c.samples.map(String);
    if (strings.every((s) => CURRENCY_TEXT.test(s))) return 'currency';
    if (strings.every((s) => PERCENT_TEXT.test(s))) return 'percent';
  }
  return undefined;
}

/** Classifies gathered stats into the profile contract. Deterministic: same stats, same profile. */
export function buildProfile(source: DataSource, stats: SourceStats, now: Date = new Date()): SourceProfile {
  const columns: ColumnProfile[] = stats.columns.map((c) => {
    const cardinality = cardinalityOf(c);
    const semanticType = semanticTypeOf(c, cardinality);
    const format = formatOf(c);
    const scanned = stats.scannedRows ?? stats.rowCount;
    const nullRate = scanned ? Math.round(((scanned - c.nonNull) / scanned) * 1e4) / 1e4 : 0;
    return {
      name: c.name,
      physicalType: physicalType(c.kind),
      semanticType,
      role: roleOf(c, semanticType, cardinality),
      nullRate: Math.min(1, Math.max(0, nullRate)),
      distinctCount: c.distinct,
      cardinality,
      ...(c.min !== undefined && c.min !== null ? { min: c.min } : {}),
      ...(c.max !== undefined && c.max !== null ? { max: c.max } : {}),
      sampleValues: c.samples.slice(0, SAMPLE_VALUES),
      ...(format ? { format } : {}),
    };
  });
  const named = (pred: (c: ColumnProfile) => boolean) => columns.filter(pred).map((c) => c.name);
  return {
    source: { type: source.type, ref: source.ref },
    rowCount: stats.rowCount,
    sampled: stats.sampled,
    columns,
    timeColumns: named((c) => c.role === 'time'),
    measureCandidates: named((c) => c.role === 'measure'),
    dimensionCandidates: named((c) => c.role === 'dimension' && (c.cardinality === 'low' || c.cardinality === 'medium')),
    keyCandidates: named((c) => c.role === 'key'),
    profiledAt: now.toISOString(),
  };
}

// ── In-memory sources ───────────────────────────────────────────────────────

function inferKind(values: Cell[]): ColumnKind {
  if (!values.length) return 'string';
  if (values.every((v) => typeof v === 'number')) return values.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
  if (values.every((v) => typeof v === 'boolean')) return 'boolean';
  if (values.every((v) => typeof v === 'string' && ISO_DATE.test(v))) return 'date';
  if (values.every((v) => typeof v === 'string' && ISO_DATETIME.test(v))) return 'timestamp';
  return 'string';
}

function topValues(counts: Map<Cell, number>): Cell[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))
    .slice(0, SAMPLE_VALUES)
    .map(([v]) => v);
}

/** Stats for rows held in memory (the sample engine). A full scan: these datasets are small. */
export function statsFromRows(rows: readonly Row[], fields: Iterable<string>): SourceStats {
  const columns = [...fields].map<ColumnStats>((name) => {
    const counts = new Map<Cell, number>();
    const values: Cell[] = [];
    for (const row of rows) {
      const v = row[name] ?? null;
      if (v === null) continue;
      values.push(v);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const kind = inferKind(values);
    const stats: ColumnStats = { name, kind, nonNull: values.length, distinct: counts.size, samples: topValues(counts) };
    if (values.length && kind !== 'string' && kind !== 'boolean') {
      const sorted = [...counts.keys()].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : 1));
      stats.min = sorted[0]!;
      stats.max = sorted[sorted.length - 1]!;
    }
    return stats;
  });
  return { rowCount: rows.length, sampled: false, columns };
}

// ── SQL sources (DuckDB, Snowflake) ─────────────────────────────────────────

export type SqlRunner = (sql: string, params: BindValue[]) => Promise<Array<Record<string, unknown>>>;

function asText(dialect: Dialect, kind: ColumnKind, col: string): string {
  if (kind === 'date') return dialect.formatDate(col);
  if (kind === 'timestamp') return dialect.formatTimestamp(col);
  return `CAST(${col} AS VARCHAR)`;
}

function fromText(kind: ColumnKind, value: unknown): Cell {
  if (kind === 'integer' || kind === 'number') return toCell(value, 'number');
  if (kind === 'boolean') return toCell(value, 'boolean');
  return toCell(value, 'string');
}

/**
 * Stats pushed down as two statements: one aggregate pass (counts, distincts, ranges) and one
 * UNION ALL of per-column top-5 lists. The relation may itself be a sample (Snowflake).
 */
export async function statsFromSql(
  run: SqlRunner,
  dialect: Dialect,
  relation: Relation,
  columns: ReadonlyMap<string, ColumnKind>,
  { sampled = false, rowCount }: { sampled?: boolean; rowCount?: number } = {},
): Promise<SourceStats> {
  const cols = [...columns.entries()];
  const cte = `WITH t AS (SELECT * FROM ${relation.sql})`;

  const aggs = ['count(*) AS "r"'];
  cols.forEach(([name, kind], i) => {
    const col = quoteIdent(name);
    aggs.push(`count(${col}) AS "n${i}"`, `${dialect.profileDistinct(col)} AS "d${i}"`);
    if (kind === 'integer' || kind === 'number') aggs.push(`CAST(min(${col}) AS DOUBLE) AS "lo${i}"`, `CAST(max(${col}) AS DOUBLE) AS "hi${i}"`);
    if (kind === 'date' || kind === 'timestamp') aggs.push(`${asText(dialect, kind, `min(${col})`)} AS "lo${i}"`, `${asText(dialect, kind, `max(${col})`)} AS "hi${i}"`);
  });
  const [agg = {}] = await run(`${cte}\nSELECT ${aggs.join(', ')} FROM t`, relation.params);

  const samples = new Map<number, Cell[]>();
  if (cols.length) {
    const parts = cols.map(([name, kind], i) => {
      const col = quoteIdent(name);
      return `(SELECT ${i} AS "i", ${asText(dialect, kind, col)} AS "v", count(*) AS "c" FROM t WHERE ${col} IS NOT NULL GROUP BY 2 ORDER BY 3 DESC, 2 ASC LIMIT ${SAMPLE_VALUES})`;
    });
    const rows = await run(`${cte}\nSELECT "i", "v", "c" FROM (\n${parts.join('\nUNION ALL\n')}\n) AS s`, relation.params);
    // UNION ALL promises no order across (or within) branches, so restore most-frequent-first here.
    const byColumn = new Map<number, Array<{ v: string; c: number }>>();
    for (const row of rows) {
      const i = Number(row.i);
      const list = byColumn.get(i) ?? [];
      list.push({ v: String(row.v), c: Number(row.c) });
      byColumn.set(i, list);
    }
    for (const [i, list] of byColumn) {
      const kind = cols[i]?.[1];
      if (kind === undefined) continue;
      list.sort((a, b) => b.c - a.c || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
      samples.set(i, list.slice(0, SAMPLE_VALUES).map((s) => fromText(kind, s.v)));
    }
  }

  const num = (key: string) => {
    const v = (agg as Record<string, unknown>)[key];
    return v === null || v === undefined ? 0 : Number(v);
  };
  return {
    rowCount: rowCount ?? num('r'),
    scannedRows: num('r'),
    sampled,
    columns: cols.map(([name, kind], i) => {
      const stats: ColumnStats = { name, kind, nonNull: num(`n${i}`), distinct: num(`d${i}`), samples: samples.get(i) ?? [] };
      const lo = (agg as Record<string, unknown>)[`lo${i}`];
      const hi = (agg as Record<string, unknown>)[`hi${i}`];
      if (lo !== undefined && lo !== null) stats.min = fromText(kind, lo);
      if (hi !== undefined && hi !== null) stats.max = fromText(kind, hi);
      // Approximate distincts (Snowflake HLL) can overshoot; never report more than non-nulls.
      stats.distinct = Math.min(stats.distinct, stats.nonNull);
      return stats;
    }),
  };
}
