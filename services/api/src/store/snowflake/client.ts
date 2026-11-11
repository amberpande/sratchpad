import type { SnowflakeConfig } from '../../data/snowflake/config';
import { quoteLiteral } from '../../data/sql/dialect';

/**
 * The seam between the Hybrid Tables stores and the database. Statements use `?` placeholders with
 * bind values only (never interpolated input). Row keys are lower-cased, so Snowflake's upper-case
 * unquoted identifiers read the same as anywhere else.
 */

export type SqlValue = string | number | boolean | null;
export type SqlRow = Record<string, unknown>;

export interface SqlResult {
  rows: SqlRow[];
  /** Rows inserted / updated / deleted by a DML statement. */
  affected: number;
}

export interface SqlExecutor {
  query(sql: string, binds?: SqlValue[]): Promise<SqlResult>;
}

export interface SqlClient extends SqlExecutor {
  /** Runs fn on one connection between BEGIN and COMMIT; ROLLBACK if it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SnowflakeAppStoreConfig {
  /** Database and schema that hold the app's hybrid tables. */
  database: string;
  schema: string;
  warehouse?: string;
  role?: string;
  poolMax: number;
}

/** App-store settings from env, or null when the Snowflake store is not selected/configured. */
export function loadSnowflakeAppStoreConfig(env: NodeJS.ProcessEnv, connection: SnowflakeConfig | null): SnowflakeAppStoreConfig | null {
  const database = env.SNOWFLAKE_APP_DATABASE;
  if (!database || !connection) return null;
  const poolMax = Number(env.SNOWFLAKE_APP_POOL_MAX ?? 8);
  if (!Number.isInteger(poolMax) || poolMax < 1) throw new Error('SNOWFLAKE_APP_POOL_MAX must be a positive integer.');
  return {
    database,
    schema: env.SNOWFLAKE_APP_SCHEMA || 'PUBLIC',
    warehouse: env.SNOWFLAKE_APP_WAREHOUSE || connection.warehouse,
    role: env.SNOWFLAKE_APP_ROLE || connection.role,
    poolMax,
  };
}

export function lowerKeys(row: SqlRow): SqlRow {
  const out: SqlRow = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}

// Minimal structural types for the parts of snowflake-sdk used here (loaded lazily).
interface SfStatement {
  getNumUpdatedRows?(): number | undefined;
}
interface SfConnection {
  execute(options: { sqlText: string; binds?: SqlValue[]; complete: (err: Error | undefined, stmt: SfStatement, rows?: SqlRow[]) => void }): SfStatement;
}
interface SfPool {
  use<T>(fn: (conn: SfConnection) => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  clear(): Promise<void>;
}

const DML_COUNT_KEYS = ['number of rows inserted', 'number of rows updated', 'number of rows deleted'];

/**
 * snowflake-sdk pool for the app's own records. One pool (not per team): the app role owns the
 * hybrid tables; team data access stays in the per-team query engine pools.
 */
export class SnowflakeSqlClient implements SqlClient {
  private pool?: Promise<SfPool>;
  private readonly prepared = new WeakSet<SfConnection>();

  constructor(
    private readonly connection: SnowflakeConfig,
    private readonly app: SnowflakeAppStoreConfig,
  ) {}

  private getPool(): Promise<SfPool> {
    this.pool ??= (async () => {
      const sdk = (await import('snowflake-sdk')).default;
      sdk.configure({ logLevel: 'ERROR' });
      return sdk.createPool(
        {
          account: this.connection.account,
          username: this.connection.username,
          ...(this.connection.privateKey
            ? { authenticator: 'SNOWFLAKE_JWT', privateKey: this.connection.privateKey }
            : { password: this.connection.password }),
          database: this.app.database,
          schema: this.app.schema,
          ...(this.app.warehouse ? { warehouse: this.app.warehouse } : {}),
          ...(this.app.role ? { role: this.app.role } : {}),
          application: 'sratchpad',
        },
        { max: this.app.poolMax, min: 0, evictionRunIntervalMillis: 60_000, idleTimeoutMillis: 300_000 },
      ) as unknown as SfPool;
    })();
    this.pool.catch(() => (this.pool = undefined));
    return this.pool;
  }

  private run(conn: SfConnection, sql: string, binds: SqlValue[]): Promise<SqlResult> {
    return new Promise((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        binds,
        complete: (err, stmt, rows = []) => {
          if (err) return reject(err);
          const first = rows[0] ?? {};
          const fromRow = DML_COUNT_KEYS.map((k) => first[k]).find((v) => typeof v === 'number') as number | undefined;
          const affected = stmt.getNumUpdatedRows?.() ?? fromRow ?? 0;
          resolve({ rows: rows.map(lowerKeys), affected: Number(affected) || 0 });
        },
      });
    });
  }

  private async prepare(conn: SfConnection) {
    if (this.prepared.has(conn)) return;
    // Constants only. READ_LATEST_WRITES: a save on one ECS task is visible to reads on every other
    // task immediately (hybrid tables otherwise allow up to ~100 ms of cross-session staleness).
    await this.run(
      conn,
      `ALTER SESSION SET TIMEZONE = 'UTC', STATEMENT_TIMEOUT_IN_SECONDS = 30, READ_LATEST_WRITES = TRUE, ` +
        `TRANSACTION_ABORT_ON_ERROR = TRUE, QUERY_TAG = ${quoteLiteral('sratchpad:app-store')}`,
      [],
    );
    this.prepared.add(conn);
  }

  async query(sql: string, binds: SqlValue[] = []): Promise<SqlResult> {
    return (await this.getPool()).use(async (conn) => {
      await this.prepare(conn);
      return this.run(conn, sql, binds);
    });
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return (await this.getPool()).use(async (conn) => {
      await this.prepare(conn);
      await this.run(conn, 'BEGIN', []);
      try {
        const result = await fn({ query: (sql, binds = []) => this.run(conn, sql, binds) });
        await this.run(conn, 'COMMIT', []);
        return result;
      } catch (error) {
        await this.run(conn, 'ROLLBACK', []).catch(() => {});
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    const pool = await this.pool?.catch(() => undefined);
    this.pool = undefined;
    if (pool) {
      await pool.drain();
      await pool.clear();
    }
  }
}
