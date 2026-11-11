import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { BindValue } from '../sql/compile';

/**
 * One in-process DuckDB for the API. It holds no tables: every query reads a Parquet file
 * directly, so the database itself is a stateless compute engine and can stay in memory.
 * Each statement gets its own connection, so concurrent queries never queue behind each other
 * and a cancelled one can be interrupted alone.
 */
export class DuckDBRuntime {
  private instance?: Promise<DuckDBInstance>;

  constructor(private readonly options: { threads?: number; memoryLimit?: string } = {}) {}

  private get db(): Promise<DuckDBInstance> {
    this.instance ??= DuckDBInstance.create(':memory:', {
      ...(this.options.threads ? { threads: String(this.options.threads) } : {}),
      ...(this.options.memoryLimit ? { memory_limit: this.options.memoryLimit } : {}),
    });
    return this.instance;
  }

  async withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const conn = await (await this.db).connect();
    const onAbort = () => conn.interrupt();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fn(conn);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      conn.closeSync();
    }
  }

  /** Runs one statement and returns its rows as JSON-safe objects (wide numbers come back as strings). */
  async query(sql: string, params: BindValue[] = [], signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    return this.withConnection(async (conn) => {
      const reader = await conn.runAndReadAll(sql, params);
      return reader.getRowObjectsJson() as Array<Record<string, unknown>>;
    }, signal);
  }

  async close(): Promise<void> {
    if (!this.instance) return;
    const db = await this.instance;
    this.instance = undefined;
    db.closeSync();
  }
}
