import type { SqlClient } from './client';

/**
 * The app's own records as Snowflake HYBRID tables (row store: enforced keys, row-level locking,
 * single-digit-millisecond point reads). Design notes, from Snowflake's hybrid-table rules:
 *
 * - Every table has an enforced PRIMARY KEY; foreign keys are enforced but cannot CASCADE (only
 *   RESTRICT / NO ACTION), which is fine: dashboards and versions are never deleted.
 * - Timestamps are UTC ISO-8601 strings (`2026-11-10T06:21:24.041Z`). They sort chronologically,
 *   can be indexed (TIMESTAMP_TZ cannot), and read back without driver date conversion.
 * - JSON (dashboard specs, profiles) is stored as text: VARIANT cannot be indexed and needs
 *   PARSE_JSON in INSERT…SELECT; the app never queries inside the JSON.
 * - All hybrid tables in one transaction must live in one database: keep them together.
 */

export interface Migration {
  id: string;
  statements: string[];
}

export const SNOWFLAKE_MIGRATIONS: Migration[] = [
  {
    id: '001_dashboards',
    statements: [
      `CREATE HYBRID TABLE IF NOT EXISTS dashboards (
        team_id        VARCHAR(128) NOT NULL,
        id             VARCHAR(64)  NOT NULL,
        title          VARCHAR(200) NOT NULL,
        latest_version INTEGER      NOT NULL,
        created_at     VARCHAR(32)  NOT NULL,
        updated_at     VARCHAR(32)  NOT NULL,
        CONSTRAINT pk_dashboards PRIMARY KEY (team_id, id)
      )`,
      `CREATE HYBRID TABLE IF NOT EXISTS dashboard_versions (
        team_id      VARCHAR(128) NOT NULL,
        dashboard_id VARCHAR(64)  NOT NULL,
        version      INTEGER      NOT NULL,
        title        VARCHAR(200) NOT NULL,
        spec_version VARCHAR(16)  NOT NULL,
        spec         VARCHAR      NOT NULL,
        created_by   VARCHAR(256) NOT NULL,
        created_at   VARCHAR(32)  NOT NULL,
        CONSTRAINT pk_dashboard_versions PRIMARY KEY (team_id, dashboard_id, version),
        CONSTRAINT fk_versions_dashboard FOREIGN KEY (team_id, dashboard_id) REFERENCES dashboards (team_id, id)
      )`,
    ],
  },
  {
    id: '002_sources',
    statements: [
      `CREATE HYBRID TABLE IF NOT EXISTS file_sources (
        id         VARCHAR(40)  NOT NULL,
        team_id    VARCHAR(128) NOT NULL,
        name       VARCHAR(256) NOT NULL,
        format     VARCHAR(8)   NOT NULL,
        size_bytes NUMBER(38,0) NOT NULL,
        row_count  NUMBER(38,0) NOT NULL,
        profile    VARCHAR,
        storage    VARCHAR(16),
        table_name VARCHAR(512),
        created_by VARCHAR(256) NOT NULL,
        created_at VARCHAR(32)  NOT NULL,
        CONSTRAINT pk_file_sources PRIMARY KEY (id),
        INDEX idx_file_sources_team (team_id, created_at)
      )`,
    ],
  },
  {
    id: '003_shares',
    statements: [
      `CREATE HYBRID TABLE IF NOT EXISTS dashboard_shares (
        id           VARCHAR(16)  NOT NULL,
        team_id      VARCHAR(128) NOT NULL,
        dashboard_id VARCHAR(64)  NOT NULL,
        audience     VARCHAR(8)   NOT NULL,
        label        VARCHAR(100) NOT NULL,
        version      INTEGER,
        secret_hash  VARCHAR(64)  NOT NULL,
        created_by   VARCHAR(256) NOT NULL,
        created_at   VARCHAR(32)  NOT NULL,
        expires_at   VARCHAR(32),
        revoked_at   VARCHAR(32),
        last_used_at VARCHAR(32),
        attributes   VARCHAR,
        CONSTRAINT pk_dashboard_shares PRIMARY KEY (id),
        CONSTRAINT fk_shares_dashboard FOREIGN KEY (team_id, dashboard_id) REFERENCES dashboards (team_id, id)
      )`,
    ],
  },
  {
    // Platform features (workstream D). Same shape as Postgres migration 005_platform.
    id: '004_platform',
    statements: [
      `CREATE HYBRID TABLE IF NOT EXISTS platform_records (
        team_id    VARCHAR(128) NOT NULL,
        collection VARCHAR(64)  NOT NULL,
        id         VARCHAR(256) NOT NULL,
        data       VARCHAR      NOT NULL,
        created_at VARCHAR(32)  NOT NULL,
        updated_at VARCHAR(32)  NOT NULL,
        CONSTRAINT pk_platform_records PRIMARY KEY (team_id, collection, id),
        INDEX idx_platform_records_collection (collection, team_id)
      )`,
      `CREATE HYBRID TABLE IF NOT EXISTS platform_counters (
        team_id VARCHAR(128) NOT NULL,
        counter VARCHAR(256) NOT NULL,
        bucket  VARCHAR(32)  NOT NULL,
        value   NUMBER(38,0) NOT NULL,
        CONSTRAINT pk_platform_counters PRIMARY KEY (team_id, counter, bucket)
      )`,
      `CREATE HYBRID TABLE IF NOT EXISTS platform_leases (
        name       VARCHAR(128) NOT NULL,
        holder     VARCHAR(256) NOT NULL,
        expires_at VARCHAR(32)  NOT NULL,
        CONSTRAINT pk_platform_leases PRIMARY KEY (name)
      )`,
    ],
  },
];

export const MIGRATIONS_TABLE = `CREATE HYBRID TABLE IF NOT EXISTS bi_schema_migrations (
  id         VARCHAR(100) NOT NULL,
  applied_at VARCHAR(32)  NOT NULL,
  CONSTRAINT pk_bi_schema_migrations PRIMARY KEY (id)
)`;

/**
 * Applies pending migrations. Every statement is idempotent (IF NOT EXISTS) and the migrations table
 * has an enforced key, so several ECS tasks starting at once converge without an advisory lock.
 */
export async function runSnowflakeMigrations(
  client: SqlClient,
  migrations: Migration[] = SNOWFLAKE_MIGRATIONS,
  migrationsTable: string = MIGRATIONS_TABLE,
): Promise<string[]> {
  await client.query(migrationsTable);
  const { rows } = await client.query('SELECT id FROM bi_schema_migrations');
  const done = new Set(rows.map((r) => String(r.id)));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    for (const sql of m.statements) await client.query(sql);
    try {
      await client.query('INSERT INTO bi_schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, new Date().toISOString()]);
      applied.push(m.id);
    } catch {
      // Another task recorded it first (primary key): its statements were idempotent too.
    }
  }
  return applied;
}
