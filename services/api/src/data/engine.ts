import type { DataSource, Query, QueryResult } from '@yourorg/bi-spec';

/**
 * An engine executes a semantic query against one kind of data source and returns a small,
 * aggregated result. Phase 1 ships the in-memory sample engine; Phase 2 adds DuckDB (uploaded
 * files) and Snowflake (pushdown) engines behind this same interface.
 */
export interface ExecuteContext {
  teamId: string;
  signal: AbortSignal;
}

export interface Engine {
  execute(source: DataSource, query: Query, ctx: ExecuteContext): Promise<QueryResult>;
}

/** An error safe to show to the dashboard author. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class UnavailableEngine implements Engine {
  constructor(private readonly reason: string) {}

  async execute(): Promise<never> {
    throw new EngineError('engine_unavailable', this.reason);
  }
}

export type EngineRegistry = Partial<Record<string, Engine>>;
