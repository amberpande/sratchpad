import type { BindValue } from '../sql/compile';
import { quoteLiteral } from '../sql/dialect';
import { teamSettings, type SnowflakeConfig } from './config';

/**
 * The seam between the Snowflake engine and the vendor SDK. The engine only ever hands it SQL the
 * compiler produced plus bind values; tests swap in a fake that records statements.
 */
export interface SnowflakeDriver {
  execute(teamId: string, sql: string, binds: BindValue[], signal?: AbortSignal): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

// Minimal structural types for the parts of snowflake-sdk we use (loaded lazily, see below).
interface SfStatement {
  cancel(cb?: (err?: unknown) => void): void;
}
interface SfConnection {
  execute(options: {
    sqlText: string;
    binds?: BindValue[];
    complete: (err: Error | undefined, stmt: SfStatement, rows?: Array<Record<string, unknown>>) => void;
  }): SfStatement;
}
interface SfPool {
  use<T>(fn: (conn: SfConnection) => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  clear(): Promise<void>;
}

/**
 * snowflake-sdk behind the driver interface: one connection pool per team (each with the team's
 * warehouse and role). Every pooled session is pinned to UTC, tagged with the team for cost
 * attribution, and given a server-side statement timeout.
 */
export class SdkSnowflakeDriver implements SnowflakeDriver {
  private readonly pools = new Map<string, Promise<SfPool>>();
  private readonly prepared = new WeakSet<SfConnection>();

  constructor(private readonly config: SnowflakeConfig) {}

  private pool(teamId: string): Promise<SfPool> {
    let pool = this.pools.get(teamId);
    if (!pool) {
      pool = (async () => {
        // Imported lazily: the SDK is heavy and most deployments without Snowflake never need it.
        const sdk = (await import('snowflake-sdk')).default;
        sdk.configure({ logLevel: 'ERROR' });
        const settings = teamSettings(this.config, teamId);
        return sdk.createPool(
          {
            account: this.config.account,
            username: this.config.username,
            ...(this.config.privateKey
              ? { authenticator: 'SNOWFLAKE_JWT', privateKey: this.config.privateKey }
              : { password: this.config.password }),
            ...(settings.warehouse ? { warehouse: settings.warehouse } : {}),
            ...(settings.role ? { role: settings.role } : {}),
            application: 'sratchpad',
          },
          { max: this.config.poolMax, min: 0, evictionRunIntervalMillis: 60_000, idleTimeoutMillis: 300_000 },
        ) as unknown as SfPool;
      })();
      pool.catch(() => this.pools.delete(teamId));
      this.pools.set(teamId, pool);
    }
    return pool;
  }

  private run(conn: SfConnection, sql: string, binds: BindValue[], signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const statement = conn.execute({
        sqlText: sql,
        binds,
        complete: (err, _stmt, rows) => {
          signal?.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve(rows ?? []);
        },
      });
      const onAbort = () => statement.cancel();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async execute(teamId: string, sql: string, binds: BindValue[], signal?: AbortSignal) {
    const pool = await this.pool(teamId);
    return pool.use(async (conn) => {
      if (!this.prepared.has(conn)) {
        // Integers from validated config and a quoted literal: no user input in this statement.
        await this.run(
          conn,
          `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${Math.floor(this.config.statementTimeoutSeconds)}, ` +
            // One statement per call: custom SQL (spec 1.4) can never smuggle in a second one.
            `TIMEZONE = 'UTC', MULTI_STATEMENT_COUNT = 1, QUERY_TAG = ${quoteLiteral(`sratchpad:${teamId}`)}`,
          [],
        );
        this.prepared.add(conn);
      }
      return this.run(conn, sql, binds, signal);
    });
  }

  async close(): Promise<void> {
    const pools = await Promise.allSettled(this.pools.values());
    this.pools.clear();
    await Promise.all(pools.map(async (p) => p.status === 'fulfilled' && (await p.value.drain(), await p.value.clear())));
  }
}
