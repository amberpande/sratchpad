import type { DataSource, Query, QueryResult, SourceProfile, SourceSummary } from '@yourorg/bi-spec';
import { EngineError, type Engine, type ExecuteContext } from '../engine';
import { buildProfile, statsFromSql } from '../profile';
import type { SourceProvider } from '../sources';
import { compileQuery, type JoinedRelation, type Relation } from '../sql/compile';
import { joinedSources } from '../sql/joins';
import { quoteIdent, snowflake, snowflakeKind, type ColumnKind } from '../sql/dialect';
import { toQueryResult } from '../sql/result';
import { teamSettings, type SnowflakeConfig } from './config';
import type { SnowflakeDriver } from './driver';

/**
 * Snowflake: pushdown, never extract. Queries compile to Snowflake SQL and run in the team's
 * warehouse under the team's role; only the small aggregated result comes back. The role's
 * grants are the access check: a table the role cannot see has no INFORMATION_SCHEMA columns,
 * so it is "not found" for that team.
 */

export interface TableRef {
  database: string;
  schema: string;
  table: string;
}

const PART = /^[^."\u0000]{1,255}$/;

/** Parses "DB.SCHEMA.TABLE". Names are used exactly as written (quoted), as the listing returns them. */
export function parseTableRef(ref: string): TableRef | null {
  const parts = ref.split('.');
  if (parts.length !== 3 || !parts.every((p) => PART.test(p))) return null;
  const [database, schema, table] = parts as [string, string, string];
  return { database, schema, table };
}

const tableSql = (t: TableRef) => `${quoteIdent(t.database)}.${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export interface SnowflakeEngineOptions {
  now?: () => Date;
  /** How long table schemas and listings are cached per team. */
  cacheTtlMs?: number;
  /** How long profiles are cached per team. */
  profileTtlMs?: number;
}

export class SnowflakeEngine implements Engine, SourceProvider {
  readonly type = 'snowflake';
  private readonly schemas = new Map<string, Cached<Map<string, ColumnKind> | null>>();
  private readonly listings = new Map<string, Cached<SourceSummary[]>>();
  private readonly profiles = new Map<string, Cached<SourceProfile | null>>();

  constructor(
    private readonly driver: SnowflakeDriver,
    private readonly config: SnowflakeConfig,
    private readonly options: SnowflakeEngineOptions = {},
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  /** Per-team memo with a TTL. Failures are not cached. */
  private memo<T>(cache: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    const t = this.now().getTime();
    if (hit && t - hit.at < ttl) return hit.value;
    const value = load();
    value.catch(() => cache.delete(key));
    cache.set(key, { at: t, value });
    return value;
  }

  /** Column kinds as the team's role sees them; null when the table is missing or not granted. */
  columns(teamId: string, table: TableRef, signal?: AbortSignal): Promise<Map<string, ColumnKind> | null> {
    return this.memo(this.schemas, `${teamId}\u0000${tableSql(table)}`, this.options.cacheTtlMs ?? 5 * 60_000, async () => {
      const rows = await this.driver.execute(
        teamId,
        `SELECT "COLUMN_NAME", "DATA_TYPE", "NUMERIC_SCALE" FROM ${quoteIdent(table.database)}."INFORMATION_SCHEMA"."COLUMNS"
          WHERE "TABLE_SCHEMA" = ? AND "TABLE_NAME" = ? ORDER BY "ORDINAL_POSITION"`,
        [table.schema, table.table],
        signal,
      );
      if (!rows.length) return null;
      return new Map(
        rows.map((r) => [String(r.COLUMN_NAME), snowflakeKind(String(r.DATA_TYPE), r.NUMERIC_SCALE == null ? null : Number(r.NUMERIC_SCALE))]),
      );
    });
  }

  private async resolve(teamId: string, ref: string, signal?: AbortSignal) {
    const table = parseTableRef(ref);
    const columns = table ? await this.columns(teamId, table, signal) : null;
    return table && columns ? { table, columns } : null;
  }

  async execute(source: DataSource, query: Query, ctx: ExecuteContext): Promise<QueryResult> {
    const resolved = await this.resolve(ctx.teamId, source.ref, ctx.signal);
    if (!resolved) throw new EngineError('unknown_source', `Snowflake table "${source.ref}" was not found or is not granted to this team.`);
    // Joined tables: resolved under the same team role, so a table the team cannot see is "not found".
    const joined = new Map<string, JoinedRelation>();
    for (const { id, source: js } of joinedSources(query, source)) {
      const other = await this.resolve(ctx.teamId, js.ref, ctx.signal);
      if (!other) throw new EngineError('unknown_source', `Joined Snowflake table "${js.ref}" was not found or is not granted to this team.`);
      joined.set(id, { relation: { sql: tableSql(other.table), params: [] }, columns: other.columns });
    }
    const compiled = compileQuery(query, { dialect: snowflake, relation: { sql: tableSql(resolved.table), params: [] }, columns: resolved.columns, joined });
    const rows = await this.driver.execute(ctx.teamId, compiled.sql, compiled.params, ctx.signal);
    return toQueryResult(compiled, rows);
  }

  /** Tables and views the team's role can see (SHOW reads metadata only; it uses no warehouse). */
  list(teamId: string): Promise<SourceSummary[]> {
    return this.memo(this.listings, teamId, this.options.cacheTtlMs ?? 5 * 60_000, async () => {
      const { database } = teamSettings(this.config, teamId);
      const scope = database ? `IN DATABASE ${quoteIdent(database)}` : 'IN ACCOUNT';
      const rows = await this.driver.execute(teamId, `SHOW OBJECTS ${scope} LIMIT 1000`, []);
      return rows
        .filter((r) => (r.kind === 'TABLE' || r.kind === 'VIEW') && r.schema_name !== 'INFORMATION_SCHEMA')
        .map((r) => {
          const ref = `${r.database_name}.${r.schema_name}.${r.name}`;
          const rowCount = r.rows == null || r.rows === '' ? undefined : Number(r.rows);
          const createdAt = r.created_on instanceof Date ? r.created_on.toISOString() : r.created_on ? String(r.created_on) : undefined;
          return {
            source: { type: 'snowflake', ref },
            name: ref,
            ...(rowCount !== undefined && Number.isFinite(rowCount) ? { rowCount } : {}),
            ...(createdAt ? { createdAt } : {}),
          };
        })
        .filter((s) => parseTableRef(s.source.ref) !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /**
   * Profiles a fixed-size row sample, never the whole table. The row count comes from table
   * metadata (free); views have none, so they report the sample's size.
   */
  profile(teamId: string, ref: string): Promise<SourceProfile | null> {
    return this.memo(this.profiles, `${teamId}\u0000${ref}`, this.options.profileTtlMs ?? 60 * 60_000, async () => {
      const resolved = await this.resolve(teamId, ref);
      if (!resolved) return null;
      const { table, columns } = resolved;
      const [meta] = await this.driver.execute(
        teamId,
        `SELECT "ROW_COUNT" FROM ${quoteIdent(table.database)}."INFORMATION_SCHEMA"."TABLES" WHERE "TABLE_SCHEMA" = ? AND "TABLE_NAME" = ?`,
        [table.schema, table.table],
      );
      const metaRows = meta?.ROW_COUNT == null ? undefined : Number(meta.ROW_COUNT);
      const sampleRows = Math.floor(this.config.profileSampleRows);
      const relation: Relation = { sql: `(SELECT * FROM ${tableSql(table)} SAMPLE (${sampleRows} ROWS))`, params: [] };
      const stats = await statsFromSql((sql, binds) => this.driver.execute(teamId, sql, binds), snowflake, relation, columns, {
        sampled: true,
        rowCount: metaRows,
      });
      return buildProfile({ type: 'snowflake', ref }, stats, this.now());
    });
  }
}
