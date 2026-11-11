import type { TimeGrain } from '@yourorg/bi-spec';

/**
 * The few places DuckDB and Snowflake SQL differ. Everything else the compiler emits is the
 * common subset both accept (quoted identifiers, `?` binds, ordinal GROUP BY / ORDER BY,
 * `NULLS LAST`, `count(DISTINCT …)`, `CAST(… AS DOUBLE)`).
 */

/** Logical column kinds the compiler and profiler reason about, mapped from engine types. */
export type ColumnKind = 'integer' | 'number' | 'string' | 'boolean' | 'date' | 'timestamp' | 'other';

export interface Dialect {
  name: 'duckdb' | 'snowflake';
  /** `expr` truncated to the start of its grain period, as a DATE/TIMESTAMP. ISO weeks start Monday. */
  truncate(grain: TimeGrain, expr: string): string;
  /** A temporal expression rendered as 'YYYY-MM-DD', the wire format for dates. */
  formatDate(expr: string): string;
  /** A timestamp rendered as 'YYYY-MM-DDTHH:MM:SS'. */
  formatTimestamp(expr: string): string;
  boolAnd(expr: string): string;
  boolOr(expr: string): string;
  /** Distinct count used by the profiler: exact where cheap, approximate where it would scan. */
  profileDistinct(expr: string): string;
  /** Continuous (interpolated) percentile aggregate; `p` is one of our constants (0.25, 0.5, …). */
  percentile(p: number, expr: string): string;
}

/** Quotes an identifier (column, table, schema). Embedded quotes are doubled, so any name is safe. */
export function quoteIdent(name: string): string {
  if (name.includes('\u0000')) throw new Error('Identifiers cannot contain NUL characters.');
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A single-quoted SQL string literal. Only for server-generated values (our own Parquet paths in
 * statements that cannot take bind parameters, such as COPY); never for user input.
 */
export function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) throw new Error('Literals cannot contain NUL characters.');
  return `'${value.replace(/'/g, "''")}'`;
}

export const duckdb: Dialect = {
  name: 'duckdb',
  // DuckDB's date_trunc('week', …) already truncates to the ISO Monday.
  truncate: (grain, expr) => `date_trunc('${grain}', ${expr})`,
  formatDate: (expr) => `strftime(${expr}, '%Y-%m-%d')`,
  formatTimestamp: (expr) => `strftime(${expr}, '%Y-%m-%dT%H:%M:%S')`,
  boolAnd: (expr) => `bool_and(${expr})`,
  boolOr: (expr) => `bool_or(${expr})`,
  profileDistinct: (expr) => `count(DISTINCT ${expr})`,
  percentile: (p, expr) => `quantile_cont(${expr}, ${p})`,
};

export const snowflake: Dialect = {
  name: 'snowflake',
  truncate: (grain, expr) =>
    grain === 'week'
      ? // DATE_TRUNC('WEEK') follows the WEEK_START session parameter; DAYOFWEEKISO does not.
        `DATEADD('day', 1 - DAYOFWEEKISO(${expr}), DATE_TRUNC('DAY', ${expr}))`
      : `DATE_TRUNC('${grain.toUpperCase()}', ${expr})`,
  formatDate: (expr) => `TO_CHAR(${expr}, 'YYYY-MM-DD')`,
  formatTimestamp: (expr) => `TO_CHAR(${expr}, 'YYYY-MM-DD"T"HH24:MI:SS')`,
  boolAnd: (expr) => `BOOLAND_AGG(${expr})`,
  boolOr: (expr) => `BOOLOR_AGG(${expr})`,
  // The profiler already samples on Snowflake; HLL keeps even the sample cheap.
  profileDistinct: (expr) => `APPROX_COUNT_DISTINCT(${expr})`,
  percentile: (p, expr) => `PERCENTILE_CONT(${p}) WITHIN GROUP (ORDER BY ${expr})`,
};

const DUCKDB_INTEGER = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|INT\d*)$/;

/** Maps a DuckDB type name (as DESCRIBE prints it) to a column kind. */
export function duckdbKind(type: string): ColumnKind {
  const t = type.toUpperCase();
  if (DUCKDB_INTEGER.test(t)) return 'integer';
  if (/^(DOUBLE|FLOAT|REAL)$/.test(t) || t.startsWith('DECIMAL')) return t.endsWith(',0)') ? 'integer' : 'number';
  if (t === 'VARCHAR' || t.startsWith('VARCHAR(')) return 'string';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'DATE') return 'date';
  if (t.startsWith('TIMESTAMP')) return 'timestamp';
  return 'other';
}

/** Maps Snowflake INFORMATION_SCHEMA.COLUMNS (DATA_TYPE, NUMERIC_SCALE) to a column kind. */
export function snowflakeKind(dataType: string, numericScale?: number | null): ColumnKind {
  const t = dataType.toUpperCase();
  if (t === 'NUMBER' || t === 'DECIMAL' || t === 'NUMERIC') return numericScale ? 'number' : 'integer';
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|BYTEINT)$/.test(t)) return 'integer';
  if (/^(FLOAT|FLOAT4|FLOAT8|DOUBLE|DOUBLE PRECISION|REAL)$/.test(t)) return 'number';
  if (/^(TEXT|VARCHAR|STRING|CHAR|CHARACTER)$/.test(t)) return 'string';
  if (t === 'BOOLEAN') return 'boolean';
  if (t === 'DATE') return 'date';
  if (t.startsWith('TIMESTAMP') || t === 'DATETIME') return 'timestamp';
  return 'other';
}
