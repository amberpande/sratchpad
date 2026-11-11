import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceProfile } from '@yourorg/bi-spec';

/**
 * Uploaded-file sources. The registry holds metadata only; the data lives in one Parquet file
 * per source under the data dir, named by the source id (never by anything the user sent).
 */
export interface FileSourceRecord {
  /** The opaque ref, "file_<24 hex>". Also the Parquet file's base name. */
  id: string;
  teamId: string;
  /** Sanitized original file name, for display only. */
  name: string;
  format: 'csv' | 'xlsx';
  sizeBytes: number;
  rowCount: number;
  createdAt: string;
  createdBy: string;
  /** Profile taken at upload; files are immutable, so it never goes stale. */
  profile?: SourceProfile;
  /** Where the rows live: a local Parquet copy (default) or a Snowflake Iceberg table. */
  storage?: 'local' | 'snowflake';
  /** For storage "snowflake": the Iceberg table, "DB.SCHEMA.TABLE". */
  table?: string;
}

export interface FileSourceRegistry {
  /** Null when the source does not exist or belongs to another team. */
  get(teamId: string, id: string): Promise<FileSourceRecord | null>;
  /** Newest first. */
  list(teamId: string): Promise<FileSourceRecord[]>;
  put(record: FileSourceRecord): Promise<void>;
  close?(): Promise<void>;
}

export const FILE_REF = /^file_[0-9a-f]{24}$/;

const newestFirst = (a: FileSourceRecord, b: FileSourceRecord) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

export class MemoryFileSourceRegistry implements FileSourceRegistry {
  protected readonly records = new Map<string, FileSourceRecord>();

  async get(teamId: string, id: string): Promise<FileSourceRecord | null> {
    const record = this.records.get(id);
    return record && record.teamId === teamId ? structuredClone(record) : null;
  }

  async list(teamId: string): Promise<FileSourceRecord[]> {
    return [...this.records.values()].filter((r) => r.teamId === teamId).sort(newestFirst).map((r) => structuredClone(r));
  }

  async put(record: FileSourceRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
}

/**
 * A JSON manifest next to the Parquet files, so local uploads survive API restarts without a
 * database. Writes are serialized and atomic (temp file + rename), so a crash mid-write leaves
 * the previous manifest intact. Single-process only; use the Postgres registry with replicas.
 */
export class JsonFileSourceRegistry extends MemoryFileSourceRegistry {
  private loaded?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    super();
  }

  private get path() {
    return join(this.dataDir, 'manifest.json');
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let raw: string;
      try {
        raw = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const parsed = JSON.parse(raw) as { files?: FileSourceRecord[] };
      for (const record of parsed.files ?? []) {
        if (FILE_REF.test(record.id)) this.records.set(record.id, record);
      }
    })();
    return this.loaded;
  }

  override async get(teamId: string, id: string) {
    await this.load();
    return super.get(teamId, id);
  }

  override async list(teamId: string) {
    await this.load();
    return super.list(teamId);
  }

  override async put(record: FileSourceRecord): Promise<void> {
    await this.load();
    await super.put(record);
    const snapshot = JSON.stringify({ version: 1, files: [...this.records.values()] }, null, 2);
    const write = this.writing.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.path);
    });
    this.writing = write.catch(() => {});
    await write;
  }
}
