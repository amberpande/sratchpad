import type { DataSource, Query, QueryResult } from '@yourorg/bi-spec';
import { EngineError, type Engine, type ExecuteContext } from '../engine';
import type { FileSources } from '../files/service';
import { compileQuery, type JoinedRelation } from '../sql/compile';
import { joinedSources, type ResolvedJoin } from '../sql/joins';
import { duckdb } from '../sql/dialect';
import { toQueryResult } from '../sql/result';
import type { DuckDBRuntime } from './runtime';

/**
 * Serves `{"type": "file", "ref": "file_…"}` sources: compiled SQL over the upload's local Parquet
 * copy, or, for uploads stored in Snowflake, pushed down to their Iceberg table.
 */
export class DuckDBFileEngine implements Engine {
  constructor(
    private readonly files: FileSources,
    private readonly runtime: DuckDBRuntime,
    /** Runs queries on uploads stored as Snowflake Iceberg tables (uploads role, not the team's). */
    private readonly snowflakeUploads?: Engine,
  ) {}

  async execute(source: DataSource, query: Query, ctx: ExecuteContext): Promise<QueryResult> {
    // Team-scoped: another team's ref reads exactly like a missing one. This lookup is the access
    // check for Snowflake-stored uploads too: the table name never comes from the client.
    const record = await this.files.find(ctx.teamId, source.ref);
    if (!record) throw new EngineError('unknown_source', `File source "${source.ref}" was not found.`);
    // Joined uploads: the same team-scoped lookup for each one.
    const others = await Promise.all(
      joinedSources(query, source).map(async ({ id, source: js }) => {
        const r = await this.files.find(ctx.teamId, js.ref);
        if (!r) throw new EngineError('unknown_source', `Joined file source "${js.ref}" was not found.`);
        return { id, record: r };
      }),
    );
    if (record.storage === 'snowflake') {
      if (!this.snowflakeUploads || !record.table) throw new EngineError('engine_unavailable', 'This upload is stored in Snowflake, which is not configured on this server.');
      if (others.some((o) => o.record.storage !== 'snowflake' || !o.record.table)) {
        throw new EngineError('invalid_join', 'Uploads stored in Snowflake can only be joined with other uploads stored in Snowflake.');
      }
      // Re-point joins at the uploads' Iceberg tables (team access was checked above).
      const rewritten: Query = {
        ...query,
        joins: (query.joins ?? []).map((j) => {
          const o = others.find((x) => x.id === j.source)!;
          return { ...j, resolved: { type: 'snowflake', ref: o.record.table! } } as ResolvedJoin;
        }),
      };
      return this.snowflakeUploads.execute({ type: 'snowflake', ref: record.table }, rewritten, ctx);
    }
    if (others.some((o) => o.record.storage === 'snowflake')) throw new EngineError('invalid_join', 'A local upload cannot be joined with an upload stored in Snowflake.');
    const columns = await this.files.columns(record, ctx.signal);
    const joined = new Map<string, JoinedRelation>();
    for (const o of others) joined.set(o.id, { relation: this.files.relation(o.record), columns: await this.files.columns(o.record, ctx.signal) });
    const compiled = compileQuery(query, { dialect: duckdb, relation: this.files.relation(record), columns, joined });
    const rows = await this.runtime.query(compiled.sql, compiled.params, ctx.signal);
    return toQueryResult(compiled, rows);
  }
}
