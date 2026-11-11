import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBFileEngine } from './duckdb/engine';
import { DuckDBRuntime } from './duckdb/runtime';
import { UnavailableEngine, type EngineRegistry } from './engine';
import { JsonFileSourceRegistry, type FileSourceRegistry } from './files/registry';
import { SnowflakeIcebergLoader, type SnowflakeUploadsConfig } from './files/iceberg';
import { FileSources } from './files/service';
import { SampleEngine, SampleSources } from './sample/engine';
import { generateOrders } from './sample/orders';
import type { SnowflakeConfig } from './snowflake/config';
import { SdkSnowflakeDriver, type SnowflakeDriver } from './snowflake/driver';
import { SnowflakeEngine } from './snowflake/engine';
import type { SourceCatalog, SourceProvider } from './sources';

export * from './engine';
export { SampleEngine, SampleSources } from './sample/engine';
export { runInMemoryQuery } from './sample/execute';
export { generateOrders } from './sample/orders';
export { buildProfile, statsFromRows, statsFromSql, type ColumnStats, type SourceStats } from './profile';
export { compileQuery, type CompiledQuery, type Relation } from './sql/compile';
export { duckdb as duckdbDialect, snowflake as snowflakeDialect, type ColumnKind, type Dialect } from './sql/dialect';
export { DuckDBRuntime } from './duckdb/runtime';
export { DuckDBFileEngine } from './duckdb/engine';
export { FileSources } from './files/service';
export { JsonFileSourceRegistry, MemoryFileSourceRegistry, FILE_REF, type FileSourceRecord, type FileSourceRegistry } from './files/registry';
export { PostgresFileSourceRegistry } from './files/postgres-registry';
export { MAX_UPLOAD_BYTES, UploadError, exportCsv } from './files/ingest';
export { icebergType, loadSnowflakeUploadsConfig, SnowflakeIcebergLoader, tableName as icebergTableName, type IcebergLoader, type SnowflakeUploadsConfig } from './files/iceberg';
export { loadSnowflakeConfig, type SnowflakeConfig } from './snowflake/config';
export { SdkSnowflakeDriver, type SnowflakeDriver } from './snowflake/driver';
export { SnowflakeEngine, parseTableRef } from './snowflake/engine';
export type { SourceCatalog, SourceProvider, FileUploader } from './sources';

/** Where uploads' Parquet copies (and the local manifest) live by default: services/api/.data */
export const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.data');

export interface DataLayerOptions {
  now?: () => Date;
  dataDir?: string;
  /** Defaults to a JSON manifest in dataDir. Pass the Postgres registry when DATABASE_URL is set. */
  fileRegistry?: FileSourceRegistry;
  /** Null/undefined: Snowflake stays `engine_unavailable` and is omitted from listings. */
  snowflake?: SnowflakeConfig | null;
  /** Override the SDK (tests use a fake). */
  snowflakeDriver?: SnowflakeDriver;
  duckdbRuntime?: DuckDBRuntime;
  /** Upload size cap; defaults to 50 MB. */
  maxUploadBytes?: number;
  /**
   * Store uploads as Snowflake-managed Iceberg tables (needs `snowflake` for the connection).
   * Unset: uploads stay as local Parquet files (single-instance / dev).
   */
  snowflakeUploads?: SnowflakeUploadsConfig | null;
  /** Override the uploads driver (tests use a fake). */
  snowflakeUploadsDriver?: SnowflakeDriver;
}

export interface DataLayer {
  engines: EngineRegistry;
  sources: SourceCatalog;
  files: FileSources;
  close(): Promise<void>;
}

/** Wires every engine and source provider. Nothing touches disk or the network until first use. */
export function createDataLayer(options: DataLayerOptions = {}): DataLayer {
  const now = options.now ?? (() => new Date());
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const runtime = options.duckdbRuntime ?? new DuckDBRuntime();
  const registry: FileSourceRegistry = options.fileRegistry ?? new JsonFileSourceRegistry(dataDir);

  const sample = new SampleEngine({ orders: generateOrders }, now);

  // Uploads in Snowflake: one driver under the uploads role/warehouse (never a team's role; the
  // registry's team-scoped lookup is the access check), shared by the loader and the query engine.
  let uploadsDriver: SnowflakeDriver | undefined;
  let uploadsEngine: SnowflakeEngine | undefined;
  let loader: SnowflakeIcebergLoader | undefined;
  if (options.snowflakeUploads) {
    if (!options.snowflake) throw new Error('Snowflake uploads need the Snowflake connection settings.');
    const uploadsConnection: SnowflakeConfig = {
      ...options.snowflake,
      warehouse: options.snowflakeUploads.warehouse,
      role: options.snowflakeUploads.role,
      database: options.snowflakeUploads.database,
      teams: {},
    };
    uploadsDriver = options.snowflakeUploadsDriver ?? new SdkSnowflakeDriver(uploadsConnection);
    uploadsEngine = new SnowflakeEngine(uploadsDriver, uploadsConnection, { now });
    loader = new SnowflakeIcebergLoader(uploadsDriver, options.snowflakeUploads);
  }

  const files = new FileSources({ runtime, registry, dataDir, now, maxBytes: options.maxUploadBytes, loader });
  const providers: SourceProvider[] = [new SampleSources(sample, now), files];
  const engines: EngineRegistry = { sample, file: new DuckDBFileEngine(files, runtime, uploadsEngine) };

  let driver: SnowflakeDriver | undefined;
  if (options.snowflake) {
    driver = options.snowflakeDriver ?? new SdkSnowflakeDriver(options.snowflake);
    const sf = new SnowflakeEngine(driver, options.snowflake, { now });
    engines.snowflake = sf;
    providers.push(sf);
  } else {
    engines.snowflake = new UnavailableEngine(
      'Snowflake is not configured on this server (set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER and SNOWFLAKE_PASSWORD or a private key).',
    );
  }

  return {
    engines,
    sources: { providers, uploads: files },
    files,
    async close() {
      await Promise.all([runtime.close(), registry.close?.(), driver?.close(), uploadsDriver?.close()]);
    },
  };
}

/** Engines with default settings (no Snowflake). Kept for callers that only need to run queries. */
export function defaultEngines(now: () => Date = () => new Date()): EngineRegistry {
  return createDataLayer({ now }).engines;
}
