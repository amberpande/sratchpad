import pg from 'pg';
import { VersionConflictError } from '../errors';
import { runMigrations } from './migrations';
import type { DashboardRecord, DashboardStore, DashboardSummary, SaveInput, VersionSummary } from './types';

interface VersionRow {
  team_id: string;
  dashboard_id: string;
  version: number;
  title: string;
  spec_version: string;
  spec: unknown;
  created_by: string;
  created_at: Date;
}

function toRecord(row: VersionRow): DashboardRecord {
  return {
    teamId: row.team_id,
    id: row.dashboard_id,
    version: row.version,
    title: row.title,
    specVersion: row.spec_version,
    spec: row.spec,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresDashboardStore implements DashboardStore {
  constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string, options: { migrate?: boolean } = {}): Promise<PostgresDashboardStore> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    if (options.migrate !== false) await runMigrations(pool);
    return new PostgresDashboardStore(pool);
  }

  async get(teamId: string, id: string, version?: number): Promise<DashboardRecord | null> {
    const { rows } =
      version === undefined
        ? await this.pool.query<VersionRow>(
            `SELECT v.* FROM dashboard_versions v
               JOIN dashboards d ON d.team_id = v.team_id AND d.id = v.dashboard_id AND d.latest_version = v.version
              WHERE v.team_id = $1 AND v.dashboard_id = $2`,
            [teamId, id],
          )
        : await this.pool.query<VersionRow>(
            'SELECT * FROM dashboard_versions WHERE team_id = $1 AND dashboard_id = $2 AND version = $3',
            [teamId, id, version],
          );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(teamId: string): Promise<DashboardSummary[]> {
    const { rows } = await this.pool.query<{ id: string; title: string; latest_version: number; updated_at: Date }>(
      'SELECT id, title, latest_version, updated_at FROM dashboards WHERE team_id = $1 AND latest_version > 0 ORDER BY id',
      [teamId],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, latestVersion: r.latest_version, updatedAt: r.updated_at.toISOString() }));
  }

  async listVersions(teamId: string, id: string): Promise<VersionSummary[]> {
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT version, title, spec_version, created_by, created_at FROM dashboard_versions
        WHERE team_id = $1 AND dashboard_id = $2 ORDER BY version DESC`,
      [teamId, id],
    );
    return rows.map((r) => ({
      version: r.version,
      title: r.title,
      specVersion: r.spec_version,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async save(input: SaveInput): Promise<DashboardRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO dashboards (team_id, id, title) VALUES ($1, $2, $3) ON CONFLICT (team_id, id) DO NOTHING', [
        input.teamId,
        input.id,
        input.title,
      ]);
      // Row lock serializes concurrent saves of the same dashboard.
      const { rows } = await client.query<{ latest_version: number }>(
        'SELECT latest_version FROM dashboards WHERE team_id = $1 AND id = $2 FOR UPDATE',
        [input.teamId, input.id],
      );
      const current = rows[0]!.latest_version;
      if (input.expectedVersion !== undefined && input.expectedVersion !== current) {
        throw new VersionConflictError(current, input.expectedVersion);
      }
      const next = current + 1;
      const inserted = await client.query<VersionRow>(
        `INSERT INTO dashboard_versions (team_id, dashboard_id, version, title, spec_version, spec, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
        [input.teamId, input.id, next, input.title, input.specVersion, JSON.stringify(input.spec), input.createdBy],
      );
      await client.query('UPDATE dashboards SET latest_version = $3, title = $4, updated_at = now() WHERE team_id = $1 AND id = $2', [
        input.teamId,
        input.id,
        next,
        input.title,
      ]);
      await client.query('COMMIT');
      return toRecord(inserted.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
