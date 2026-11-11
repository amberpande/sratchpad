import { calcAggs, dimensionAlias, outputColumns, parseCalcExpr, type CalcNode, type OrderBy, type Query } from '@yourorg/bi-spec';
import { EngineError } from './engine';

/**
 * Checks shared by every engine, so an author sees the same error whichever engine serves the
 * source. `validateDashboard` already rejects most of these for stored specs; engines re-check
 * because they are the last line before data is touched.
 *
 * `fields` are every column name the query may use: the source's columns, plus "source.column"
 * names of joined sources (see sql/compile.ts `buildScope`).
 */
export function checkQueryFields(query: Query, fields: Iterable<string>): void {
  const known = fields instanceof Set ? (fields as ReadonlySet<string>) : new Set(fields);
  if (query.metrics?.length) {
    throw new EngineError('metrics_not_expanded', 'This query uses catalog metrics, but no metric catalog is configured on this server.');
  }
  const check = (field: string, where: string) => {
    if (!known.has(field)) {
      throw new EngineError('unknown_field', `Unknown field "${field}" in ${where}. Available fields: ${[...known].join(', ')}.`);
    }
  };
  query.dimensions.forEach((d, i) => {
    check(d.field, `dimensions[${i}]`);
    if ([d.grain, d.bin, d.buckets].filter((x) => x !== undefined).length > 1) {
      throw new EngineError('invalid_dimension', `dimensions[${i}]: use only one of grain, bin or buckets.`);
    }
  });
  query.measures.forEach((m, i) => {
    if (m.field === '*') {
      if (m.agg !== 'count') throw new EngineError('invalid_measure', `measures[${i}]: "*" is only valid with agg "count".`);
      return;
    }
    check(m.field, `measures[${i}]`);
  });
  query.filters.forEach((f, i) => check(f.field, `filters[${i}]`));
  (query.calcs ?? []).forEach((c, i) => {
    for (const a of calcAggs(parsedCalc(c.expr, i))) if (a.field !== '*') check(a.field, `calcs[${i}]`);
  });
  const outputs = outputColumns(query);
  const names = outputs.map((c) => c.name);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new EngineError('duplicate_column', `Output column "${n}" appears twice; give one an "as" alias.`);
    seen.add(n);
  }
  query.orderBy.forEach((o, i) => {
    if (!names.includes(o.field)) {
      throw new EngineError('unknown_field', `orderBy[${i}]: "${o.field}" is not an output column (${names.join(', ')}).`);
    }
  });
  const dims = new Set(query.dimensions.map(dimensionAlias));
  const values = new Set(outputs.filter((c) => c.role === 'measure' && c.derived !== 'window').map((c) => c.name));
  (query.windows ?? []).forEach((w, i) => {
    if (!values.has(w.measure)) throw new EngineError('unknown_field', `windows[${i}]: "${w.measure}" is not a measure or calc of this query.`);
    for (const p of [...(w.partition ?? []), ...(w.order ? [w.order] : [])]) {
      if (!dims.has(p)) throw new EngineError('unknown_field', `windows[${i}]: "${p}" is not a dimension of this query.`);
    }
    if (['running_total', 'moving_average', 'difference', 'percent_change'].includes(w.type)) {
      if (!w.order) throw new EngineError('invalid_window', `windows[${i}]: "${w.type}" needs "order".`);
      const covered = new Set([w.order, ...(w.partition ?? [])]);
      if ([...dims].some((d) => !covered.has(d))) {
        throw new EngineError('invalid_window', `windows[${i}]: every dimension must be the order or a partition of an ordered window.`);
      }
    }
  });
  if (query.topN) {
    if (!dims.has(query.topN.dimension)) throw new EngineError('unknown_field', `topN: "${query.topN.dimension}" is not a dimension of this query.`);
    if (!values.has(query.topN.by)) throw new EngineError('unknown_field', `topN: "${query.topN.by}" is not a measure or calc of this query.`);
  }
}

const calcCache = new Map<string, CalcNode>();

/** A calc expression's AST (cached), or an engine error naming the calc. */
export function parsedCalc(expr: string, index: number): CalcNode {
  let node = calcCache.get(expr);
  if (!node) {
    const parsed = parseCalcExpr(expr);
    if (!parsed.ok) throw new EngineError('invalid_expression', `calcs[${index}]: ${parsed.message}`);
    node = parsed.node;
    if (calcCache.size > 1000) calcCache.clear();
    calcCache.set(expr, node);
  }
  return node;
}

/**
 * The effective sort: the author's orderBy, then every dimension not already named, ascending.
 * The dimension tie-break makes the order total (group keys are unique), so every engine returns
 * the same rows in the same order and LIMIT cuts at the same place. Without it, ties would come
 * back in engine-specific order and `truncated` results could differ between engines.
 */
export function effectiveOrder(query: Query): OrderBy[] {
  const order: OrderBy[] = [...query.orderBy];
  const named = new Set(order.map((o) => o.field));
  for (const d of query.dimensions) {
    const alias = dimensionAlias(d);
    if (!named.has(alias)) {
      order.push({ field: alias, dir: 'asc' });
      named.add(alias);
    }
  }
  return order;
}
