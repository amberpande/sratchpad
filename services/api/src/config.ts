import { DEV_TOKENS } from './auth';
import { loadSnowflakeConfig, type SnowflakeConfig } from './data/snowflake/config';
import { loadSnowflakeUploadsConfig, type SnowflakeUploadsConfig } from './data/files/iceberg';
import { loadSnowflakeAppStoreConfig, type SnowflakeAppStoreConfig } from './store/snowflake/client';

/** Where the app's own records (dashboards, versions, shares, upload metadata) live. */
export type StoreKind = 'memory' | 'postgres' | 'snowflake';
import type { LogFormat, LogLevel } from './obs/logger';

export interface AssistantConfig {
  enabled: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
}

/** Which LLM backs suggestion ranking and the assistant. "ollama" is for local testing only. */
export interface LlmConfig {
  provider: 'anthropic' | 'ollama';
  ollamaUrl: string;
  ollamaModel: string;
  ollamaNumCtx: number;
}

export interface AiConfig {
  /** Rank and word suggestions with Claude. Off: rule-based suggestions only. */
  enabled: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
}

export interface Config {
  port: number;
  store: StoreKind;
  databaseUrl?: string;
  /** Set when store = snowflake: the database/schema holding the app's hybrid tables. */
  snowflakeApp: SnowflakeAppStoreConfig | null;
  /** Where uploaded data lives: local Parquet (dev, single instance) or Snowflake Iceberg tables. */
  uploads: 'local' | 'snowflake';
  snowflakeUploads: SnowflakeUploadsConfig | null;
  tokens: string;
  corsOrigins: string[];
  /** Seed examples/dashboards on start (always on for the in-memory store). */
  seed: boolean;
  seedTeam: string;
  queryTimeoutMs: number;
  /** Custom SQL queries for editors (spec 1.4, D-070). BI_CUSTOM_SQL=on|off, default on. */
  customSql: boolean;
  /** Where uploads' Parquet copies live (default services/api/.data). */
  dataDir?: string;
  /** Null when Snowflake is not configured. */
  snowflake: SnowflakeConfig | null;
  llm: LlmConfig;
  ai: AiConfig;
  /** The Studio's dashboard assistant (chat). */
  assistant: AssistantConfig;
  /** Shared result cache; in-process LRU when unset. */
  redisUrl?: string;
  /** 0 disables the server-side result cache. */
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  /** Per team. 0 disables. */
  maxConcurrentQueries: number;
  maxQueuedQueries: number;
  /** Per team, per minute. 0 disables. */
  rateLimits: { data: number; recommendations: number; uploads: number; writes: number; assistant: number };
  logFormat: LogFormat;
  logLevel: LogLevel;
  metricsToken?: string;
  /** Public URL of the hosted viewer (share links point here). */
  viewerUrl?: string;
  /** Hostnames the app is served on; share links use the request's host when it is listed. */
  publicHosts: string[];
  /** Built Studio and viewer to serve from this process (single-container deployment). */
  staticDir?: string;
  /** Where to find examples/dashboards for BI_SEED. */
  examplesDir?: string;
  /** Platform features (workstream D): email, scheduler, webhooks. */
  platform: PlatformConfig;
}

export interface PlatformConfig {
  /** SMTP connection URL (e.g. smtps://user:pass@email-smtp.eu-west-1.amazonaws.com:465). Unset: no email. */
  smtpUrl?: string;
  smtpFrom: string;
  /** Run the scheduler (subscriptions, alerts, refresh) in this process. */
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  /** Alert webhooks may only target these hosts (exact, or ".suffix"); empty = any public host. */
  webhookAllowedHosts: string[];
  webhookTimeoutMs: number;
}

function int(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got "${raw}").`);
  return n;
}

function oneOf<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${raw}").`);
  return raw as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const tokens = env.BI_TOKENS ?? (production ? undefined : DEV_TOKENS);
  if (!tokens) throw new Error('BI_TOKENS must be set when NODE_ENV=production; the built-in dev tokens are disabled.');
  const snowflake = loadSnowflakeConfig(env);
  const store = oneOf(env.BI_STORE, ['memory', 'postgres', 'snowflake'] as const, env.DATABASE_URL ? 'postgres' : 'memory', 'BI_STORE');
  if (store === 'postgres' && !env.DATABASE_URL) throw new Error('BI_STORE=postgres needs DATABASE_URL.');
  const snowflakeApp = store === 'snowflake' ? loadSnowflakeAppStoreConfig(env, snowflake) : null;
  if (store === 'snowflake' && !snowflakeApp) {
    throw new Error('BI_STORE=snowflake needs SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, a password or private key, and SNOWFLAKE_APP_DATABASE.');
  }
  const uploads = oneOf(env.BI_UPLOADS, ['local', 'snowflake'] as const, store === 'snowflake' ? 'snowflake' : 'local', 'BI_UPLOADS');
  const snowflakeUploads =
    uploads === 'snowflake'
      ? loadSnowflakeUploadsConfig(env, snowflake, { database: snowflakeApp?.database, warehouse: snowflakeApp?.warehouse, role: snowflakeApp?.role })
      : null;
  if (uploads === 'snowflake' && !snowflakeUploads) {
    throw new Error('BI_UPLOADS=snowflake needs the Snowflake connection settings and SNOWFLAKE_UPLOADS_DATABASE (or SNOWFLAKE_APP_DATABASE).');
  }
  if (production && store === 'memory') throw new Error('NODE_ENV=production needs a durable store: set BI_STORE=snowflake or DATABASE_URL.');
  const provider = oneOf(env.BI_LLM_PROVIDER, ['anthropic', 'ollama'] as const, 'anthropic', 'BI_LLM_PROVIDER');
  if (production && provider === 'ollama') throw new Error('BI_LLM_PROVIDER=ollama is for local testing only; it is refused when NODE_ENV=production.');
  // "auto" turns the AI features on when their backend is available: Anthropic credentials, or a local Ollama.
  const llmAvailable = provider === 'ollama' || !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  return {
    port: Number(env.PORT ?? 4000),
    store,
    databaseUrl: env.DATABASE_URL || undefined,
    snowflakeApp,
    uploads,
    snowflakeUploads,
    tokens,
    corsOrigins: (env.BI_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    // Seed the examples into durable stores only when asked; the in-memory store always starts seeded.
    seed: env.BI_SEED === '1' || store === 'memory',
    seedTeam: env.BI_SEED_TEAM ?? 'team-a',
    queryTimeoutMs: Number(env.BI_QUERY_TIMEOUT_MS ?? 15_000),
    customSql: oneOf(env.BI_CUSTOM_SQL, ['on', 'off'] as const, 'on', 'BI_CUSTOM_SQL') === 'on',
    dataDir: env.BI_DATA_DIR || undefined,
    snowflake,
    llm: {
      provider,
      ollamaUrl: env.OLLAMA_URL || 'http://localhost:11434',
      ollamaModel: env.OLLAMA_MODEL || 'llama3.2',
      ollamaNumCtx: int(env.OLLAMA_NUM_CTX, 16_384, 'OLLAMA_NUM_CTX'),
    },
    ai: {
      // "auto": on when Anthropic credentials are present in the environment.
      enabled: (() => {
        const mode = oneOf(env.BI_AI, ['auto', 'on', 'off'] as const, 'auto', 'BI_AI');
        return mode === 'on' || (mode === 'auto' && llmAvailable);
      })(),
      model: env.BI_AI_MODEL || 'claude-opus-5-5',
      effort: oneOf(env.BI_AI_EFFORT, ['low', 'medium', 'high'] as const, 'low', 'BI_AI_EFFORT'),
      timeoutMs: int(env.BI_AI_TIMEOUT_MS, 20_000, 'BI_AI_TIMEOUT_MS'),
    },
    assistant: {
      // Follows the AI credentials like recommendations, unless set explicitly.
      enabled: (() => {
        const mode = oneOf(env.BI_ASSISTANT, ['auto', 'on', 'off'] as const, 'auto', 'BI_ASSISTANT');
        return mode === 'on' || (mode === 'auto' && llmAvailable);
      })(),
      model: env.BI_ASSISTANT_MODEL || 'claude-opus-5-5',
      effort: oneOf(env.BI_ASSISTANT_EFFORT, ['low', 'medium', 'high'] as const, 'medium', 'BI_ASSISTANT_EFFORT'),
      timeoutMs: int(env.BI_ASSISTANT_TIMEOUT_MS, 90_000, 'BI_ASSISTANT_TIMEOUT_MS'),
    },
    redisUrl: env.REDIS_URL || undefined,
    cacheTtlSeconds: int(env.BI_CACHE_TTL_S, 60, 'BI_CACHE_TTL_S'),
    cacheMaxEntries: int(env.BI_CACHE_MAX_ENTRIES, 2000, 'BI_CACHE_MAX_ENTRIES'),
    maxConcurrentQueries: int(env.BI_TEAM_MAX_CONCURRENT_QUERIES, 8, 'BI_TEAM_MAX_CONCURRENT_QUERIES'),
    maxQueuedQueries: int(env.BI_TEAM_MAX_QUEUED_QUERIES, 100, 'BI_TEAM_MAX_QUEUED_QUERIES'),
    rateLimits: {
      data: int(env.BI_RATE_LIMIT_DATA, 600, 'BI_RATE_LIMIT_DATA'),
      recommendations: int(env.BI_RATE_LIMIT_RECOMMENDATIONS, 20, 'BI_RATE_LIMIT_RECOMMENDATIONS'),
      uploads: int(env.BI_RATE_LIMIT_UPLOADS, 30, 'BI_RATE_LIMIT_UPLOADS'),
      writes: int(env.BI_RATE_LIMIT_WRITES, 120, 'BI_RATE_LIMIT_WRITES'),
      assistant: int(env.BI_RATE_LIMIT_ASSISTANT, 30, 'BI_RATE_LIMIT_ASSISTANT'),
    },
    logFormat: oneOf(env.BI_LOG, ['json', 'pretty', 'off'] as const, production ? 'json' : 'pretty', 'BI_LOG'),
    logLevel: oneOf(env.BI_LOG_LEVEL, ['debug', 'info', 'warn', 'error'] as const, 'info', 'BI_LOG_LEVEL'),
    metricsToken: env.BI_METRICS_TOKEN || undefined,
    // Explicit URL wins; otherwise links are built from an allowlisted request host (production).
    viewerUrl: env.BI_VIEWER_URL || (production || env.BI_PUBLIC_HOSTS ? undefined : 'http://localhost:5176'),
    publicHosts: (env.BI_PUBLIC_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    staticDir: env.BI_STATIC_DIR || undefined,
    examplesDir: env.BI_EXAMPLES_DIR || undefined,
    platform: {
      smtpUrl: env.SMTP_URL || undefined,
      smtpFrom: env.SMTP_FROM || 'Sratchpad <no-reply@sratchpad.invalid>',
      schedulerEnabled: oneOf(env.BI_SCHEDULER, ['on', 'off'] as const, 'on', 'BI_SCHEDULER') === 'on',
      schedulerIntervalMs: int(env.BI_SCHEDULER_INTERVAL_S, 60, 'BI_SCHEDULER_INTERVAL_S') * 1000 || 60_000,
      webhookAllowedHosts: (env.BI_WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
      webhookTimeoutMs: int(env.BI_WEBHOOK_TIMEOUT_MS, 5000, 'BI_WEBHOOK_TIMEOUT_MS') || 5000,
    },
  };
}
