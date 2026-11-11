import pg from 'pg';
import type { SourceProfile } from '@yourorg/bi-spec';
import { runMigrations } from '../../store/migrations';
import type { FileSourceRecord, FileSourceRegistry } from './registry';

interface Row {
  id: string;
  team_id: string;
  name: string;
  format: 'csv' | 'xlsx';
  size_bytes: string | number;
  row_count: string | number;
  profile: SourceProfile | null;
  storage: string | null;
  table_name: string | null;
  created_by: string;
  created_at: Date;
}

function toRecord(row: Row): FileSourceRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    format: row.format,
    sizeBytes: Number(row.size_bytes),
    rowCount: Number(row.row_count),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.storage === 'snowflake' ? { storage: 'snowflake' as const } : row.storage === 'local' ? { storage: 'local' as const } : {}),
    ...(row.table_name ? { table: row.table_name } : {}),
  };
}

/** File-source registry in Postgres (migration 002_sources), used when DATABASE_URL is set. */
export class PostgresFileSourceRegistry implements FileSourceRegistry {
  constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string, options: { migrate?: boolean } = {}): Promise<PostgresFileSourceRegistry> {
    const pool = new pg.Pool({ connectionString, max: 4 });
    if (options.migrate !== false) await runMigrations(pool);
    return new PostgresFileSourceRegistry(pool);
  }

  async get(teamId: string, id: string): Promise<FileSourceRecord | null> {
    // team_id in the WHERE clause: another team's id reads exactly like a missing one.
    const { rows } = await this.pool.query<Row>('SELECT * FROM file_sources WHERE id = $1 AND team_id = $2', [id, teamId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(teamId: string): Promise<FileSourceRecord[]> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM file_sources WHERE team_id = $1 ORDER BY created_at DESC, id', [teamId]);
    return rows.map(toRecord);
  }

  async put(r: FileSourceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO file_sources (id, team_id, name, format, size_bytes, row_count, profile, created_by, created_at, storage, table_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET profile = EXCLUDED.profile, row_count = EXCLUDED.row_count,
         storage = EXCLUDED.storage, table_name = EXCLUDED.table_name
       WHERE file_sources.team_id = EXCLUDED.team_id`,
      [r.id, r.teamId, r.name, r.format, r.sizeBytes, r.rowCount, r.profile ? JSON.stringify(r.profile) : null, r.createdBy, r.createdAt, r.storage ?? null, r.table ?? null],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
