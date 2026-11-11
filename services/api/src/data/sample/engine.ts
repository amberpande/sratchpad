import { toIsoDate, type DataSource, type Query, type QueryResult, type SourceProfile, type SourceSummary } from '@yourorg/bi-spec';
import { EngineError, type Engine, type ExecuteContext } from '../engine';
import { buildProfile, statsFromRows } from '../profile';
import type { SourceProvider } from '../sources';
import { joinedSources } from '../sql/joins';
import { runInMemoryQuery, type JoinedRows, type Row } from './execute';

export interface SampleDataset {
  fields: ReadonlySet<string>;
  rows: Row[];
}

export type SampleDatasetFactory = (now: Date) => SampleDataset;

/** Serves `{"type": "sample", "ref": "<name>"}` data sources from generated datasets. */
export class SampleEngine implements Engine {
  private readonly cache = new Map<string, { day: string; data: SampleDataset }>();

  constructor(
    private readonly datasets: Record<string, SampleDatasetFactory>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Names of the datasets this engine serves. */
  names(): string[] {
    return Object.keys(this.datasets);
  }

  /** Today's rows for a dataset, or null if there is no such dataset. */
  load(ref: string): SampleDataset | null {
    const factory = Object.hasOwn(this.datasets, ref) ? this.datasets[ref] : undefined;
    if (!factory) return null;
    const now = this.now();
    const day = toIsoDate(now);
    let entry = this.cache.get(ref);
    if (!entry || entry.day !== day) {
      entry = { day, data: factory(now) }; // regenerate daily so "today" stays current
      this.cache.set(ref, entry);
    }
    return entry.data;
  }

  async execute(source: DataSource, query: Query, ctx: ExecuteContext): Promise<QueryResult> {
    ctx.signal.throwIfAborted();
    const data = this.load(source.ref);
    if (!data) {
      throw new EngineError(
        'unknown_source',
        `Sample dataset "${source.ref}" does not exist. Available: ${this.names().join(', ')}.`,
      );
    }
    const joined = new Map() as Map<string, { rows: readonly Row[]; fields: ReadonlySet<string> }>;
    for (const { id, source: js } of joinedSources(query, source)) {
      const other = this.load(js.ref);
      if (!other) throw new EngineError('unknown_source', `Joined sample dataset "${js.ref}" does not exist.`);
      joined.set(id, other);
    }
    return runInMemoryQuery(data.rows, data.fields, query, joined as JoinedRows);
  }
}

/** Sample datasets are visible to every team. Profiles are full scans (the data is small), cached per day. */
export class SampleSources implements SourceProvider {
  readonly type = 'sample';
  private readonly profiles = new Map<string, { rows: readonly unknown[]; profile: SourceProfile }>();

  constructor(
    private readonly engine: SampleEngine,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<SourceSummary[]> {
    return this.engine.names().map((ref) => ({ source: { type: 'sample', ref }, name: ref, rowCount: this.engine.load(ref)?.rows.length }));
  }

  async profile(_teamId: string, ref: string): Promise<SourceProfile | null> {
    const data = this.engine.load(ref);
    if (!data) return null;
    const cached = this.profiles.get(ref);
    if (cached && cached.rows === data.rows) return cached.profile;
    const profile = buildProfile({ type: 'sample', ref }, statsFromRows(data.rows, data.fields), this.now());
    this.profiles.set(ref, { rows: data.rows, profile });
    return profile;
  }
}
