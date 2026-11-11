import {
  dimensionAlias,
  MAX_QUERY_LIMIT,
  measureAlias,
  type Cell,
  type CalcNode,
  type Dimension,
  type Join,
  type Measure,
  type Query,
  type ResultColumn,
  type WindowCalc,
} from '@yourorg/bi-spec';
import { EngineError } from '../engine';
import { checkQueryFields, effectiveOrder, parsedCalc } from '../query-check';
import { quoteIdent, type ColumnKind, type Dialect } from './dialect';

/**
 * Semantic query → parameterized SQL.
 *
 * The output must match the in-memory sample engine (the reference implementation) row for row:
 * same column names and types, time buckets as 'YYYY-MM-DD' strings, SQL NULL semantics, NULLS
 * LAST in both directions and the same tie-break order. The conformance suite holds us to it.
 *
 * Safety: identifiers come from the spec and are always quoted; every value is a bind parameter
 * (filter values, bucket labels, bin widths, expression numbers); the only numbers inlined are
 * validated integers the engines do not accept as binds (LIMIT, window frame sizes, lag offsets,
 * round() digits) and our own percentile constants.
 *
 * Spec 1.3 adds: bins and buckets (dimension expressions), median/percentiles/stddev, calcs
 * (expressions compiled from their AST over unrounded aggregates), windows (window functions over
 * the aggregated rows, in the same SELECT), top-N (a ranked IN-subquery over the same filtered
 * relation), contains/starts_with/ends_with, and joins.
 */

export type BindValue = string | number | boolean;

/** What the query runs against: a FROM-clause item, plus the binds it needs (e.g. a file path). */
export interface Relation {
  sql: string;
  params: BindValue[];
}

/** A joined source the engine resolved (and checked the team may read). Keyed by dataSources id. */
export interface JoinedRelation {
  relation: Relation;
  columns: ReadonlyMap<string, ColumnKind>;
}

export interface CompileInput {
  dialect: Dialect;
  relation: Relation;
  /** The relation's columns, in order, with their kinds. */
  columns: ReadonlyMap<string, ColumnKind>;
  /** Joined sources (spec 1.3 `joins`), keyed by dataSources id. */
  joined?: ReadonlyMap<string, JoinedRelation>;
}

export interface CompiledQuery {
  sql: string;
  params: BindValue[];
  /** The result columns, in SELECT order, with their wire types. */
  columns: ResultColumn[];
  /** Rows to keep; the SQL fetches one more to detect truncation. */
  limit: number;
}

/** SQL text with the binds it needs, in text order. */
interface Frag {
  sql: string;
  params: BindValue[];
}
const f = (sql: string, params: BindValue[] = []): Frag => ({ sql, params });
/** Joins fragments with `sep`, concatenating binds in order. */
function cat(parts: Frag[], sep = ''): Frag {
  return { sql: parts.map((p) => p.sql).join(sep), params: parts.flatMap((p) => p.params) };
}
/** Template: `t\`a ${frag} b\`` keeps bind order. */
function t(strings: TemplateStringsArray, ...frags: Array<Frag | string | number>): Frag {
  const out: Frag = { sql: strings[0]!, params: [] };
  frags.forEach((x, i) => {
    if (typeof x === 'string' || typeof x === 'number') out.sql += String(x);
    else {
      out.sql += x.sql;
      out.params.push(...x.params);
    }
    out.sql += strings[i + 1]!;
  });
  return out;
}

const ISO_TEMPORAL = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

function wireType(kind: ColumnKind): ResultColumn['type'] {
  switch (kind) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
    case 'timestamp':
      return 'time';
    default:
      return 'string';
  }
}

/** Renders a column value for the wire: dates and timestamps as ISO strings, exotic types as text. */
function present(dialect: Dialect, kind: ColumnKind, expr: string): string {
  if (kind === 'date') return dialect.formatDate(expr);
  if (kind === 'timestamp') return dialect.formatTimestamp(expr);
  if (kind === 'other') return `CAST(${expr} AS VARCHAR)`;
  return expr;
}

const isNumeric = (kind: ColumnKind) => kind === 'integer' || kind === 'number';

const PERCENTILES: Record<string, number> = { median: 0.5, p25: 0.25, p75: 0.75, p90: 0.9 };

interface Col {
  sql: string;
  kind: ColumnKind;
}

/** Field resolution: the source's columns unqualified, joined sources' as "id.column". */
export interface Scope {
  col(field: string): Col;
  names: string[];
  from: Frag;
}

export function buildScope(query: Query, input: CompileInput): Scope {
  const joins: Join[] = query.joins ?? [];
  if (!joins.length) {
    const names = [...input.columns.keys()];
    return {
      names,
      col: (field) => ({ sql: quoteIdent(field), kind: input.columns.get(field)! }),
      from: f(input.relation.sql, [...input.relation.params]),
    };
  }
  const map = new Map<string, Col>();
  for (const [name, kind] of input.columns) map.set(name, { sql: `"t0".${quoteIdent(name)}`, kind });
  for (const [name, kind] of input.columns) if (!map.has(`${query.source}.${name}`)) map.set(`${query.source}.${name}`, { sql: `"t0".${quoteIdent(name)}`, kind });
  const parts: Frag[] = [f(`${input.relation.sql} AS "t0"`, [...input.relation.params])];
  joins.forEach((j, k) => {
    const joined = input.joined?.get(j.source);
    if (!joined) throw new EngineError('unknown_source', `Joined source "${j.source}" was not found or is not visible to this team.`);
    const alias = `"t${k + 1}"`;
    const own = (name: string): Col | undefined => {
      const kind = joined.columns.get(name);
      return kind ? { sql: `${alias}.${quoteIdent(name)}`, kind } : undefined;
    };
    const on = j.on.map((o, i) => {
      const left = map.get(o.left);
      const right = own(o.right) ?? (o.right.startsWith(`${j.source}.`) ? own(o.right.slice(j.source.length + 1)) : undefined);
      if (!left) throw new EngineError('unknown_field', `joins[${k}].on[${i}]: unknown field "${o.left}" on the left side.`);
      if (!right) throw new EngineError('unknown_field', `joins[${k}].on[${i}]: "${o.right}" is not a column of "${j.source}".`);
      const comparable = left.kind === right.kind || (isNumeric(left.kind) && isNumeric(right.kind));
      if (!comparable || left.kind === 'other') throw new EngineError('invalid_join', `joins[${k}].on[${i}]: "${o.left}" and "${o.right}" have different types.`);
      return `${left.sql} = ${right.sql}`;
    });
    parts.push(f(` ${j.type === 'inner' ? 'INNER' : 'LEFT'} JOIN ${joined.relation.sql} AS ${alias} ON ${on.join(' AND ')}`, [...joined.relation.params]));
    for (const [name, kind] of joined.columns) {
      const key = `${j.source}.${name}`;
      if (!map.has(key)) map.set(key, { sql: `${alias}.${quoteIdent(name)}`, kind });
    }
  });
  return { names: [...map.keys()], col: (field) => map.get(field)!, from: cat(parts) };
}

export function compileQuery(query: Query, input: CompileInput): CompiledQuery {
  const { dialect } = input;
  const scope = buildScope(query, input);
  checkQueryFields(query, scope.names);
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_QUERY_LIMIT) {
    throw new EngineError('invalid_limit', `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}.`);
  }
  const { col } = scope;

  // ── WHERE (also reused by the top-N subquery) ──
  const filterFrags = query.filters.map((flt, i) => {
    const c = col(flt.field);
    return predicate(c, flt.op, flt.value as Cell | Cell[] | undefined, `filters[${i}] on "${flt.field}"`, flt.field);
  });

  // ── dimensions ──
  const dimFrags: Frag[] = [];
  const dimColumns: ResultColumn[] = [];
  query.dimensions.forEach((d, i) => {
    const { frag, column } = dimension(d, i);
    dimFrags.push(frag);
    dimColumns.push(column);
  });

  function dimension(d: Dimension, i: number): { frag: Frag; column: ResultColumn } {
    const c = col(d.field);
    const name = dimensionAlias(d);
    if (d.grain) {
      if (c.kind !== 'date' && c.kind !== 'timestamp') {
        throw new EngineError('invalid_grain', `"${d.field}" is not a date column, so it cannot have a "${d.grain}" grain.`);
      }
      return { frag: f(dialect.formatDate(dialect.truncate(d.grain, c.sql))), column: { name, type: 'time', grain: d.grain } };
    }
    if (d.bin) {
      if (!isNumeric(c.kind)) throw new EngineError('invalid_dimension', `dimensions[${i}]: "${d.field}" is not numeric, so it cannot be binned.`);
      const off = d.bin.offset ?? 0;
      return {
        frag: f(`round(floor((CAST(${c.sql} AS DOUBLE) - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE)) * CAST(? AS DOUBLE) + CAST(? AS DOUBLE), 6)`, [off, d.bin.width, d.bin.width, off]),
        column: { name, type: 'number' },
      };
    }
    if (d.buckets) {
      const whens = d.buckets.rules.map((r, j) => {
        const pred = predicate(c, r.op, r.value as Cell | Cell[] | undefined, `dimensions[${i}].buckets.rules[${j}]`, d.field);
        return t` WHEN ${pred} THEN CAST(? AS VARCHAR)`;
      });
      whens.forEach((w, j) => w.params.push(d.buckets!.rules[j]!.label));
      const otherwise = d.buckets.else == null ? f(' ELSE NULL') : f(' ELSE CAST(? AS VARCHAR)', [d.buckets.else]);
      return { frag: t`CASE${cat(whens)}${otherwise} END`, column: { name, type: 'string' } };
    }
    return { frag: f(present(dialect, c.kind, c.sql)), column: { name, type: wireType(c.kind) } };
  }

  // ── measures: the output (rounded, presented) and raw (unrounded DOUBLE, for calcs) forms ──
  const measureOut = new Map<string, Frag>();
  const measureRaw = new Map<string, Frag>();
  const measureColumns: ResultColumn[] = [];
  query.measures.forEach((m, i) => {
    const out = measure(m, i);
    measureOut.set(measureAlias(m), out.frag);
    measureColumns.push(out.column);
  });

  function aggExpr(agg: string, c: Col | null, where: string): { sql: string; numeric: boolean } {
    if (c === null) return { sql: 'count(*)', numeric: true };
    switch (agg) {
      case 'count':
        return { sql: `count(${c.sql})`, numeric: true };
      case 'count_distinct':
        return { sql: `count(DISTINCT ${c.sql})`, numeric: true };
      case 'sum':
      case 'avg':
      case 'stddev':
      case 'median':
      case 'p25':
      case 'p75':
      case 'p90':
        if (!isNumeric(c.kind)) throw new EngineError('invalid_measure', `${where}: the column is not numeric, so it cannot be aggregated with "${agg}".`);
        if (agg === 'stddev') return { sql: `stddev_samp(${c.sql})`, numeric: true };
        if (agg in PERCENTILES) return { sql: dialect.percentile(PERCENTILES[agg]!, c.sql), numeric: true };
        return { sql: `${agg}(${c.sql})`, numeric: true };
      default:
        return { sql: `${agg}(${c.sql})`, numeric: isNumeric(c.kind) };
    }
  }

  function measure(m: Measure, i: number): { frag: Frag; column: ResultColumn } {
    const name = measureAlias(m);
    if (m.field === '*') {
      measureRaw.set(name, f('CAST(count(*) AS DOUBLE)'));
      return { frag: f('count(*)'), column: { name, type: 'number' } };
    }
    const c = col(m.field);
    const where = `measures[${i}] "${m.field}"`;
    switch (m.agg) {
      case 'count':
      case 'count_distinct': {
        const e = aggExpr(m.agg, c, where);
        measureRaw.set(name, f(`CAST(${e.sql} AS DOUBLE)`));
        return { frag: f(e.sql), column: { name, type: 'number' } };
      }
      case 'min':
      case 'max':
        if (c.kind === 'boolean') {
          return { frag: f(m.agg === 'min' ? dialect.boolAnd(c.sql) : dialect.boolOr(c.sql)), column: { name, type: 'boolean' } };
        }
        if (c.kind === 'other') throw new EngineError('invalid_measure', `measures[${i}]: "${m.field}" cannot be compared, so it has no ${m.agg}.`);
        if (isNumeric(c.kind)) measureRaw.set(name, f(`CAST(${m.agg}(${c.sql}) AS DOUBLE)`));
        return { frag: f(present(dialect, c.kind, `${m.agg}(${c.sql})`)), column: { name, type: wireType(c.kind) } };
      default: {
        // sum, avg and the 1.3 statistics: rounded to 6 decimals in DOUBLE, exactly like the
        // reference engine, so values agree across engines despite different summation order.
        const e = aggExpr(m.agg, c, `measures[${i}]: "${m.field}"`);
        measureRaw.set(name, f(`CAST(${e.sql} AS DOUBLE)`));
        return { frag: f(`round(CAST(${e.sql} AS DOUBLE), 6)`), column: { name, type: 'number' } };
      }
    }
  }

  // ── calcs: AST → SQL over unrounded aggregates; the result rounded to 6 decimals ──
  const calcRaw = new Map<string, Frag>();
  const calcOut = new Map<string, Frag>();
  const calcColumns: ResultColumn[] = [];
  (query.calcs ?? []).forEach((c, i) => {
    const raw = calcSql(parsedCalc(c.expr, i), `calcs[${i}] "${c.as}"`);
    calcRaw.set(c.as, raw);
    calcOut.set(c.as, t`round(CAST(${raw} AS DOUBLE), 6)`);
    calcColumns.push({ name: c.as, type: 'number' });
  });

  function calcSql(node: CalcNode, where: string): Frag {
    switch (node.kind) {
      case 'num':
        return f('CAST(? AS DOUBLE)', [node.value]);
      case 'ref': {
        const r = measureRaw.get(node.name) ?? calcRaw.get(node.name);
        if (r) return r;
        if (measureOut.has(node.name)) throw new EngineError('invalid_calc', `${where}: "${node.name}" is not numeric.`);
        throw new EngineError('unknown_field', `${where}: "${node.name}" is not a measure or earlier calc of this query.`);
      }
      case 'agg': {
        const e = aggExpr(node.agg, node.field === '*' ? null : col(node.field), `${where}: ${node.agg}(${node.field})`);
        if (!e.numeric) throw new EngineError('invalid_calc', `${where}: ${node.agg}(${node.field}) is not numeric.`);
        return f(`CAST(${e.sql} AS DOUBLE)`);
      }
      case 'neg':
        return t`(-${calcSql(node.arg, where)})`;
      case 'bin': {
        const a = calcSql(node.left, where);
        const b = calcSql(node.right, where);
        return node.op === '/' ? t`(${a} / NULLIF(${b}, 0))` : t`(${a} ${node.op} ${b})`;
      }
      case 'fn': {
        const args = node.args.map((a) => calcSql(a, where));
        switch (node.fn) {
          case 'abs':
            return t`abs(${args[0]!})`;
          case 'round': {
            // Half away from zero, as both engines' ROUND on DOUBLE; digits validated by the parser.
            const digits = node.args[1] && node.args[1].kind === 'num' ? node.args[1].value : 0;
            return t`round(${args[0]!}, ${digits})`;
          }
          case 'coalesce':
            return t`coalesce(${cat(args, ', ')})`;
          case 'nullif':
            return t`nullif(${args[0]!}, ${args[1]!})`;
          case 'least':
          case 'greatest': {
            // NULL if any argument is NULL (DuckDB's LEAST would skip NULLs; Snowflake's would not).
            const anyNull = cat(args.map((a) => t`${a} IS NULL`), ' OR ');
            return t`(CASE WHEN ${anyNull} THEN NULL ELSE ${node.fn}(${cat(args, ', ')}) END)`;
          }
        }
      }
    }
    throw new EngineError('invalid_expression', `${where}: unsupported expression.`);
  }

  const valueOut = (alias: string): Frag | undefined => measureOut.get(alias) ?? calcOut.get(alias);
  const dimByAlias = new Map(query.dimensions.map((d, i) => [dimensionAlias(d), i]));

  // ── top-N: the dimension keeps its value only for the N best groups ──
  const extraWhere: Frag[] = [];
  if (query.topN) {
    const { dimension: alias, n, by } = query.topN;
    const i = dimByAlias.get(alias)!;
    if (dimColumns[i]!.type !== 'string') {
      throw new EngineError('invalid_top_n', `topN: "${alias}" must be a text dimension (a text column or buckets).`);
    }
    const byExpr = valueOut(by);
    if (!byExpr) throw new EngineError('invalid_top_n', `topN: "${by}" is not a measure or calc of this query.`);
    const where = filterFrags.length ? t` WHERE ${cat(filterFrags, ' AND ')}` : f('');
    const d = dimFrags[i]!;
    const sub = t`SELECT ${d} FROM ${scope.from}${where} GROUP BY 1 ORDER BY ${byExpr} DESC NULLS LAST, 1 ASC NULLS LAST LIMIT ${n}`;
    const otherLabel = query.topN.otherLabel === undefined ? 'Other' : query.topN.otherLabel;
    if (otherLabel === null) extraWhere.push(t`${d} IN (${sub})`);
    else {
      const folded = t`CASE WHEN ${d} IN (${sub}) THEN ${d} ELSE CAST(? AS VARCHAR) END`;
      folded.params.push(otherLabel);
      dimFrags[i] = folded;
    }
  }

  // ── windows over the aggregated rows ──
  const windowFrags: Frag[] = [];
  const windowColumns: ResultColumn[] = [];
  (query.windows ?? []).forEach((w, i) => {
    windowFrags.push(windowSql(w, i));
    windowColumns.push({ name: w.as, type: 'number' });
  });

  // Windows run in an outer SELECT over the grouped rows ("q"), so they reference output columns by
  // name (an expression with binds, like a bin, would not match its GROUP BY expression).
  function windowSql(w: WindowCalc, i: number): Frag {
    if (!valueOut(w.measure)) throw new EngineError('unknown_field', `windows[${i}]: "${w.measure}" is not a measure or calc of this query.`);
    const valueType = [...measureColumns, ...calcColumns].find((c) => c.name === w.measure)?.type;
    if (valueType !== 'number') throw new EngineError('invalid_window', `windows[${i}]: "${w.measure}" is not numeric.`);
    const v = f(`"q".${quoteIdent(w.measure)}`);
    const dim = (a: string) => f(`"q".${quoteIdent(a)}`);
    const partition = w.partition?.length ? t`PARTITION BY ${cat(w.partition.map(dim), ', ')}` : f('');
    const order = w.order ? t`ORDER BY ${dim(w.order)} ASC NULLS LAST` : f('');
    const over = (extra = '') => t`OVER (${cat([partition, order, f(extra)].filter((x) => x.sql), ' ')})`;
    switch (w.type) {
      case 'running_total':
        return t`round(CAST(sum(${v}) ${over('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')} AS DOUBLE), 6)`;
      case 'moving_average':
        return t`round(CAST(avg(${v}) ${over(`ROWS BETWEEN ${(w.window ?? 3) - 1} PRECEDING AND CURRENT ROW`)} AS DOUBLE), 6)`;
      case 'difference':
        return t`round(CAST(${v} - lag(${v}, ${w.offset ?? 1}) ${over()} AS DOUBLE), 6)`;
      case 'percent_change': {
        const prev = t`lag(${v}, ${w.offset ?? 1}) ${over()}`;
        return t`round(CAST((${v} - ${prev}) / NULLIF(abs(${prev}), 0) AS DOUBLE), 6)`;
      }
      case 'percent_of_total':
        return t`round(CAST(${v} / NULLIF(sum(${v}) ${t`OVER (${partition})`}, 0) AS DOUBLE), 6)`;
      case 'rank': {
        const dir = w.dir === 'asc' ? 'ASC' : 'DESC';
        return t`${w.dense ? 'dense_rank' : 'rank'}() OVER (${cat([partition, t`ORDER BY ${v} ${dir} NULLS LAST`].filter((x) => x.sql), ' ')})`;
      }
    }
  }

  // ── assemble ──
  const columns: ResultColumn[] = [...dimColumns, ...measureColumns, ...calcColumns, ...windowColumns];
  const exprs: Frag[] = [...dimFrags, ...[...measureOut.values()], ...[...calcOut.values()], ...windowFrags];
  if (!exprs.length) throw new EngineError('empty_query', 'A query needs at least one dimension or measure.');
  const grouped = exprs.length - windowFrags.length;
  const select = cat(
    exprs.slice(0, grouped).map((e, i) => t`${e} AS ${quoteIdent(columns[i]!.name)}`),
    ', ',
  );

  // Ordinals keep GROUP BY / ORDER BY unambiguous when an output alias equals a source column
  // name (e.g. a month-grain "order_date"), which DuckDB and Snowflake resolve differently.
  const names = columns.map((c) => c.name);
  const order = effectiveOrder(query).map((o) => `${names.indexOf(o.field) + 1} ${o.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);

  const lines: Frag[] = [t`SELECT ${select}`, t`FROM ${scope.from}`];
  const where = [...filterFrags, ...extraWhere];
  if (where.length) lines.push(t`WHERE ${cat(where, ' AND ')}`);
  if (query.dimensions.length) lines.push(f(`GROUP BY ${query.dimensions.map((_, i) => i + 1).join(', ')}`));
  if (windowFrags.length) {
    const inner = cat(lines, '\n');
    const outer = cat(
      [
        ...columns.slice(0, grouped).map((c) => f(`"q".${quoteIdent(c.name)}`)),
        ...windowFrags.map((w, i) => t`${w} AS ${quoteIdent(windowColumns[i]!.name)}`),
      ],
      ', ',
    );
    lines.length = 0;
    lines.push(t`SELECT ${outer}`, t`FROM (\n${inner}\n) AS "q"`);
  }
  if (order.length) lines.push(f(`ORDER BY ${order.join(', ')}`));
  lines.push(f(`LIMIT ${query.limit + 1}`));
  const sql = cat(lines, '\n');
  return { sql: sql.sql, params: sql.params, columns, limit: query.limit };
}

/** Checks a filter value fits the column, and returns the placeholder that binds it. */
function bind(value: Cell, kind: ColumnKind, params: BindValue[], where: string): string {
  const fail = (expected: string): never => {
    throw new EngineError('invalid_filter', `${where}: expected ${expected}, got ${JSON.stringify(value)}.`);
  };
  switch (kind) {
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('a number');
      params.push(value as number);
      return '?';
    case 'boolean':
      if (typeof value !== 'boolean') fail('true or false');
      params.push(value as boolean);
      return '?';
    case 'date':
    case 'timestamp':
      if (typeof value !== 'string' || !ISO_TEMPORAL.test(value)) fail('an ISO date such as "2026-01-31"');
      params.push(value as string);
      // An explicit cast: a VARCHAR bind compared to a DATE column is not implicitly cast everywhere.
      return `CAST(? AS ${kind === 'date' ? 'DATE' : 'TIMESTAMP'})`;
    case 'string':
      if (typeof value !== 'string') fail('a string');
      params.push(value as string);
      return '?';
    case 'other':
      return fail('no value (only is_null / not_null work on this column)');
  }
}

/** LIKE pattern for contains/starts_with/ends_with: wildcards in the user's text are escaped with "!". */
export function likePattern(op: 'contains' | 'starts_with' | 'ends_with', value: string): string {
  const escaped = value.toLowerCase().replace(/[!%_]/g, (ch) => `!${ch}`);
  return op === 'contains' ? `%${escaped}%` : op === 'starts_with' ? `${escaped}%` : `%${escaped}`;
}

/** A filter (or bucket rule) on a resolved column, as SQL with its binds. */
function predicate(c: Col, op: string, value: Cell | Cell[] | undefined, where: string, field: string): Frag {
  const colSql = c.sql;
  const params: BindValue[] = [];
  const one = () => bind(value as Cell, c.kind, params, where);
  const done = (sql: string) => f(sql, params);
  switch (op) {
    case 'is_null':
      return done(`${colSql} IS NULL`);
    case 'not_null':
      return done(`${colSql} IS NOT NULL`);
    case 'eq':
      return done(`${colSql} = ${one()}`);
    case 'neq':
      return done(`${colSql} <> ${one()}`);
    case 'gt':
      return done(`${colSql} > ${one()}`);
    case 'gte':
      return done(`${colSql} >= ${one()}`);
    case 'lt':
      return done(`${colSql} < ${one()}`);
    case 'lte':
      return done(`${colSql} <= ${one()}`);
    case 'in':
    case 'not_in': {
      // NULLs in the list never match (and would make NOT IN match nothing), so drop them,
      // as the reference engine does.
      const values = (value as Cell[]).filter((v) => v !== null);
      if (!values.length) return done(op === 'in' ? '1 = 0' : `${colSql} IS NOT NULL`);
      const list = values.map((v) => bind(v, c.kind, params, where)).join(', ');
      return done(`${colSql} ${op === 'in' ? 'IN' : 'NOT IN'} (${list})`);
    }
    case 'between': {
      const [lo = null, hi = null] = value as Cell[];
      if (lo === null || hi === null) return done('1 = 0'); // SQL: BETWEEN with a NULL bound is never true
      return done(`${colSql} BETWEEN ${bind(lo, c.kind, params, where)} AND ${bind(hi, c.kind, params, where)}`);
    }
    case 'contains':
    case 'starts_with':
    case 'ends_with': {
      if (c.kind !== 'string') throw new EngineError('invalid_filter', `${where}: "${op}" only works on text columns ("${field}" is not text).`);
      if (typeof value !== 'string') throw new EngineError('invalid_filter', `${where}: expected a string.`);
      params.push(likePattern(op, value));
      return done(`lower(${colSql}) LIKE ? ESCAPE '!'`);
    }
  }
  throw new EngineError('invalid_filter', `${where}: unknown operator "${op}".`);
}
