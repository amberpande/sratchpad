import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceProfile, SourceSummary, UploadResponse } from '@yourorg/bi-spec';
import type { DuckDBRuntime } from '../duckdb/runtime';
import { buildProfile, statsFromSql } from '../profile';
import type { FileUploader, SourceProvider, UploadInput } from '../sources';
import type { Relation } from '../sql/compile';
import { duckdb, duckdbKind, type ColumnKind } from '../sql/dialect';
import type { IcebergLoader } from './iceberg';
import { detectFormat, exportCsv, ingestUpload, MAX_UPLOAD_BYTES, sanitizeFileName, UploadError } from './ingest';
import { FILE_REF, type FileSourceRecord, type FileSourceRegistry } from './registry';

export interface FileSourcesOptions {
  runtime: DuckDBRuntime;
  registry: FileSourceRegistry;
  dataDir: string;
  maxBytes?: number;
  now?: () => Date;
  /**
   * When set, every upload is loaded into a Snowflake Iceberg table and the local copies are deleted:
   * the API's disk only holds an upload while it is being processed.
   */
  loader?: IcebergLoader;
}

/** Uploaded CSV/Excel sources: upload, listing, profiling and the Parquet relation queries read. */
export class FileSources implements SourceProvider, FileUploader {
  readonly type = 'file';
  readonly maxBytes: number;
  private readonly schemas = new Map<string, Promise<Map<string, ColumnKind>>>();

  constructor(private readonly options: FileSourcesOptions) {
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  /** Team-scoped lookup. Malformed refs are rejected before they can name a path. */
  async find(teamId: string, ref: string): Promise<FileSourceRecord | null> {
    if (!FILE_REF.test(ref)) return null;
    return this.options.registry.get(teamId, ref);
  }

  /** The FROM item for a source's Parquet copy. The path is a bind parameter, built from the id. */
  relation(record: FileSourceRecord): Relation {
    return { sql: 'read_parquet(?)', params: [join(this.options.dataDir, 'files', `${record.id}.parquet`)] };
  }

  /** Column kinds, read from the Parquet schema once per source (files are immutable). */
  columns(record: FileSourceRecord, signal?: AbortSignal): Promise<Map<string, ColumnKind>> {
    let schema = this.schemas.get(record.id);
    if (!schema) {
      const relation = this.relation(record);
      schema = this.options.runtime
        .query(`DESCRIBE SELECT * FROM ${relation.sql}`, relation.params, signal)
        .then((rows) => new Map(rows.map((r) => [String(r.column_name), duckdbKind(String(r.column_type))])));
      schema.catch(() => this.schemas.delete(record.id));
      this.schemas.set(record.id, schema);
    }
    return schema;
  }

  async upload({ teamId, subject, fileName, bytes }: UploadInput): Promise<UploadResponse> {
    if (bytes.byteLength > this.maxBytes) {
      throw new UploadError(413, 'file_too_large', `Uploads are limited to ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    }
    const name = sanitizeFileName(fileName);
    const format = detectFormat(name, bytes);
    const id = `file_${randomBytes(12).toString('hex')}`;
    const { rowCount } = await ingestUpload(this.options.runtime, { id, format, bytes, dataDir: this.options.dataDir });
    const record: FileSourceRecord = {
      storage: 'local',
      id,
      teamId,
      name,
      format,
      sizeBytes: bytes.byteLength,
      rowCount,
      createdAt: this.now().toISOString(),
      createdBy: subject,
    };
    // Profiled locally while the typed copy is here: no warehouse time is spent on profiling.
    record.profile = await this.computeProfile(record);
    if (this.options.loader) await this.moveToSnowflake(record);
    await this.options.registry.put(record);
    return { summary: summary(record), profile: record.profile };
  }

  private async moveToSnowflake(record: FileSourceRecord): Promise<void> {
    const parquet = join(this.options.dataDir, 'files', `${record.id}.parquet`);
    const tmpDir = join(this.options.dataDir, 'tmp');
    const csv = join(tmpDir, `${record.id}.export.csv`);
    try {
      await mkdir(tmpDir, { recursive: true });
      const columns = [...(await this.columns(record)).entries()].map(([name, kind]) => ({ name, kind }));
      await exportCsv(this.options.runtime, parquet, csv);
      const { table } = await this.options.loader!.load({ id: record.id, csvPath: csv, columns });
      record.storage = 'snowflake';
      record.table = table;
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError(502, 'load_failed', `The file was parsed but could not be loaded into Snowflake: ${String((error as Error).message ?? error).split('\n')[0]!.slice(0, 300)}`);
    } finally {
      this.schemas.delete(record.id);
      await Promise.all([rm(csv, { force: true }), rm(parquet, { force: true })]);
    }
  }

  async list(teamId: string): Promise<SourceSummary[]> {
    return (await this.options.registry.list(teamId)).map(summary);
  }

  async profile(teamId: string, ref: string): Promise<SourceProfile | null> {
    const record = await this.find(teamId, ref);
    if (!record) return null;
    if (record.profile) return record.profile;
    if (record.storage === 'snowflake') return null; // profiled at upload; the local copy is gone
    record.profile = await this.computeProfile(record);
    await this.options.registry.put(record);
    return record.profile;
  }

  private async computeProfile(record: FileSourceRecord): Promise<SourceProfile> {
    const columns = await this.columns(record);
    const stats = await statsFromSql((sql, params) => this.options.runtime.query(sql, params), duckdb, this.relation(record), columns);
    return buildProfile({ type: 'file', ref: record.id }, stats, this.now());
  }
}

function summary(r: FileSourceRecord): SourceSummary {
  return { source: { type: 'file', ref: r.id }, name: r.name, rowCount: r.rowCount, createdAt: r.createdAt };
}
