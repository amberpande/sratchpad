import { readFileSync } from 'node:fs';

/**
 * Snowflake connection settings. One service user, with a per-team warehouse and role so cost
 * and access stay attributable: each team's queries run under its own role, and Snowflake's own
 * grants decide which tables that team can see.
 */
export interface SnowflakeTeamSettings {
  warehouse?: string;
  role?: string;
  /** Restricts GET /v1/sources listing to one database (otherwise: everything the role sees). */
  database?: string;
}

export interface SnowflakeConfig extends SnowflakeTeamSettings {
  account: string;
  username: string;
  password?: string;
  /** PEM private key for key-pair auth (preferred for service users). */
  privateKey?: string;
  /** Per-team overrides of warehouse / role / database, keyed by team id. */
  teams: Record<string, SnowflakeTeamSettings>;
  /** Server-side STATEMENT_TIMEOUT_IN_SECONDS, so a runaway query is killed in Snowflake too. */
  statementTimeoutSeconds: number;
  /** Max connections per team pool. */
  poolMax: number;
  /** Rows the profiler samples (SAMPLE (n ROWS)) instead of scanning. */
  profileSampleRows: number;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer.`);
  return n;
}

function parseTeams(raw: string | undefined): Record<string, SnowflakeTeamSettings> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SNOWFLAKE_TEAM_CONFIG must be JSON, e.g. {"team-a": {"warehouse": "A_WH", "role": "A_ROLE"}}.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('SNOWFLAKE_TEAM_CONFIG must be a JSON object.');
  const teams: Record<string, SnowflakeTeamSettings> = {};
  for (const [team, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null) throw new Error(`SNOWFLAKE_TEAM_CONFIG["${team}"] must be an object.`);
    const v = value as Record<string, unknown>;
    const pick = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : undefined);
    teams[team] = { warehouse: pick('warehouse'), role: pick('role'), database: pick('database') };
  }
  return teams;
}

/** Null when Snowflake is not configured: the engine then stays `engine_unavailable`. */
export function loadSnowflakeConfig(env: NodeJS.ProcessEnv = process.env): SnowflakeConfig | null {
  const account = env.SNOWFLAKE_ACCOUNT;
  const username = env.SNOWFLAKE_USER;
  const password = env.SNOWFLAKE_PASSWORD || undefined;
  const privateKey = env.SNOWFLAKE_PRIVATE_KEY || (env.SNOWFLAKE_PRIVATE_KEY_PATH ? readFileSync(env.SNOWFLAKE_PRIVATE_KEY_PATH, 'utf8') : undefined);
  if (!account || !username || (!password && !privateKey)) return null;
  return {
    account,
    username,
    password,
    privateKey,
    warehouse: env.SNOWFLAKE_WAREHOUSE || undefined,
    role: env.SNOWFLAKE_ROLE || undefined,
    database: env.SNOWFLAKE_DATABASE || undefined,
    teams: parseTeams(env.SNOWFLAKE_TEAM_CONFIG),
    statementTimeoutSeconds: positiveInt(env.SNOWFLAKE_STATEMENT_TIMEOUT_S, 60, 'SNOWFLAKE_STATEMENT_TIMEOUT_S'),
    poolMax: positiveInt(env.SNOWFLAKE_POOL_MAX, 4, 'SNOWFLAKE_POOL_MAX'),
    profileSampleRows: positiveInt(env.SNOWFLAKE_PROFILE_SAMPLE_ROWS, 10_000, 'SNOWFLAKE_PROFILE_SAMPLE_ROWS'),
  };
}

/** A team's effective settings: its overrides on top of the defaults. */
export function teamSettings(config: SnowflakeConfig, teamId: string): SnowflakeTeamSettings {
  const own = Object.hasOwn(config.teams, teamId) ? config.teams[teamId] : undefined;
  return {
    warehouse: own?.warehouse ?? config.warehouse,
    role: own?.role ?? config.role,
    database: own?.database ?? config.database,
  };
}
