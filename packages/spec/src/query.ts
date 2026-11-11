import type { Aggregation, Dimension, Measure, Query, TimeGrain } from './schema';
import type { Calc, MetricRef, WindowCalc, WindowType } from './query-ext';

/** A column in a query's result set. */
export interface OutputColumn {
  name: string;
  role: 'dimension' | 'measure';
  /** Source column the output comes from ("" for calcs, windows and catalog metrics). */
  field: string;
  grain?: TimeGrain;
  agg?: Aggregation;
  /** Since 1.3: how the column is computed when it is not a plain dimension or measure. */
  derived?: 'bin' | 'buckets' | 'calc' | 'window' | 'metric';
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
};

/**
 * The result columns a semantic query produces, in order: dimensions, measures, catalog metrics,
 * calcs, windows. (After the server expands catalog metrics they become measures or calcs; the
 * names are unchanged.)
 */
export function outputColumns(query: OutputQuery): OutputColumn[] {
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
