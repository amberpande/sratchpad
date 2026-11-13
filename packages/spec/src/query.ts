import type { Aggregation, Dimension, Measure, Query, TimeGrain } from './schema';
import type { Calc, MetricRef, SqlColumn, WindowCalc, WindowType } from './query-ext';

/** A column in a query's result set. */
export interface OutputColumn {
  name: string;
  role: 'dimension' | 'measure';
  /** Source column the output comes from ("" for calcs, windows and catalog metrics). */
  field: string;
  grain?: TimeGrain;
  agg?: Aggregation;
  /** Since 1.3: how the column is computed when it is not a plain dimension or measure. */
  derived?: 'bin' | 'buckets' | 'calc' | 'window' | 'metric' | 'sql';
  /** For windows: the window type. */
  window?: WindowType;
  /** For catalog metrics: the metric name. */
  metric?: string;
}

export function dimensionAlias(d: Dimension): string {
  return d.as ?? d.field;
}

export function measureAlias(m: Measure): string {
  if (m.as) return m.as;
  return m.field === '*' ? m.agg : `${m.agg}_${m.field}`;
}

type OutputQuery = Pick<Query, 'dimensions' | 'measures'> & {
  calcs?: Calc[];
  windows?: WindowCalc[];
  metrics?: MetricRef[];
  sql?: string;
  columns?: SqlColumn[];
};

/**
 * The result columns a semantic query produces, in order: dimensions, measures, catalog metrics,
 * calcs, windows; for a custom SQL query, its declared columns. (After the server expands catalog metrics they become measures or calcs; the
 * names are unchanged.)
 */
export function outputColumns(query: OutputQuery): OutputColumn[] {
  // Spec 1.4 custom SQL: the author-declared result columns.
  if (typeof query.sql === 'string') return (query.columns ?? []).map((c) => ({ name: c.name, role: c.role, field: c.name, derived: 'sql' as const, ...(c.grain ? { grain: c.grain } : {}) }));
  return [
    ...query.dimensions.map<OutputColumn>((d) => ({
      name: dimensionAlias(d),
      role: 'dimension',
      field: d.field,
      ...(d.grain ? { grain: d.grain } : {}),
      ...(d.bin ? { derived: 'bin' as const } : d.buckets ? { derived: 'buckets' as const } : {}),
    })),
    ...query.measures.map<OutputColumn>((m) => ({ name: measureAlias(m), role: 'measure', field: m.field, agg: m.agg })),
    ...(query.metrics ?? []).map<OutputColumn>((m) => ({ name: m.as ?? m.metric, role: 'measure', field: '', derived: 'metric', metric: m.metric })),
    ...(query.calcs ?? []).map<OutputColumn>((c) => ({ name: c.as, role: 'measure', field: '', derived: 'calc' })),
    ...(query.windows ?? []).map<OutputColumn>((w) => ({ name: w.as, role: 'measure', field: '', derived: 'window', window: w.type })),
  ];
}

/**
 * Replaces set references (1.4, D-086) with plain query features every engine already runs: a set
 * dimension becomes buckets (members → the set's label, others → "Other"), a set filter becomes an
 * in / not_in list. Done on the server before execution; unknown sets are left for validation.
 */
export function expandSets<Q extends Pick<Query, 'dimensions' | 'filters'>>(query: Q, sets: Record<string, { field: string; values: Array<string | number | boolean | null>; label?: string; otherLabel?: string }> | undefined): Q {
  if (!sets) return query;
  const usesSet = query.dimensions.some((d) => d.set) || query.filters.some((f) => f.set);
  if (!usesSet) return query;
  return {
    ...query,
    dimensions: query.dimensions.map((d) => {
      const s = d.set ? sets[d.set] : undefined;
      if (!s) return d;
      const { set: _s, ...rest } = d;
      return { ...rest, as: d.as ?? d.field, buckets: { rules: [{ op: 'in' as const, value: s.values, label: s.label ?? d.set! }], else: s.otherLabel ?? 'Other' } };
    }),
    filters: query.filters.map((f) => {
      const s = f.set ? sets[f.set] : undefined;
      if (!s) return f;
      const { set: _s, ...rest } = f;
      return { ...rest, value: s.values };
    }),
  };
}
