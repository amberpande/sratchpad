import {
  AGGREGATIONS,
  CALC_AGGREGATIONS,
  calcRefs,
  FORMATS,
  formatCalcExpr,
  METRIC_NAME,
  metricAlias,
  parseCalcExpr,
  substituteRefs,
  type Aggregation,
  type CalcNode,
  type Format,
  type Issue,
  type Measure,
  type Query,
} from '@yourorg/bi-spec';
import { EngineError } from './engine';

/**
 * A team-wide metric catalog: named, governed measures ("revenue" defined once) that queries
 * reference as `metrics: [{ metric: "revenue" }]` instead of repeating the definition. Expanded on
 * the server (data/run.ts) before compiling, so engines only ever see plain measures and calcs.
 * Format and expansion: workstream A. Storage and routes: workstream D (platform/service.ts).
 */
export interface MetricDefinition {
  /** Name queries use: lower-case letters, digits and "_" (e.g. "revenue"). */
  name: string;
  label?: string;
  description?: string;
  /** Suggested display format for widgets. */
  format?: Format;
  /** A simple metric: an aggregation of one column ("*" with count counts rows). */
  field?: string;
  agg?: Aggregation;
  /**
   * A derived metric: a calc expression over other metrics (bare names) and aggregate calls,
   * e.g. "revenue - cost" or "sum(profit) / nullif(sum(amount), 0)".
   */
  expr?: string;
  [key: string]: unknown;
}

export interface MetricCatalog {
  /** The team's metrics (empty when it has none). */
  get(teamId: string): Promise<MetricDefinition[]>;
}

const KNOWN_KEYS = new Set(['name', 'label', 'description', 'format', 'field', 'agg', 'expr']);

/** Checks one catalog entry. Cross-metric references are checked at expansion (the catalog may be edited in any order). */
export function validateMetricDefinition(def: unknown): { ok: true; metric: MetricDefinition } | { ok: false; errors: Issue[] } {
  const errors: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, code: 'invalid_metric', message });
  if (typeof def !== 'object' || def === null || Array.isArray(def)) return { ok: false, errors: [{ path: '', code: 'invalid_metric', message: 'A metric must be an object.' }] };
  const d = def as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!KNOWN_KEYS.has(k)) err(k, `Unknown key "${k}".`);
  if (typeof d.name !== 'string' || !METRIC_NAME.test(d.name)) err('name', 'name must be lower-case letters, digits and "_", starting with a letter (max 64).');
  if (d.label !== undefined && (typeof d.label !== 'string' || d.label.length > 200)) err('label', 'label must be text of at most 200 characters.');
  if (d.description !== undefined && (typeof d.description !== 'string' || d.description.length > 2000)) err('description', 'description must be at most 2000 characters.');
  if (d.format !== undefined && !(FORMATS as readonly unknown[]).includes(d.format)) err('format', `format must be one of ${FORMATS.join(', ')}.`);
  const simple = d.field !== undefined || d.agg !== undefined;
  if (simple && d.expr !== undefined) err('expr', 'Give either field + agg or expr, not both.');
  else if (simple) {
    if (typeof d.field !== 'string' || !d.field || d.field.length > 128) err('field', 'field must be a column name (or "*" with count).');
    if (!(AGGREGATIONS as readonly unknown[]).includes(d.agg)) err('agg', `agg must be one of ${AGGREGATIONS.join(', ')}.`);
    if (d.field === '*' && d.agg !== 'count') err('field', '"*" only works with agg "count".');
  } else if (d.expr !== undefined) {
    if (typeof d.expr !== 'string') err('expr', 'expr must be text.');
    else {
      const parsed = parseCalcExpr(d.expr);
      if (!parsed.ok) err('expr', parsed.message);
      else if (typeof d.name === 'string' && calcRefs(parsed.node).includes(d.name)) err('expr', 'A metric cannot refer to itself.');
    }
  } else err('', 'Give field + agg, or expr.');
  return errors.length ? { ok: false, errors } : { ok: true, metric: d as MetricDefinition };
}

const MAX_DEPTH = 8;

/** A metric as an expression AST (simple metrics become an aggregate call). */
function metricNode(name: string, byName: Map<string, MetricDefinition>, stack: string[]): CalcNode {
  const def = byName.get(name);
  if (!def) throw new EngineError('unknown_metric', `Metric "${name}" is not in this team's catalog.`);
  if (stack.includes(name)) throw new EngineError('invalid_metric', `Metrics refer to each other in a cycle: ${[...stack, name].join(' → ')}.`);
  if (stack.length >= MAX_DEPTH) throw new EngineError('invalid_metric', `Metric "${name}" is nested too deeply.`);
  if (def.expr === undefined) {
    if (!def.field || !def.agg || !(CALC_AGGREGATIONS as readonly string[]).includes(def.agg)) throw new EngineError('invalid_metric', `Metric "${name}" has no valid definition.`);
    return { kind: 'agg', agg: def.agg, field: def.field };
  }
  const parsed = parseCalcExpr(def.expr);
  if (!parsed.ok) throw new EngineError('invalid_metric', `Metric "${name}": ${parsed.message}`);
  return substituteRefs(parsed.node, (ref) => metricNode(ref, byName, [...stack, name]));
}

/**
 * Replaces `metrics` references with their definitions: simple metrics become measures, derived
 * metrics become calcs (placed before the query's own calcs, which may refer to them).
 * Unknown metrics fail with `unknown_metric`.
 */
export function expandMetrics(query: Query, metrics: MetricDefinition[]): Query {
  if (!query.metrics?.length) return query;
  const byName = new Map(metrics.map((m) => [m.name, m]));
  const measures: Measure[] = [...query.measures];
  const calcs: Array<{ as: string; expr: string }> = [];
  for (const ref of query.metrics) {
    const node = metricNode(ref.metric, byName, []);
    const as = metricAlias(ref);
    if (node.kind === 'agg') measures.push({ field: node.field, agg: node.agg, as });
    else calcs.push({ as, expr: formatCalcExpr(node) });
  }
  const { metrics: _expanded, ...rest } = query;
  return { ...rest, measures, calcs: [...calcs, ...(query.calcs ?? [])] };
}
