import type { SnowflakeConfig } from '../snowflake/config';
import type { SnowflakeDriver } from '../snowflake/driver';
import type { ColumnKind } from '../sql/dialect';
import { quoteIdent, quoteLiteral } from '../sql/dialect';

/**
 * Uploads → Snowflake-managed Iceberg tables. After DuckDB has parsed and typed an upload locally,
 * its rows are exported as a normalized CSV, PUT to an internal stage, and turned into an Iceberg
 * table with CREATE ICEBERG TABLE … AS SELECT, casting every column to its type explicitly. Storage
 * is EXTERNAL_VOLUME = 'SNOWFLAKE_MANAGED': Snowflake holds the files, no S3 bucket is involved.
 *
 * Every name in these statements is server-generated (the source id, configured database/schema,
 * our stage and file format) or a column header passed through quoteIdent. Column values never
 * appear in SQL text.
 */

export interface SnowflakeUploadsConfig {
  database: string;
  schema: string;
  warehouse?: string;
  role?: string;
}

/** Load settings from env; null unless uploads go to Snowflake. */
export function loadSnowflakeUploadsConfig(
  env: NodeJS.ProcessEnv,
  connection: SnowflakeConfig | null,
  appDefaults: { database?: string; warehouse?: string; role?: string } = {},
): SnowflakeUploadsConfig | null {
  const database = env.SNOWFLAKE_UPLOADS_DATABASE || appDefaults.database;
  if (!connection || !database) return null;
  return {
    database,
    schema: env.SNOWFLAKE_UPLOADS_SCHEMA || 'UPLOADS',
    warehouse: env.SNOWFLAKE_UPLOADS_WAREHOUSE || appDefaults.warehouse || connection.warehouse,
    role: env.SNOWFLAKE_UPLOADS_ROLE || appDefaults.role || connection.role,
  };
}

export interface LoadInput {
  /** Server-generated source id, "file_<24 hex>". */
  id: string;
  /** Absolute path of the normalized CSV (header row, then one row per record). */
  csvPath: string;
  /** Columns in CSV order with the kinds DuckDB inferred. */
  columns: Array<{ name: string; kind: ColumnKind }>;
}

export interface IcebergLoader {
  /** Creates the table and returns its "DB.SCHEMA.TABLE" ref. */
  load(input: LoadInput, signal?: AbortSignal): Promise<{ table: string }>;
}

export const STAGE = 'BI_UPLOADS_STAGE';
export const CSV_FORMAT = 'BI_UPLOAD_CSV';

/** Snowflake type per inferred kind; all map to Iceberg-supported types. */
export function icebergType(kind: ColumnKind): string {
  switch (kind) {
    case 'integer':
      return 'NUMBER(19,0)'; // Iceberg long
    case 'number':
      return 'FLOAT'; // Iceberg double
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'timestamp':
      return 'TIMESTAMP_NTZ(6)'; // Iceberg timestamp (microseconds)
    default:
      return 'VARCHAR';
  }
}

/** The Iceberg table name for a source: FILE_<ID>, upper case so it reads naturally unquoted too. */
export function tableName(id: string): string {
  if (!/^file_[0-9a-f]{24}$/.test(id)) throw new Error(`Invalid file source id "${id}".`);
  return id.toUpperCase();
}

export class SnowflakeIcebergLoader implements IcebergLoader {
  private ready?: Promise<void>;

  /**
   * `teamId` only picks the driver pool / query tag; the driver is configured with the uploads
   * role and warehouse (see createDataLayer), never a team's own role.
   */
  constructor(
    private readonly driver: SnowflakeDriver,
    private readonly config: SnowflakeUploadsConfig,
    private readonly poolKey = 'uploads',
  ) {}

  private get ns() {
    return `${quoteIdent(this.config.database)}.${quoteIdent(this.config.schema)}`;
  }

  /** Idempotent setup: the schema's stage and CSV file format (created on first upload). */
  setup(): Promise<void> {
    this.ready ??= (async () => {
      const run = (sql: string) => this.driver.execute(this.poolKey, sql, []);
      await run(`CREATE SCHEMA IF NOT EXISTS ${this.ns}`);
      // Matches DuckDB's CSV writer: "" escapes a quote inside a quoted field, an empty unquoted
      // field is NULL, and a backslash is an ordinary character.
      await run(
        `CREATE FILE FORMAT IF NOT EXISTS ${this.ns}.${quoteIdent(CSV_FORMAT)} TYPE = CSV FIELD_DELIMITER = ',' ` +
          `FIELD_OPTIONALLY_ENCLOSED_BY = '"' ESCAPE = NONE ESCAPE_UNENCLOSED_FIELD = NONE SKIP_HEADER = 1 ` +
          `NULL_IF = ('') EMPTY_FIELD_AS_NULL = TRUE COMPRESSION = AUTO ENCODING = 'UTF8'`,
      );
      await run(`CREATE STAGE IF NOT EXISTS ${this.ns}.${quoteIdent(STAGE)} FILE_FORMAT = ${this.ns}.${quoteIdent(CSV_FORMAT)}`);
    })();
    this.ready.catch(() => (this.ready = undefined));
    return this.ready;
  }

  /** The statements a load runs, in order (exposed for tests and for review). */
  statements(input: LoadInput): { put: string; create: string; remove: string; table: string } {
    const table = tableName(input.id);
    const stage = `@${this.ns}.${quoteIdent(STAGE)}`;
    const staged = `${input.id}.csv.gz`;
    const selects = input.columns.map((c, i) => `$${i + 1}::${icebergType(c.kind)} AS ${quoteIdent(c.name)}`);
    return {
      table: `${this.config.database}.${this.config.schema}.${table}`,
      // PUT takes no binds; the path is ours (data dir + server-generated id), quoted as a literal.
      put: `PUT ${quoteLiteral(`file://${input.csvPath}`)} ${stage} AUTO_COMPRESS = TRUE PARALLEL = 4`,
      create:
        `CREATE ICEBERG TABLE ${this.ns}.${quoteIdent(table)} ` +
        `CATALOG = 'SNOWFLAKE' EXTERNAL_VOLUME = 'SNOWFLAKE_MANAGED' BASE_LOCATION = ${quoteLiteral(input.id)} ` +
        `AS SELECT ${selects.join(', ')} FROM ${stage}/${staged} (FILE_FORMAT => ${quoteLiteral(`${this.config.database}.${this.config.schema}.${CSV_FORMAT}`)})`,
      remove: `REMOVE ${stage}/${staged}`,
    };
  }

  async load(input: LoadInput, signal?: AbortSignal): Promise<{ table: string }> {
    if (!input.columns.length) throw new Error('An upload needs at least one column.');
    await this.setup();
    const s = this.statements(input);
    const run = (sql: string) => this.driver.execute(this.poolKey, sql, [], signal);
    try {
      await run(s.put);
      await run(s.create);
      return { table: s.table };
    } finally {
      // The table holds its own copy; the staged CSV is no longer needed either way.
      await run(s.remove).catch(() => undefined);
    }
  }
}
