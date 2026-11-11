import type pg from 'pg';

/** Versioned JSON documents in a relational store with JSONB. */
export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_dashboards',
    sql: `
      CREATE TABLE dashboards (
        team_id        text        NOT NULL,
        id             text        NOT NULL,
        title          text        NOT NULL,
        latest_version integer     NOT NULL DEFAULT 0,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, id)
      );

      CREATE TABLE dashboard_versions (
        team_id      text        NOT NULL,
        dashboard_id text        NOT NULL,
        version      integer     NOT NULL CHECK (version > 0),
        title        text        NOT NULL,
        spec_version text        NOT NULL,
        spec         jsonb       NOT NULL,
        created_by   text        NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, dashboard_id, version),
        FOREIGN KEY (team_id, dashboard_id) REFERENCES dashboards (team_id, id) ON DELETE CASCADE
      );
    `,
  },
  {
    // Uploaded-file sources (Phase 2). Metadata only: the Parquet copy lives on disk / object storage.
    id: '002_sources',
    sql: `
      CREATE TABLE file_sources (
        id          text        PRIMARY KEY,
        team_id     text        NOT NULL,
        name        text        NOT NULL,
        format      text        NOT NULL,
        size_bytes  bigint      NOT NULL,
        row_count   bigint      NOT NULL,
        profile     jsonb,
        created_by  text        NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX file_sources_team ON file_sources (team_id, created_at DESC);
    `,
  },
  {
    // Read-only share grants (apps and business viewers). Only a hash of each token's secret is kept.
    id: '003_shares',
    sql: `
      CREATE TABLE dashboard_shares (
        id           text        PRIMARY KEY,
        team_id      text        NOT NULL,
        dashboard_id text        NOT NULL,
        audience     text        NOT NULL CHECK (audience IN ('app', 'viewer')),
        label        text        NOT NULL,
        version      integer     CHECK (version > 0),
        secret_hash  text        NOT NULL,
        created_by   text        NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        expires_at   timestamptz,
        revoked_at   timestamptz,
        last_used_at timestamptz,
        FOREIGN KEY (team_id, dashboard_id) REFERENCES dashboards (team_id, id) ON DELETE CASCADE
      );
      CREATE INDEX dashboard_shares_dashboard ON dashboard_shares (team_id, dashboard_id, created_at DESC);
    `,
  },
  {
    // Where an upload's rows live: the local Parquet copy (NULL / 'local') or a Snowflake Iceberg table.
    id: '004_upload_storage',
    sql: `
      ALTER TABLE file_sources ADD COLUMN storage text;
      ALTER TABLE file_sources ADD COLUMN table_name text;
    `,
  },
  {
    // Platform features (workstream D): team-scoped JSON records (comments, favorites, subscriptions,
    // alerts, metric catalogs, refresh schedules), usage counters, scheduler leases.
    id: '005_platform',
    sql: `
      CREATE TABLE platform_records (
        team_id    text NOT NULL,
        collection text NOT NULL,
        id         text NOT NULL,
        data       text NOT NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (team_id, collection, id)
      );
      CREATE INDEX platform_records_collection ON platform_records (collection, team_id);
      CREATE TABLE platform_counters (
        team_id text   NOT NULL,
        counter text   NOT NULL,
        bucket  text   NOT NULL,
        value   bigint NOT NULL,
        PRIMARY KEY (team_id, counter, bucket)
      );
      CREATE TABLE platform_leases (
        name       text PRIMARY KEY,
        holder     text NOT NULL,
        expires_at text NOT NULL
      );
    `,
  },
  {
    // Row-level security attributes carried by a share (a subset of its creator's).
    id: '006_share_attributes',
    sql: `ALTER TABLE dashboard_shares ADD COLUMN attributes jsonb;`,
  },
];

export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent migrators (e.g. several API replicas starting at once).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('bi_platform_migrations'))`);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
