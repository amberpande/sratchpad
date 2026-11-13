import {
  DATE_PART_FUNCTIONS,
  dimensionAlias,
  parseCalcExpr,
  type DatePartFunction,
  evaluateCalc,
  measureAlias,
  outputColumns,
  type Cell,
  type CalcAggregation,
  type CalcNode,
  type Dimension,
  type Filter,
  type Join,
  type OrderBy,
  type Query,
  type QueryResult,
  type ResultColumn,
  type TimeGrain,
  type WindowCalc,
} from '@yourorg/bi-spec';
import { EngineError } from '../engine';
import { splitDetail } from '../sql/compile';
import { checkQueryFields, effectiveOrder, parsedCalc } from '../query-check';

/**
 * Executes a semantic query over in-memory rows with SQL semantics (GROUP BY, NULL handling,
 * ORDER BY, LIMIT). This is the reference implementation of query semantics: the SQL compilers
 * must return exactly what it returns (services/api/test/conformance.test.ts).
 *
 * Spec 1.3: joins, bins, buckets, median/percentiles/stddev, calcs, windows, top-N and the
 * contains/starts_with/ends_with operators are implemented here with the same semantics the SQL
 * compilers emit (see sql/compile.ts for the SQL side of each rule).
 */

export type Row = Record<string, Cell>;

/** Rows of a joined source, keyed by its dataSources id (spec 1.3 `joins`). */
export type JoinedRows = ReadonlyMap<string, { rows: readonly Row[]; fields: ReadonlySet<string> }>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

export function bucketTime(value: Cell, grain: TimeGrain, field: string): Cell {
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new EngineError('invalid_grain', `"${field}" is not a date column, so it cannot have a "${grain}" grain.`);
  }
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7)) - 1;
  const d = Number(value.slice(8, 10));
  switch (grain) {
    case 'day':
      return ymd(y, m, d);
    case 'week': {
      const date = new Date(Date.UTC(y, m, d));
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); // ISO weeks start Monday
      return date.toISOString().slice(0, 10);
    }
    case 'month':
      return ymd(y, m, 1);
    case 'quarter':
      return ymd(y, m - (m % 3), 1);
    case 'year':
      return ymd(y, 0, 1);
  }
}

function compare(a: Cell, b: Cell): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** NULLS LAST comparison in the given direction. */
function compareNullsLast(a: Cell, b: Cell, dir: 'asc' | 'desc' = 'asc'): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const c = compare(a, b);
  return dir === 'desc' ? -c : c;
}

export function matches(value: Cell, filter: Pick<Filter, 'op' | 'value'>): boolean {
  if (filter.op === 'is_null') return value === null;
  if (filter.op === 'not_null') return value !== null;
  if (value === null) return false; // SQL: comparisons with NULL are not true
  const target = filter.value as Cell | Cell[];
  switch (filter.op) {
    case 'eq':
      return value === target;
    case 'neq':
      return value !== target;
    case 'gt':
      return compare(value, target as Cell) > 0;
    case 'gte':
      return compare(value, target as Cell) >= 0;
    case 'lt':
      return compare(value, target as Cell) < 0;
    case 'lte':
      return compare(value, target as Cell) <= 0;
    case 'in':
      return (target as Cell[]).includes(value);
    case 'not_in':
      // NULLs in the list are ignored (the SQL compilers drop them, since `x NOT IN (…, NULL)`
      // is never true in SQL and would silently empty the result).
      return !(target as Cell[]).includes(value);
    case 'between': {
      const [lo = null, hi = null] = target as Cell[];
      // SQL: BETWEEN with a NULL bound is never true.
      if (lo === null || hi === null) return false;
      return compare(value, lo) >= 0 && compare(value, hi) <= 0;
    }
    case 'contains':
    case 'starts_with':
    case 'ends_with': {
      const v = String(value).toLowerCase();
      const needle = String(target).toLowerCase();
      return filter.op === 'contains' ? v.includes(needle) : filter.op === 'starts_with' ? v.startsWith(needle) : v.endsWith(needle);
    }
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

interface Accumulator {
  add(value: Cell): void;
  /** The output value (rounded like the SQL engines' output). */
  result(): Cell;
  /** The unrounded value calcs compute with. */
  raw(): Cell;
}

const PERCENTILES: Record<string, number> = { median: 0.5, p25: 0.25, p75: 0.75, p90: 0.9 };

/** Continuous percentile (linear interpolation), as quantile_cont / PERCENTILE_CONT. */
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function accumulator(agg: CalcAggregation): Accumulator {
  switch (agg) {
    case 'count': {
      let n = 0;
      return { add: (v) => void (v !== null && n++), result: () => n, raw: () => n };
    }
    case 'count_distinct': {
      const seen = new Set<Cell>();
      return { add: (v) => void (v !== null && seen.add(v)), result: () => seen.size, raw: () => seen.size };
    }
    case 'sum': {
      let total = 0;
      let any = false;
      return {
        add: (v) => {
          if (typeof v === 'number') (total += v), (any = true);
        },
        result: () => (any ? round(total) : null),
        raw: () => (any ? total : null),
      };
    }
    case 'avg': {
      let total = 0;
      let n = 0;
      return {
        add: (v) => {
          if (typeof v === 'number') (total += v), n++;
        },
        result: () => (n ? round(total / n) : null),
        raw: () => (n ? total / n : null),
      };
    }
    case 'min':
    case 'max': {
      let best: Cell = null;
      const sign = agg === 'min' ? -1 : 1;
      return {
        add: (v) => {
          if (v !== null && (best === null || sign * compare(v, best) > 0)) best = v;
        },
        result: () => best,
        raw: () => best,
      };
    }
    case 'stddev': {
      const values: number[] = [];
      const compute = () => {
        if (values.length < 2) return null;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
      };
      return {
        add: (v) => void (typeof v === 'number' && values.push(v)),
        result: () => {
          const r = compute();
          return r === null ? null : round(r);
        },
        raw: compute,
      };
    }
    default: {
      const values: number[] = [];
      const p = PERCENTILES[agg]!;
      return {
        add: (v) => void (typeof v === 'number' && values.push(v)),
        result: () => {
          const r = percentile(values, p);
          return r === null ? null : round(r);
        },
        raw: () => percentile(values, p),
      };
    }
  }
}

type Kind = 'number' | 'boolean' | 'date' | 'string' | 'unknown';

function inferKind(sample: Cell | undefined): Kind {
  if (sample === undefined || sample === null) return 'unknown';
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}.*)?$/.test(sample)) return 'date';
  return 'string';
}

function inferType(sample: Cell | undefined): ResultColumn['type'] {
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sample)) return 'time';
  return 'string';
}

const NUMERIC_AGGS = new Set(['sum', 'avg', 'median', 'p25', 'p75', 'p90', 'stddev']);

/** Joins rows like SQL (fan-out, NULL keys never match); joined columns are named "source.column". */
function joinRows(primary: readonly Row[], primaryFields: ReadonlySet<string>, query: Query, joined: JoinedRows | undefined): { rows: Row[]; fields: Set<string> } {
  const joins: Join[] = query.joins ?? [];
  const fields = new Set<string>(primaryFields);
  if (!joins.length) return { rows: primary as Row[], fields };
  for (const f of primaryFields) fields.add(`${query.source}.${f}`);
  let rows: Row[] = primary.map((r) => {
    const out: Row = { ...r };
    for (const f of primaryFields) if (!primaryFields.has(`${query.source}.${f}`)) out[`${query.source}.${f}`] = r[f] ?? null;
    return out;
  });
  joins.forEach((j, k) => {
    const other = joined?.get(j.source);
    if (!other) throw new EngineError('unknown_source', `Joined source "${j.source}" was not found or is not visible to this team.`);
    const kindIn = (rs: readonly Row[], f: string) => inferKind(rs.find((r) => (r[f] ?? null) !== null)?.[f]);
    const keys = j.on.map((o, i) => {
      if (!fields.has(o.left)) throw new EngineError('unknown_field', `joins[${k}].on[${i}]: unknown field "${o.left}" on the left side.`);
      const right = other.fields.has(o.right) ? o.right : o.right.startsWith(`${j.source}.`) && other.fields.has(o.right.slice(j.source.length + 1)) ? o.right.slice(j.source.length + 1) : null;
      if (!right) throw new EngineError('unknown_field', `joins[${k}].on[${i}]: "${o.right}" is not a column of "${j.source}".`);
      const lk = kindIn(rows, o.left);
      const rk = kindIn(other.rows, right);
      if (lk !== 'unknown' && rk !== 'unknown' && lk !== rk) throw new EngineError('invalid_join', `joins[${k}].on[${i}]: "${o.left}" and "${o.right}" have different types.`);
      return { left: o.left, right };
    });
    const index = new Map<string, Row[]>();
    for (const r of other.rows) {
      const vals = keys.map((key) => r[key.right] ?? null);
      if (vals.some((v) => v === null)) continue;
      const id = JSON.stringify(vals);
      const list = index.get(id) ?? [];
      list.push(r);
      index.set(id, list);
    }
    const names = [...other.fields];
    const next: Row[] = [];
    for (const r of rows) {
      const vals = keys.map((key) => r[key.left] ?? null);
      const found = vals.some((v) => v === null) ? [] : (index.get(JSON.stringify(vals)) ?? []);
      if (!found.length && j.type === 'inner') continue;
      for (const m of found.length ? found : [null]) {
        const out: Row = { ...r };
        for (const n of names) out[`${j.source}.${n}`] = m ? (m[n] ?? null) : null;
        next.push(out);
      }
    }
    rows = next;
    for (const n of names) fields.add(`${j.source}.${n}`);
  });
  return { rows, fields };
}

export function runInMemoryQuery(sourceRows: readonly Row[], sourceFields: ReadonlySet<string>, query: Query, joined?: JoinedRows): QueryResult {
  if (query.detail) {
    // Level of detail (1.4): the same two passes as the SQL compiler (sql/compile.ts splitDetail).
    const { inner, outer } = splitDetail(query);
    const innerResult = runInMemoryQuery(sourceRows, sourceFields, { ...inner, limit: Number.MAX_SAFE_INTEGER }, joined);
    const result = runInMemoryQuery(innerResult.rows, new Set(innerResult.columns.map((c) => c.name)), outer);
    const innerCols = new Map(innerResult.columns.map((c) => [c.name, c]));
    result.columns = result.columns.map((c, i) => (i < query.dimensions.length && innerCols.has(c.name) ? { ...innerCols.get(c.name)!, name: c.name } : c));
    return result;
  }
  if (query.metrics?.length) checkQueryFields(query, sourceFields); // throws metrics_not_expanded
  const joinedOut = joinRows(sourceRows, sourceFields, query, joined);
  const { rows, fields } = addRowFields(joinedOut.rows, joinedOut.fields, query);
  checkQueryFields(query, fields);

  // Column kinds, inferred from the data like a SQL engine's declared types.
  const kinds = new Map<string, Kind>();
  const kindOf = (field: string): Kind => {
    let k = kinds.get(field);
    if (!k) {
      k = inferKind(rows.find((r) => (r[field] ?? null) !== null)?.[field]);
      kinds.set(field, k);
    }
    return k;
  };
  const known = (k: Kind, ...allowed: Kind[]) => k === 'unknown' || allowed.includes(k);

  query.filters.forEach((f, i) => {
    if ((f.op === 'contains' || f.op === 'starts_with' || f.op === 'ends_with') && !known(kindOf(f.field), 'string')) {
      throw new EngineError('invalid_filter', `filters[${i}] on "${f.field}": "${f.op}" only works on text columns ("${f.field}" is not text).`);
    }
  });
  query.measures.forEach((m, i) => {
    if (m.field !== '*' && NUMERIC_AGGS.has(m.agg) && !known(kindOf(m.field), 'number')) {
      throw new EngineError('invalid_measure', `measures[${i}]: "${m.field}": the column is not numeric, so it cannot be aggregated with "${m.agg}".`);
    }
  });

  // Dimension values.
  const dimValue = (d: Dimension, i: number, row: Row): Cell => {
    const value = row[d.field] ?? null;
    if (d.grain) return bucketTime(value, d.grain, d.field);
    if (d.bin) {
      if (!known(kindOf(d.field), 'number')) throw new EngineError('invalid_dimension', `dimensions[${i}]: "${d.field}" is not numeric, so it cannot be binned.`);
      if (value === null) return null;
      const off = d.bin.offset ?? 0;
      return round(Math.floor(((value as number) - off) / d.bin.width) * d.bin.width + off);
    }
    if (d.buckets) {
      for (const rule of d.buckets.rules) {
        if (matches(value, rule)) return rule.label;
      }
      return d.buckets.else ?? null;
    }
    return value;
  };
  query.dimensions.forEach((d, i) => {
    if (d.buckets) {
      d.buckets.rules.forEach((r, j) => {
        if ((r.op === 'contains' || r.op === 'starts_with' || r.op === 'ends_with') && !known(kindOf(d.field), 'string')) {
          throw new EngineError('invalid_filter', `dimensions[${i}].buckets.rules[${j}]: "${r.op}" only works on text columns ("${d.field}" is not text).`);
        }
      });
    }
  });

  // Calcs: parsed ASTs and the aggregate calls they need per group.
  const calcs = (query.calcs ?? []).map((c, i) => ({ as: c.as, node: parsedCalc(c.expr, i), index: i }));
  const aggCalls = new Map<string, { agg: CalcAggregation; field: string }>();
  const collect = (node: CalcNode, where: string) => {
    if (node.kind === 'agg') {
      if (node.field !== '*') {
        const k = kindOf(node.field);
        if (NUMERIC_AGGS.has(node.agg) && !known(k, 'number')) throw new EngineError('invalid_measure', `${where}: ${node.agg}(${node.field}): the column is not numeric, so it cannot be aggregated with "${node.agg}".`);
        if ((node.agg === 'min' || node.agg === 'max') && !known(k, 'number')) throw new EngineError('invalid_calc', `${where}: ${node.agg}(${node.field}) is not numeric.`);
      }
      aggCalls.set(`${node.agg}|${node.field}`, { agg: node.agg, field: node.field });
    } else if (node.kind === 'neg') collect(node.arg, where);
    else if (node.kind === 'bin') {
      collect(node.left, where);
      collect(node.right, where);
    } else if (node.kind === 'fn') node.args.forEach((a) => collect(a, where));
  };
  const measureByAlias = new Map(query.measures.map((m) => [measureAlias(m), m]));
  const calcNames = new Set<string>();
  for (const c of calcs) {
    const where = `calcs[${c.index}] "${c.as}"`;
    collect(c.node, where);
    // Refs: measures must be numeric; calcs must be earlier.
    const check = (node: CalcNode) => {
      if (node.kind === 'ref') {
        const m = measureByAlias.get(node.name);
        if (m) {
          const numeric = m.field === '*' || m.agg === 'count' || m.agg === 'count_distinct' || NUMERIC_AGGS.has(m.agg) || kindOf(m.field) === 'number' || kindOf(m.field) === 'unknown';
          if (!numeric) throw new EngineError('invalid_calc', `${where}: "${node.name}" is not numeric.`);
        } else if (!calcNames.has(node.name)) {
          throw new EngineError('unknown_field', `${where}: "${node.name}" is not a measure or earlier calc of this query.`);
        }
      } else if (node.kind === 'neg') check(node.arg);
      else if (node.kind === 'bin') {
        check(node.left);
        check(node.right);
      } else if (node.kind === 'fn') node.args.forEach(check);
    };
    check(c.node);
    calcNames.add(c.as);
  }

  const filtered = rows.filter((row) => query.filters.every((f) => matches(row[f.field] ?? null, f)));

  interface Group {
    key: Cell[];
    accs: Accumulator[];
    calcAccs: Map<string, Accumulator>;
  }
  const newGroup = (key: Cell[]): Group => ({
    key,
    accs: query.measures.map((m) => accumulator(m.agg)),
    calcAccs: new Map([...aggCalls].map(([k, a]) => [k, accumulator(a.agg)])),
  });
  const feed = (group: Group, row: Row) => {
    query.measures.forEach((m, i) => group.accs[i]!.add(m.field === '*' ? 1 : (row[m.field] ?? null)));
    for (const [k, a] of aggCalls) group.calcAccs.get(k)!.add(a.field === '*' ? 1 : (row[a.field] ?? null));
  };
  /** Measure and calc values of a group: output (rounded) and raw (for calcs). */
  const evaluate = (group: Group): { out: Row; raw: Map<string, Cell> } => {
    const out: Row = {};
    const raw = new Map<string, Cell>();
    query.measures.forEach((m, i) => {
      out[measureAlias(m)] = group.accs[i]!.result();
      raw.set(measureAlias(m), group.accs[i]!.raw());
    });
    for (const c of calcs) {
      const v = evaluateCalc(c.node, {
        ref: (name) => {
          const r = raw.get(name) ?? null;
          return typeof r === 'number' ? r : null;
        },
        agg: (agg, field) => {
          const r = group.calcAccs.get(`${agg}|${field}`)!.raw();
          return typeof r === 'number' ? r : null;
        },
      });
      raw.set(c.as, v);
      out[c.as] = v === null || !Number.isFinite(v) ? null : round(v);
    }
    return { out, raw };
  };

  // Top-N: rank the dimension's values by `by` over the filtered rows, keep the first N.
  let topIndex = -1;
  let topSet: Set<Cell> | null = null;
  let otherLabel: string | null = 'Other';
  if (query.topN) {
    topIndex = query.dimensions.findIndex((d) => dimensionAlias(d) === query.topN!.dimension);
    const d = query.dimensions[topIndex]!;
    const isText = d.buckets !== undefined || (!d.grain && !d.bin && known(kindOf(d.field), 'string'));
    if (!isText) throw new EngineError('invalid_top_n', `topN: "${query.topN.dimension}" must be a text dimension (a text column or buckets).`);
    const pre = new Map<string, Group>();
    for (const row of filtered) {
      const v = dimValue(d, topIndex, row);
      const k = JSON.stringify(v);
      let g = pre.get(k);
      if (!g) pre.set(k, (g = newGroup([v])));
      feed(g, row);
    }
    const ranked = [...pre.values()]
      .map((g) => ({ value: g.key[0]!, by: evaluate(g).out[query.topN!.by] ?? null }))
      .sort((a, b) => compareNullsLast(a.by, b.by, 'desc') || compareNullsLast(a.value, b.value, 'asc'));
    topSet = new Set(ranked.slice(0, query.topN.n).map((r) => r.value).filter((v) => v !== null));
    otherLabel = query.topN.otherLabel === undefined ? 'Other' : query.topN.otherLabel;
  }

  const groups = new Map<string, Group>();
  for (const row of filtered) {
    const key = query.dimensions.map((d, i) => {
      const v = dimValue(d, i, row);
      if (i !== topIndex) return v;
      return v !== null && topSet!.has(v) ? v : otherLabel === null ? undefined : otherLabel;
    });
    if (key.includes(undefined as never)) continue; // top-N without "Other": the rest is dropped
    const groupKey = JSON.stringify(key);
    let group = groups.get(groupKey);
    if (!group) groups.set(groupKey, (group = newGroup(key as Cell[])));
    feed(group, row);
  }
  // Like SQL, an aggregate with no GROUP BY returns one row even when nothing matched.
  if (query.dimensions.length === 0 && groups.size === 0) groups.set('[]', newGroup([]));

  let out: Row[] = [...groups.values()].map((group) => {
    const row: Row = {};
    query.dimensions.forEach((d, i) => (row[dimensionAlias(d)] = group.key[i] ?? null));
    Object.assign(row, evaluate(group).out);
    return row;
  });

  // Windows over the grouped rows (before ORDER BY / LIMIT, like SQL).
  (query.windows ?? []).forEach((w, i) => applyWindow(out, w, i, query));

  // The author's order, then the dimensions as a tie-break (see effectiveOrder).
  const order: OrderBy[] = effectiveOrder(query);
  // NULLS LAST in both directions (engines disagree on the default, so the SQL compilers emit
  // it explicitly to match).
  out.sort((a, b) => {
    for (const o of order) {
      const c = compareNullsLast(a[o.field] ?? null, b[o.field] ?? null, o.dir);
      if (c) return c;
    }
    return 0;
  });

  const truncated = out.length > query.limit;
  if (truncated) out = out.slice(0, query.limit);

  const columns: ResultColumn[] = outputColumns(query).map((col) => {
    if (col.grain) return { name: col.name, type: 'time', grain: col.grain };
    if (col.derived === 'bin') return { name: col.name, type: 'number' };
    if (col.derived === 'buckets') return { name: col.name, type: 'string' };
    if (col.role === 'dimension' && col.name === query.topN?.dimension) return { name: col.name, type: 'string' };
    if (col.role === 'measure' && col.agg !== 'min' && col.agg !== 'max') return { name: col.name, type: 'number' };
    // Typed by the source column (like a SQL engine's declared type), not by the output values,
    // so a column whose result happens to be all NULL keeps its type.
    return { name: col.name, type: inferType(rows.find((r) => (r[col.field] ?? null) !== null)?.[col.field]) };
  });

  return { columns, rows: out, truncated };
}

/** Window calcs with SQL window-function semantics, over rounded output values; result rounded. */
function applyWindow(rows: Row[], w: WindowCalc, i: number, query: Query) {
  const valueOf = (r: Row): number | null => {
    const v = r[w.measure] ?? null;
    if (v !== null && typeof v !== 'number') throw new EngineError('invalid_window', `windows[${i}]: "${w.measure}" is not numeric.`);
    return v;
  };
  const partitions = new Map<string, Row[]>();
  for (const r of rows) {
    const key = JSON.stringify((w.partition ?? []).map((p) => r[p] ?? null));
    const list = partitions.get(key) ?? [];
    list.push(r);
    partitions.set(key, list);
  }
  const fin = (v: number | null) => (v === null || !Number.isFinite(v) ? null : round(v));
  for (const part of partitions.values()) {
    if (w.order) part.sort((a, b) => compareNullsLast(a[w.order!] ?? null, b[w.order!] ?? null, 'asc'));
    const vals = part.map(valueOf);
    switch (w.type) {
      case 'running_total': {
        let total = 0;
        let any = false;
        part.forEach((r, k) => {
          const v = vals[k]!;
          if (v !== null) (total += v), (any = true);
          r[w.as] = any ? fin(total) : null;
        });
        break;
      }
      case 'moving_average': {
        const n = w.window ?? 3;
        part.forEach((r, k) => {
          const frame = vals.slice(Math.max(0, k - n + 1), k + 1).filter((v): v is number => v !== null);
          r[w.as] = frame.length ? fin(frame.reduce((a, b) => a + b, 0) / frame.length) : null;
        });
        break;
      }
      case 'difference':
      case 'percent_change': {
        const off = w.offset ?? 1;
        // Calendar windows (1.4): the row `off` periods earlier by date, not by position.
        const grain = w.calendar ? query.dimensions.find((d) => (d.as ?? d.field) === w.order)?.grain : undefined;
        const byDate = grain ? new Map(part.map((r, k) => [String(r[w.order!]), k])) : null;
        part.forEach((r, k) => {
          const v = vals[k]!;
          let p: number | null;
          if (byDate && grain) {
            const at = byDate.get(shiftIsoDate(String(r[w.order!]), grain, -off));
            p = at === undefined ? null : vals[at]!;
          } else p = k - off >= 0 ? vals[k - off]! : null;
          if (v === null || p === null) r[w.as] = null;
          else if (w.type === 'difference') r[w.as] = fin(v - p);
          else r[w.as] = p === 0 ? null : fin((v - p) / Math.abs(p));
        });
        break;
      }
      case 'percent_of_total': {
        const present = vals.filter((v): v is number => v !== null);
        const total = present.length ? present.reduce((a, b) => a + b, 0) : null;
        part.forEach((r, k) => {
          const v = vals[k]!;
          r[w.as] = v === null || total === null || total === 0 ? null : fin(v / total);
        });
        break;
      }
      case 'rank': {
        const dir = w.dir === 'asc' ? 'asc' : 'desc';
        const distinct = [...new Set(vals.map((v) => JSON.stringify(v)))].map((s) => JSON.parse(s) as number | null).sort((a, b) => compareNullsLast(a, b, dir));
        part.forEach((r, k) => {
          const v = vals[k]!;
          r[w.as] = w.dense
            ? distinct.findIndex((d) => d === v) + 1
            : 1 + vals.filter((o) => compareNullsLast(o, v, dir) < 0).length;
        });
        break;
      }
    }
  }
}

/** 'YYYY-MM-DD' moved by n periods of a grain (calendar windows). */
export function shiftIsoDate(iso: string, grain: TimeGrain, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (grain === 'day') d.setUTCDate(d.getUTCDate() + n);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  else if (grain === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

/** Row-level fields (1.4, D-083): evaluated per row before filters and grouping, like the SQL engines. */
function addRowFields(rows: Row[], fields: Set<string>, query: Query): { rows: Row[]; fields: Set<string> } {
  const defs = query.fields ?? [];
  if (!defs.length) return { rows, fields };
  const known = new Set(fields);
  const kind = new Map<string, Kind>();
  const kindOf = (name: string) => {
    if (!kind.has(name)) kind.set(name, inferKind(rows.find((r) => (r[name] ?? null) !== null)?.[name]));
    return kind.get(name)!;
  };
  const compiled = defs.map((fd, i) => {
    const parsed = parseCalcExpr(fd.expr, { rowLevel: true });
    if (!parsed.ok) throw new EngineError('invalid_expression', `fields[${i}] "${fd.as}": ${parsed.message}`);
    const where = `fields[${i}] "${fd.as}"`;
    const check = (n: CalcNode, dateArg = false): void => {
      if (n.kind === 'ref') {
        if (!known.has(n.name)) throw new EngineError('unknown_field', `${where}: unknown column "${n.name}".`);
        const k = kindOf(n.name);
        if (dateArg ? k !== 'date' && k !== 'unknown' : k !== 'number' && k !== 'unknown') {
          throw new EngineError('invalid_expression', dateArg ? `${where}: date part needs a date column ("${n.name}" is not one).` : `${where}: "${n.name}" is not numeric (use year(), month(), … for dates).`);
        }
      } else if (n.kind === 'neg') check(n.arg);
      else if (n.kind === 'bin') (check(n.left), check(n.right));
      else if (n.kind === 'fn') n.args.forEach((a) => check(a, (DATE_PART_FUNCTIONS as readonly string[]).includes(n.fn)));
    };
    check(parsed.node);
    known.add(fd.as);
    kind.set(fd.as, 'number');
    return { as: fd.as, node: parsed.node };
  });
  const out = rows.map((r) => {
    const row: Row = { ...r };
    for (const c of compiled) {
      const v = evaluateCalc(c.node, {
        ref: (name) => (typeof row[name] === 'number' ? (row[name] as number) : null),
        agg: () => null,
        datePart: (part, column) => datePartOf(row[column] ?? null, part),
      });
      row[c.as] = v === null || !Number.isFinite(v) ? null : v;
    }
    return row;
  });
  return { rows: out, fields: new Set([...fields, ...compiled.map((c) => c.as)]) };
}

function datePartOf(value: Cell, part: DatePartFunction): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  switch (part) {
    case 'year':
      return d.getUTCFullYear();
    case 'quarter':
      return Math.floor(d.getUTCMonth() / 3) + 1;
    case 'month':
      return d.getUTCMonth() + 1;
    case 'day':
      return d.getUTCDate();
    case 'weekday':
      return ((d.getUTCDay() + 6) % 7) + 1;
  }
}
