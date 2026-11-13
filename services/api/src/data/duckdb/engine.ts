import type { DataSource, Query, QueryResult } from '@yourorg/bi-spec';
import { EngineError, type Engine, type ExecuteContext } from '../engine';
import type { FileSources } from '../files/service';
import { compileQuery, type JoinedRelation } from '../sql/compile';
import { joinedSources, type ResolvedJoin } from '../sql/joins';
import { compileCustomSql, sqlErrorMessage, toCustomResult, type SqlQuery, type SqlSourceRelation } from '../sql/custom';
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
    if (typeof query.sql === 'string') return this.executeSql(query, ctx);
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

  /**
   * Custom SQL (spec 1.4) over local uploads, in a sandboxed DuckDB that can read only the team's
   * uploads the SQL names. Uploads stored in Snowflake are refused: they are read with the shared
   * uploads role, which can see every team's upload tables, so free SQL there would cross teams.
   */
  private async executeSql(query: SqlQuery, ctx: ExecuteContext): Promise<QueryResult> {
    const sources: SqlSourceRelation[] = [];
    const paths: string[] = [];
    for (const { id, source } of query.sqlSources ?? []) {
      const r = await this.files.find(ctx.teamId, source.ref);
      if (!r) throw new EngineError('unknown_source', `File source "${source.ref}" (source "${id}") was not found.`);
      if (r.storage === 'snowflake') {
        throw new EngineError('custom_sql_unavailable', 'Custom SQL is not available on uploads stored in Snowflake yet. Use the visual query builder, or a Snowflake table.');
      }
      const relation = this.files.relation(r);
      sources.push({ name: id, relation });
      paths.push(...relation.params.filter((p): p is string => typeof p === 'string'));
    }
    const compiled = compileCustomSql(query, { dialect: duckdb, sources });
    let out: Awaited<ReturnType<DuckDBRuntime['sandboxQuery']>>;
    try {
      out = await this.runtime.sandboxQuery(compiled.sql, compiled.params, { allowedPaths: paths, signal: ctx.signal });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      throw new EngineError('sql_error', sqlErrorMessage(error));
    }
    return toCustomResult(compiled, query.columns ?? [], out.rows, out.columns);
  }
}

