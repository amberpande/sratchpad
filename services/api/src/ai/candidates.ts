import type { Aggregation, ColumnProfile, Format, QueryInput, Recommendation, SourceProfile, TimeGrain, Widget } from '@yourorg/bi-spec';

/**
 * Deterministic half of the recommender: classify the profiled fields, then match them to a small
 * library of analytic patterns. Every candidate carries a ready semantic query and widget, so the
 * system produces useful suggestions with no LLM at all. Same profile in, same candidates out.
 */

/** The dataSources key every recommended query points at. */
export const SOURCE_ID = 'src';

export type Pattern =
  | 'total'
  | 'record_count'
  | 'measure_over_time'
  | 'measure_over_time_by_dimension'
  | 'measure_by_dimension'
  | 'part_to_whole'
  | 'measure_vs_measure'
  | 'dimension_matrix'
  | 'breakdown_table';

/** A Recommendation plus what the assembler needs to avoid near-duplicates. */
export interface Candidate extends Recommendation {
  pattern: Pattern;
  /** Candidates sharing a subject answer the same question (e.g. "revenue by region" as bar or pie). */
  subject: string;
  /** Columns the candidate reads; shown to the ranker. */
  fields: string[];
}

export interface ClassifiedFields {
  time: ColumnProfile | undefined;
  grain: TimeGrain | undefined;
  /** Best first. */
  measures: ColumnProfile[];
  /** Low/medium-cardinality categoricals, best chart dimensions first. */
  dimensions: ColumnProfile[];
  /** Non-unique keys with enough distinct values to plot one point each (e.g. customer_id). */
  entities: ColumnProfile[];
}

const MAX_MEASURES = 3;
const MAX_DIMENSIONS = 4;
const SERIES_MAX = 8;
const PIE_MAX = 6;
const BAR_LIMIT = 25;
const SCATTER_LIMIT = 500;
const PERCENT_NAME = /(pct|percent|percentage|rate|ratio|share|score|rating|avg|average|mean)(_|$)/i;
/** Durations, ages and levels: summing them is meaningless ("total resolution hours"), so average. */
const NON_ADDITIVE_NAME = /(^|_)(hours?|hrs?|minutes?|mins?|seconds?|secs?|ms|days|duration|latency|elapsed|age|time|temp|temperature|level|nps|csat)(_|$)/i;
const STATUS_NAME = /(^|_)(status|state|flag|type)$/i;

function measureScore(c: ColumnProfile): number {
  let s = 0;
  if (c.format === 'currency') s += 3;
  if (c.cardinality === 'high' || c.cardinality === 'unique') s += 1;
  if (c.format === 'decimal') s += 0.5;
  s -= c.nullRate;
  return s;
}

function dimensionScore(c: ColumnProfile): number {
  let s = 0;
  // Three to eight values make the most readable bars, pies and series.
  if (c.distinctCount >= 3 && c.distinctCount <= SERIES_MAX) s += 2;
  else if (c.distinctCount >= 2 && c.distinctCount <= 25) s += 1;
  if (c.semanticType === 'geo') s += 0.5;
  // Workflow states ("status") are better as filters than as the headline breakdown.
  if (STATUS_NAME.test(c.name)) s -= 1.5;
  if (c.semanticType === 'boolean') s -= 1;
  s -= c.nullRate;
  return s;
}

function stable<T>(items: T[], score: (t: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}

function toTime(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(t) ? undefined : t;
}

/** A grain that gives a readable number of points (roughly 12–60) over the column's range. */
export function chooseGrain(min: unknown, max: unknown): TimeGrain {
  const from = toTime(min);
  const to = toTime(max);
  if (from === undefined || to === undefined) return 'month';
  const days = (to - from) / 86_400_000;
  if (days <= 45) return 'day';
  if (days <= 200) return 'week';
  if (days <= 1100) return 'month';
  if (days <= 3000) return 'quarter';
  return 'year';
}

export function classify(profile: SourceProfile): ClassifiedFields {
  const byName = new Map(profile.columns.map((c) => [c.name, c]));
  const pick = (names: string[]) => names.map((n) => byName.get(n)).filter((c): c is ColumnProfile => !!c && c.nullRate < 1);

  const times = pick(profile.timeColumns).filter((c) => c.physicalType === 'time');
  const time = stable(times, (c) => -c.nullRate)[0];
  const measures = stable(
    pick(profile.measureCandidates).filter((c) => c.physicalType === 'number'),
    measureScore,
  ).slice(0, MAX_MEASURES);
  const dimensions = stable(
    pick(profile.dimensionCandidates).filter((c) => c.physicalType !== 'time' && c.distinctCount >= 2 && c.cardinality !== 'unique'),
    dimensionScore,
  ).slice(0, MAX_DIMENSIONS);
  const entities = pick(profile.keyCandidates).filter((c) => c.cardinality !== 'unique' && c.distinctCount >= 5);
  return { time, grain: time ? chooseGrain(time.min, time.max) : undefined, measures, dimensions, entities };
}

// ── naming ──────────────────────────────────────────────────────────────────

function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced || name;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'field';
}

/** Spec ids: start with a letter, letters/digits/_/-, max 64. */
function makeId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${parts.map(slug).join('_')}`.slice(0, 64).replace(/_+$/, '');
}

interface MeasurePlan {
  column: ColumnProfile;
  agg: Aggregation;
  alias: string;
  label: string;
  format: Format | undefined;
}

function planMeasure(c: ColumnProfile): MeasurePlan {
  const averaged = c.format === 'percent' || PERCENT_NAME.test(c.name) || NON_ADDITIVE_NAME.test(c.name);
  const agg: Aggregation = averaged ? 'avg' : 'sum';
  const label = averaged ? `Average ${humanize(c.name)}` : `Total ${humanize(c.name)}`;
  let format: Format | undefined;
  if (c.format === 'currency') format = 'currency';
  else if (c.format === 'percent') format = 'percent';
  else if (c.format === 'integer' && agg === 'sum') format = 'integer';
  else format = 'number';
  return { column: c, agg, alias: `${averaged ? 'avg' : 'total'}_${slug(c.name)}`, label, format };
}

const measureInput = (m: MeasurePlan) => ({ field: m.column.name, agg: m.agg, as: m.alias });

// ── patterns ────────────────────────────────────────────────────────────────

export function generateCandidates(profile: SourceProfile, fields: ClassifiedFields = classify(profile)): Candidate[] {
  const out: Candidate[] = [];
  const measures = fields.measures.map(planMeasure);
  const [primary, secondary] = measures;
  const { time, grain, dimensions } = fields;

  const add = (c: Omit<Candidate, 'id'> & { id?: string }, queryKey: string) => {
    const id = c.id ?? makeId('c', queryKey.replace(/^q_/, ''));
    if (out.some((x) => x.id === id)) return;
    out.push({ ...c, id, widget: { ...c.widget, query: queryKey } as Widget } as Candidate);
  };

  // One number per measure: the headline KPIs.
  measures.slice(0, 2).forEach((m, i) => {
    const q = makeId('q', m.alias);
    add(
      {
        title: m.label,
        rationale: `${cap(m.label)} across all ${profile.rowCount.toLocaleString('en-US')} rows: the headline number.`,
        pattern: 'total',
        subject: `total:${m.column.name}`,
        fields: [m.column.name],
        score: i === 0 ? 0.92 : 0.78,
        query: { source: SOURCE_ID, measures: [measureInput(m)] },
        widget: { type: 'kpi', query: q, options: { field: m.alias, reduce: 'first', label: m.label, format: m.format } } as Widget,
      },
      q,
    );
  });

  add(
    {
      title: 'Record count',
      rationale: 'How many rows the source holds; a sanity check next to the totals.',
      pattern: 'record_count',
      subject: 'count',
      fields: [],
      score: measures.length ? 0.55 : 0.8,
      query: { source: SOURCE_ID, measures: [{ field: '*', agg: 'count', as: 'records' }] },
      widget: { type: 'kpi', query: 'q_records', options: { field: 'records', reduce: 'first', label: 'Records', format: 'integer' } } as Widget,
    },
    'q_records',
  );

  // Trend: a measure (or the row count) over the time column.
  if (time && grain) {
    const m = primary;
    const q = makeId('q', m ? m.alias : 'records', 'by', grain);
    const measure = m ? measureInput(m) : { field: '*', agg: 'count' as const, as: 'records' };
    const y = m ? m.alias : 'records';
    const label = m ? m.label : 'Records';
    add(
      {
        title: `${label} by ${grain}`,
        rationale: `${cap(humanize(time.name))} spans the data, so the ${grain}ly trend of ${label.toLowerCase()} comes first.`,
        pattern: 'measure_over_time',
        subject: `trend:${y}`,
        fields: [time.name, ...(m ? [m.column.name] : [])],
        score: 1,
        query: {
          source: SOURCE_ID,
          dimensions: [{ field: time.name, grain }],
          measures: [measure],
          orderBy: [{ field: time.name, dir: 'asc' }],
          limit: 1000,
        },
        widget: {
          type: 'line-chart',
          query: q,
          encoding: { x: time.name, y },
          options: { title: `${label} by ${grain}`, format: { x: grain === 'month' ? 'month' : 'date', y: m?.format ?? 'integer' } },
        } as Widget,
      },
      q,
    );

    // The same trend split by the best small dimension, stacked.
    const series = dimensions.find((d) => d.distinctCount >= 2 && d.distinctCount <= SERIES_MAX);
    if (m && series) {
      const q2 = makeId('q', m.alias, 'by', grain, 'and', series.name);
      add(
        {
          title: `${m.label} by ${grain} and ${humanize(series.name)}`,
          rationale: `Shows which ${humanize(series.name)} drives the trend (${series.distinctCount} values, stacked).`,
          pattern: 'measure_over_time_by_dimension',
          subject: `trend-split:${series.name}`,
          fields: [time.name, series.name, m.column.name],
          score: 0.72,
          query: {
            source: SOURCE_ID,
            dimensions: [{ field: time.name, grain }, { field: series.name }],
            measures: [measureInput(m)],
            orderBy: [{ field: time.name, dir: 'asc' }],
            limit: 5000,
          },
          widget: {
            type: 'area-chart',
            query: q2,
            encoding: { x: time.name, y: m.alias, series: series.name },
            options: { title: `${m.label} by ${humanize(series.name)}`, stacked: m.agg === 'sum', format: { x: grain === 'month' ? 'month' : 'date', y: m.format } },
          } as Widget,
        },
        q2,
      );
    }
  }

  // Comparison: a measure (or row count) across each good dimension.
  dimensions.slice(0, 3).forEach((d, i) => {
    const m = primary;
    const y = m ? m.alias : 'records';
    const label = m ? m.label : 'Records';
    const q = makeId('q', y, 'by', d.name);
    const many = d.distinctCount > BAR_LIMIT;
    add(
      {
        title: `${label} by ${humanize(d.name)}`,
        rationale: many
          ? `Top ${BAR_LIMIT} ${humanize(d.name)} values by ${label.toLowerCase()}.`
          : `Compares ${label.toLowerCase()} across ${d.distinctCount} ${humanize(d.name)} values.`,
        pattern: 'measure_by_dimension',
        subject: `by:${d.name}`,
        fields: [d.name, ...(m ? [m.column.name] : [])],
        // A third bar rarely beats a different chart type; keep it as an alternative.
        score: [0.86, 0.8, 0.48][i]!,
        query: {
          source: SOURCE_ID,
          dimensions: [{ field: d.name }],
          measures: [m ? measureInput(m) : { field: '*', agg: 'count', as: 'records' }],
          orderBy: [{ field: y, dir: 'desc' }],
          limit: BAR_LIMIT,
        },
        widget: {
          type: 'bar-chart',
          query: q,
          encoding: { x: d.name, y },
          options: { title: `${label} by ${humanize(d.name)}`, orientation: d.distinctCount > 6 ? 'horizontal' : 'vertical', format: { y: m?.format ?? 'integer' } },
        } as Widget,
      },
      q,
    );
  });

  // Share: part-to-whole for a small dimension with an additive measure.
  // Prefer a dimension the bars don't already cover (the third bar is a low-ranked alternative).
  const small = dimensions.filter((d) => d.distinctCount >= 2 && d.distinctCount <= PIE_MAX);
  const shareDim = small.find((d) => !dimensions.slice(0, 2).includes(d)) ?? small[0];
  const additive = measures.find((m) => m.agg === 'sum');
  if (shareDim) {
    const y = additive ? additive.alias : 'records';
    const q = makeId('q', 'share', y, 'by', shareDim.name);
    const label = additive ? humanize(additive.column.name) : 'records';
    add(
      {
        title: `Share of ${label} by ${humanize(shareDim.name)}`,
        rationale: `${shareDim.distinctCount} ${humanize(shareDim.name)} values split one whole, so a donut reads at a glance.`,
        pattern: 'part_to_whole',
        subject: `by:${shareDim.name}`,
        fields: [shareDim.name, ...(additive ? [additive.column.name] : [])],
        score: 0.62,
        query: {
          source: SOURCE_ID,
          dimensions: [{ field: shareDim.name }],
          measures: [additive ? measureInput(additive) : { field: '*', agg: 'count', as: 'records' }],
          orderBy: [{ field: y, dir: 'desc' }],
          limit: 100,
        },
        widget: {
          type: 'pie',
          query: q,
          encoding: { category: shareDim.name, value: y },
          options: { title: `Share of ${label} by ${humanize(shareDim.name)}`, format: additive?.format ?? 'integer' },
        } as Widget,
      },
      q,
    );
  }

  // Relationship: two measures per entity (or per dimension value), one point each.
  const pointsBy = fields.entities[0] ?? dimensions.find((d) => d.distinctCount >= 8);
  if (pointsBy && primary) {
    const yMeasure = secondary ?? undefined;
    const xAlias = 'records';
    const q = makeId('q', primary.alias, 'per', pointsBy.name);
    const measuresIn = [{ field: '*', agg: 'count' as const, as: xAlias }, measureInput(primary), ...(yMeasure ? [measureInput(yMeasure)] : [])];
    add(
      {
        title: `${primary.label} vs. records per ${humanize(pointsBy.name)}`,
        rationale: `One point per ${humanize(pointsBy.name)}: do the busiest ones also carry the most ${humanize(primary.column.name)}?`,
        pattern: 'measure_vs_measure',
        subject: `scatter:${pointsBy.name}`,
        fields: [pointsBy.name, primary.column.name],
        score: 0.46,
        query: {
          source: SOURCE_ID,
          dimensions: [{ field: pointsBy.name }],
          measures: measuresIn,
          orderBy: [{ field: primary.alias, dir: 'desc' }],
          limit: SCATTER_LIMIT,
        },
        widget: {
          type: 'scatter',
          query: q,
          encoding: { x: xAlias, y: primary.alias, label: pointsBy.name, ...(yMeasure ? { size: yMeasure.alias } : {}) },
          options: { title: `${primary.label} vs. records per ${humanize(pointsBy.name)}`, format: { x: 'integer', y: primary.format } },
        } as Widget,
      },
      q,
    );
  }

  // Matrix: two small dimensions crossed.
  const [rowsDim, colsDim] = dimensions.filter((d) => d.distinctCount <= 25);
  if (rowsDim && colsDim) {
    const m = primary;
    const y = m ? m.alias : 'records';
    const q = makeId('q', y, 'by', rowsDim.name, 'and', colsDim.name);
    add(
      {
        title: `${m ? m.label : 'Records'} by ${humanize(rowsDim.name)} and ${humanize(colsDim.name)}`,
        rationale: `Crosses ${humanize(rowsDim.name)} with ${humanize(colsDim.name)} to spot strong and weak combinations.`,
        pattern: 'dimension_matrix',
        subject: `matrix:${rowsDim.name}:${colsDim.name}`,
        fields: [rowsDim.name, colsDim.name, ...(m ? [m.column.name] : [])],
        score: 0.5,
        query: {
          source: SOURCE_ID,
          dimensions: [{ field: rowsDim.name }, { field: colsDim.name }],
          measures: [m ? measureInput(m) : { field: '*', agg: 'count', as: 'records' }],
          limit: 1000,
        },
        widget: {
          type: 'pivot',
          query: q,
          encoding: { rows: rowsDim.name, columns: colsDim.name, value: y },
          options: { title: `${m ? m.label : 'Records'} by ${humanize(rowsDim.name)} and ${humanize(colsDim.name)}`, format: m?.format ?? 'integer' },
        } as Widget,
      },
      q,
    );
  }

  // Detail: every measure per value of the top dimension.
  const tableDim = dimensions[0];
  if (tableDim) {
    const q = makeId('q', 'breakdown', tableDim.name);
    const cols = [
      { field: tableDim.name, label: cap(humanize(tableDim.name)) },
      { field: 'records', label: 'Records', format: 'integer' as Format },
      ...measures.map((m) => ({ field: m.alias, label: m.label, ...(m.format ? { format: m.format } : {}) })),
    ];
    add(
      {
        title: `Breakdown by ${humanize(tableDim.name)}`,
        rationale: `Exact figures behind the charts, one row per ${humanize(tableDim.name)}.`,
        pattern: 'breakdown_table',
        subject: `table:${tableDim.name}`,
        fields: [tableDim.name, ...measures.map((m) => m.column.name)],
        score: 0.52,
        query: {
          source: SOURCE_ID,
          dimensions: [{ field: tableDim.name }],
          measures: [{ field: '*', agg: 'count', as: 'records' }, ...measures.map(measureInput)],
          orderBy: [{ field: measures[0]?.alias ?? 'records', dir: 'desc' }],
          limit: 500,
        },
        widget: { type: 'table', query: q, options: { title: `Breakdown by ${humanize(tableDim.name)}`, columns: cols } } as Widget,
      },
      q,
    );
  }

  return stable(out, (c) => c.score);
}

/** Exposed so tests and the assembler can reuse the naming. */
export const naming = { humanize, slug, makeId };
export type { QueryInput };
