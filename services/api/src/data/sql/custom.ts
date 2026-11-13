import { sqlHasMultipleStatements, type Cell, type Query, type QueryResult, type ResultColumn, type SqlColumn } from '@yourorg/bi-spec';
import { EngineError } from '../engine';
import { ISO_TEMPORAL, predicate, type BindValue, type CompiledQuery, type Relation } from './compile';
import { quoteIdent, type ColumnKind, type Dialect } from './dialect';

/**
 * Custom SQL queries (spec 1.4, D-070). The author's SQL is never run as written: it is checked to be
 * one statement and run as a subquery of a statement the server builds,
 *
 *   WITH "<source id>" AS (SELECT * FROM <team-checked relation>), …
 *   SELECT <declared columns> FROM (
 *   <author SQL>
 *   ) AS "sratchpad_q" WHERE <filters as binds> ORDER BY … LIMIT <validated n + 1>
 *
 * so only a query can run (DDL/DML inside a subquery is a syntax error), filters from params,
 * cross-filters and the author stay bind parameters, and the row cap holds. Engines add their own
 * isolation: Snowflake runs it under the team's role (single-statement sessions); DuckDB runs it in
 * a sandboxed instance that can read only the referenced uploads (duckdb/runtime.ts).
 */

/** A dashboard data source the SQL may name, already resolved and checked by the engine. */
export interface SqlSourceRelation {
  /** The dataSources id the author writes in the SQL, e.g. `FROM orders`. */
  name: string;
  relation: Relation;
}

/** Source ids usable as plain SQL names (others can still be reached in Snowflake by their full table name). */
export const SQL_SOURCE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A dashboard source attached to a custom SQL query by data/run.ts (engines re-check team access). */
export interface AttachedSqlSource {
  id: string;
  source: { type: string; ref: string };
}

/** Values for `{{param}}` placeholders, resolved by data/run.ts from the dashboard's params (D-080). */
export type SqlParamValue = string | number | boolean | null | Array<string | number | boolean> | { from: string; to: string; toExclusive: string } | [number | string | null, number | string | null];

export type SqlQuery = Query & { sqlSources?: AttachedSqlSource[]; sqlParams?: Record<string, SqlParamValue> };

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,63})(?:\.(from|to|low|high))?\s*\}\}/g;

/** Param ids the SQL refers to with {{…}}. */
export function sqlPlaceholders(sql: string): string[] {
  return [...new Set([...sql.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/**
 * Replaces each {{param}} with bind placeholders (never inlined text): a scalar → ?, a list → ?, ?, …
 * (write `IN ({{regions}})`), a date range → {{p.from}} / {{p.to}} as DATE (to is inclusive), a range →
 * {{p.low}} / {{p.high}}. An empty value binds NULL, so write `({{p}} IS NULL OR col = {{p}})` for "all".
 */
function bindPlaceholders(sql: string, values: Record<string, SqlParamValue>, params: BindValue[]): string {
  return sql.replace(PLACEHOLDER, (_m, id: string, part?: string) => {
    if (!Object.hasOwn(values, id)) throw new EngineError('invalid_sql', `{{${id}}} is not a param of this dashboard.`);
    const v = values[id];
    const nullBind = () => 'CAST(NULL AS VARCHAR)';
    if (part === 'from' || part === 'to') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        if (v === null) return 'CAST(NULL AS DATE)';
        throw new EngineError('invalid_sql', `{{${id}.${part}}} needs a date range param.`);
      }
      params.push(part === 'from' ? (v as { from: string }).from : (v as { to: string }).to);
      return 'CAST(? AS DATE)';
    }
    if (part === 'low' || part === 'high') {
      if (!Array.isArray(v) || v.length !== 2) throw new EngineError('invalid_sql', `{{${id}.${part}}} needs a range param.`);
      const x = v[part === 'low' ? 0 : 1];
      if (x === null || x === undefined) return nullBind();
      params.push(x as BindValue);
      return '?';
    }
    if (v === null || v === undefined || v === '') return nullBind();
    if (Array.isArray(v)) {
      if (!v.length) return nullBind();
      for (const x of v) params.push(x as BindValue);
      return v.map(() => '?').join(', ');
    }
    if (typeof v === 'object') throw new EngineError('invalid_sql', `{{${id}}} is a date range: use {{${id}.from}} and {{${id}.to}}.`);
    params.push(v);
    return '?';
  });
}

/** Ids of the dashboard's sources that the SQL text mentions (as a whole word, any case). */
export function mentionedSources(sql: string, ids: Iterable<string>): string[] {
  const lower = sql.toLowerCase();
  return [...ids].filter((id) => SQL_SOURCE_NAME.test(id) && new RegExp(`(^|[^a-z0-9_])${id.toLowerCase()}($|[^a-z0-9_])`).test(lower));
}

/** Engine-side check (exact for the dialect) that the text is a single statement; returns it without a trailing ";". */
export function checkCustomSql(sql: string | undefined, dialect: Dialect): string {
  const text = (sql ?? '').trim();
  if (!text) throw new EngineError('invalid_sql', 'The SQL is empty.');
  if (sqlHasMultipleStatements(text, dialect.name)) throw new EngineError('invalid_sql', 'Write one SELECT statement (no ";" between statements).');
  // One trailing ";" (optionally followed by line comments) is allowed; inside a subquery it is not.
  return text.replace(/;(\s|--[^\n]*)*$/, '');
}

const KIND_OF: Record<NonNullable<SqlColumn['type']>, ColumnKind> = { number: 'number', boolean: 'boolean', time: 'timestamp', string: 'string' };

/** The column kind a filter on an output column binds as: declared type, else guessed from the value. */
function filterKind(column: SqlColumn | undefined, value: unknown): ColumnKind {
  if (column?.role === 'measure') return 'number';
  if (column?.type) return KIND_OF[column.type];
  const sample = Array.isArray(value) ? value.find((v) => v !== null) : value;
  return typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'string';
}

/**
 * Snowflake resolves unquoted names in upper case, so the CTE for `FROM orders` is "ORDERS". DuckDB
 * names are case-insensitive even when quoted.
 */
const cteName = (dialect: Dialect, id: string) => quoteIdent(dialect.name === 'snowflake' ? id.toUpperCase() : id);

export function compileCustomSql(query: Query, input: { dialect: Dialect; sources: SqlSourceRelation[] }): CompiledQuery {
  const { dialect } = input;
  const body = checkCustomSql(query.sql, dialect);
  const declared = query.columns ?? [];
  const byName = new Map(declared.map((c) => [c.name, c]));
  const params: BindValue[] = [];
  const lines: string[] = [];

  if (input.sources.length) {
    lines.push(
      `WITH ${input.sources
        .map((s) => {
          params.push(...s.relation.params);
          return `${cteName(dialect, s.name)} AS (SELECT * FROM ${s.relation.sql})`;
        })
        .join(',\n  ')}`,
    );
  }
  const bound = bindPlaceholders(body, (query as SqlQuery).sqlParams ?? {}, params);
  lines.push(`SELECT ${declared.length ? declared.map((c) => quoteIdent(c.name)).join(', ') : '*'} FROM (\n${bound}\n) AS "sratchpad_q"`);
  const where = query.filters.map((flt, i) => {
    const column = byName.get(flt.field);
    if (declared.length && !column) throw new EngineError('unknown_field', `filters[${i}]: "${flt.field}" is not a declared column of this SQL query.`);
    const frag = predicate({ sql: quoteIdent(flt.field), kind: filterKind(column, flt.value) }, flt.op, flt.value as Cell | Cell[] | undefined, `filters[${i}]`, flt.field);
    params.push(...frag.params);
    return frag.sql;
  });
  if (where.length) lines.push(`WHERE ${where.map((w) => `(${w})`).join(' AND ')}`);
  if (query.orderBy.length) lines.push(`ORDER BY ${query.orderBy.map((o) => `${quoteIdent(o.field)} ${o.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`).join(', ')}`);
  lines.push(`LIMIT ${query.limit + 1}`);
  const columns: ResultColumn[] = declared.map((c) => ({ name: c.name, type: c.role === 'measure' ? 'number' : (c.type ?? 'string'), ...(c.grain ? { grain: c.grain } : {}) }));
  return { sql: lines.join('\n'), params, columns, limit: query.limit };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date values from drivers as wire strings: "YYYY-MM-DD" at midnight UTC, else "YYYY-MM-DDTHH:MM:SS". */
function temporal(value: unknown): string | null {
  if (value instanceof Date || (value && typeof value === 'object' && typeof (value as Date).toISOString === 'function')) {
    const d = value as Date;
    if (Number.isNaN(d.getTime())) return null;
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() ? `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : day;
  }
  if (typeof value === 'string' && ISO_TEMPORAL.test(value)) return value.replace(' ', 'T');
  return null;
}

function kindToType(kind: ColumnKind): ResultColumn['type'] {
  if (kind === 'integer' || kind === 'number') return 'number';
  if (kind === 'boolean') return 'boolean';
  if (kind === 'date' || kind === 'timestamp') return 'time';
  return 'string';
}

function guessType(values: unknown[]): ResultColumn['type'] {
  const v = values.find((x) => x !== null && x !== undefined);
  if (typeof v === 'number' || typeof v === 'bigint') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (temporal(v) !== null) return 'time';
  return 'string';
}

function cell(value: unknown, type: ResultColumn['type']): Cell {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true' || value === 1 || value === '1';
    case 'time':
      return temporal(value) ?? String(value);
    default:
      return value instanceof Date ? temporal(value) : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/**
 * Driver rows → wire result. With declared columns, those columns in that order (names matched
 * exactly, then case-insensitively: Snowflake upper-cases unquoted aliases). Without (the Studio's
 * "detect columns" preview), every returned column, typed from engine metadata when the engine has
 * it, else from the values.
 */
export function toCustomResult(
  compiled: CompiledQuery,
  declared: SqlColumn[],
  raw: ReadonlyArray<Record<string, unknown>>,
  engineColumns?: Array<{ name: string; kind: ColumnKind }>,
): QueryResult {
  const truncated = raw.length > compiled.limit;
  const kept = truncated ? raw.slice(0, compiled.limit) : raw;
  const present = engineColumns?.map((c) => c.name) ?? Object.keys(raw[0] ?? {});
  const resolveKey = (name: string) => present.find((k) => k === name) ?? present.find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
  let columns: ResultColumn[];
  let keys: string[];
  if (declared.length) {
    columns = compiled.columns.map((c, i) => {
      const d = declared[i]!;
      if (d.role === 'measure' || d.type) return c;
      const key = resolveKey(c.name);
      const meta = engineColumns?.find((e) => e.name === key);
      return { ...c, type: meta ? kindToType(meta.kind) : guessType(kept.map((r) => r[key])) };
    });
    keys = columns.map((c) => resolveKey(c.name));
  } else {
    keys = present;
    columns = present.map((name) => {
      const meta = engineColumns?.find((e) => e.name === name);
      return { name, type: meta ? kindToType(meta.kind) : guessType(kept.map((r) => r[name])) };
    });
  }
  const rows = kept.map((r) => {
    const row: Record<string, Cell> = {};
    columns.forEach((c, i) => (row[c.name] = cell(r[keys[i]!], c.type)));
    return row;
  });
  return { columns, rows, truncated };
}

/** DuckDB's message for the author's SQL, without server file paths. */
export function sqlErrorMessage(error: unknown): string {
  const message = String((error as Error)?.message ?? error).split('\n')[0]!;
  return message.replace(/"\/[^"]*"/g, '"<file>"').replace(/'\/[^']*'/g, "'<file>'");
}
