import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { duckdbKind, quoteLiteral, type ColumnKind } from '../sql/dialect';
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

  /**
   * Runs one custom SQL statement (spec 1.4) in a throwaway, locked-down DuckDB: it can read only
   * `allowedPaths` (the team's referenced uploads), never other files, URLs or extensions, and its
   * settings are locked before the author's SQL runs. Prepared, so a second statement is refused.
   * `setup` runs first, with the same restrictions (e.g. loading sample rows into tables).
   */
  async sandboxQuery(
    sql: string,
    params: BindValue[],
    options: { allowedPaths: string[]; setup?: (conn: DuckDBConnection) => Promise<void>; signal?: AbortSignal },
  ): Promise<{ rows: Array<Record<string, unknown>>; columns: Array<{ name: string; kind: ColumnKind }> }> {
    options.signal?.throwIfAborted();
    const db = await DuckDBInstance.create(':memory:', {
      threads: String(this.options.threads ?? 2),
      memory_limit: this.options.memoryLimit ?? '512MB',
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    });
    const conn = await db.connect();
    const onAbort = () => conn.interrupt();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Server-generated paths of the team's own uploads; quoted literals (SET takes no binds).
      await conn.run(`SET allowed_paths = [${options.allowedPaths.map(quoteLiteral).join(', ')}]`);
      await conn.run('SET enable_external_access = false');
      if (options.setup) await options.setup(conn);
      await conn.run('SET lock_configuration = true');
      const prepared = await conn.prepare(sql);
      if (params.length) prepared.bind(params as never);
      const reader = await prepared.runAndReadAll();
      const names = reader.columnNames();
      const types = reader.columnTypes();
      return {
        rows: reader.getRowObjectsJson() as Array<Record<string, unknown>>,
        columns: names.map((name, i) => ({ name, kind: duckdbKind(String(types[i])) })),
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      conn.closeSync();
      db.closeSync();
    }
  }

  /**
   * Loads in-memory rows (sample datasets) into `table` of a sandbox connection. Column types come
   * from the first non-null value: numbers DOUBLE, booleans BOOLEAN, ISO dates DATE, ISO timestamps
   * TIMESTAMP, everything else VARCHAR.
   */
  static async loadRows(conn: DuckDBConnection, table: string, fields: Iterable<string>, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    const cols = [...fields].map((name) => {
      const v = rows.find((r) => r[name] !== null && r[name] !== undefined)?.[name];
      const kind = typeof v === 'number' ? 'DOUBLE' : typeof v === 'boolean' ? 'BOOLEAN' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'DATE' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) ? 'TIMESTAMP' : 'VARCHAR';
      return { name, kind };
    });
    const raw = `${table}__raw`;
    const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
    await conn.run(`CREATE TABLE ${q(raw)} (${cols.map((c) => `${q(c.name)} ${c.kind === 'DOUBLE' || c.kind === 'BOOLEAN' ? c.kind : 'VARCHAR'}`).join(', ')})`);
    const appender = await conn.createAppender(raw);
    for (const r of rows) {
      for (const c of cols) {
        const v = r[c.name];
        if (v === null || v === undefined) appender.appendNull();
        else if (c.kind === 'DOUBLE') typeof v === 'number' ? appender.appendDouble(v) : appender.appendNull();
        else if (c.kind === 'BOOLEAN') typeof v === 'boolean' ? appender.appendBoolean(v) : appender.appendNull();
        else appender.appendVarchar(String(v));
      }
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
    const select = cols.map((c) => (c.kind === 'DATE' || c.kind === 'TIMESTAMP' ? `TRY_CAST(${q(c.name)} AS ${c.kind}) AS ${q(c.name)}` : q(c.name))).join(', ');
    await conn.run(`CREATE TABLE ${q(table)} AS SELECT ${select} FROM ${q(raw)}`);
    await conn.run(`DROP TABLE ${q(raw)}`);
  }

  async close(): Promise<void> {
    if (!this.instance) return;
    const db = await this.instance;
    this.instance = undefined;
    db.closeSync();
  }
}
