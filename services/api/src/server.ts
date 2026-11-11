import { serve } from '@hono/node-server';
import { DashboardAssistant } from './ai/assistant';
import { ClaudeRanker } from './ai/ranker';
import { Recommender } from './ai/recommender';
import { createApp } from './app';
import { createWebApp } from './web';
import { StaticTokenVerifier } from './auth';
import { loadConfig } from './config';
import { createDataLayer } from './data';
import { MemoryResultCache, RedisResultCache, type ResultCache } from './data/cache';
import { QueryGate } from './guard/limits';
import { createLogger } from './obs/logger';
import { Metrics } from './obs/metrics';
import { PostgresFileSourceRegistry } from './data/files/postgres-registry';
import { seedExamples } from './seed';
import type { FileSourceRegistry } from './data/files/registry';
import { MemoryShareStore, PostgresShareStore, type ShareStore } from './sharing/store';
import { SnowflakeSqlClient } from './store/snowflake/client';
import { runSnowflakeMigrations } from './store/snowflake/schema';
import { createSnowflakeAppStores } from './store/snowflake/stores';
import { MemoryDashboardStore } from './store/memory';
import { SmtpMailer } from './platform/mailer';
import { Scheduler } from './platform/scheduler';
import { PlatformService } from './platform/service';
import { MemoryPlatformStore, PgSqlClient, SqlPlatformStore, type PlatformStore } from './platform/store';
import { HttpsWebhookSender } from './platform/webhook';
import type { QueryServices } from './data/run';
import { PostgresDashboardStore } from './store/postgres';
import type { DashboardStore } from './store/types';

const config = loadConfig();
const logger = createLogger({ format: config.logFormat, level: config.logLevel });
const metrics = new Metrics();
// The app's own records: Snowflake hybrid tables, Postgres, or memory (dev). Each durable store
// migrates its schema on boot; concurrent ECS tasks converge safely.
let store: DashboardStore;
let shares: ShareStore;
let fileRegistry: FileSourceRegistry | undefined;
let closeStores: () => Promise<unknown> = async () => {};
let platformStore: PlatformStore;
if (config.store === 'snowflake') {
  const db = new SnowflakeSqlClient(config.snowflake!, config.snowflakeApp!);
  const applied = await runSnowflakeMigrations(db);
  if (applied.length) logger.info('snowflake app store migrated', { applied });
  const stores = createSnowflakeAppStores(db);
  ({ dashboards: store, shares, files: fileRegistry } = stores);
  platformStore = new SqlPlatformStore(db); // same client and pool, closed with the stores
  closeStores = () => stores.close();
} else if (config.store === 'postgres') {
  const pgStore = await PostgresDashboardStore.connect(config.databaseUrl!);
  const pgShares = await PostgresShareStore.connect(config.databaseUrl!);
  const pgFiles = await PostgresFileSourceRegistry.connect(config.databaseUrl!, { migrate: false });
  store = pgStore;
  shares = pgShares;
  fileRegistry = pgFiles;
  // Migration 005_platform ran with the dashboard store above.
  const pgPlatform = new SqlPlatformStore(PgSqlClient.connect(config.databaseUrl!), true);
  platformStore = pgPlatform;
  closeStores = () => Promise.allSettled([pgStore.close(), pgShares.close(), pgFiles.close(), pgPlatform.close()]);
} else {
  platformStore = new MemoryPlatformStore();
  store = new MemoryDashboardStore();
  shares = new MemoryShareStore();
}
if (config.seed) await seedExamples(store, { teamId: config.seedTeam, ...(config.examplesDir ? { dir: config.examplesDir } : {}) });

// Without a durable store, upload metadata goes to a JSON manifest next to the Parquet files.
const data = createDataLayer({
  dataDir: config.dataDir,
  fileRegistry,
  snowflake: config.snowflake,
  snowflakeUploads: config.snowflakeUploads,
});

// Result cache: Redis when configured (shared by replicas); otherwise in-process. A Redis that is
// down at boot is not fatal: the API serves uncached instead.
let cache: ResultCache | undefined;
if (config.cacheTtlSeconds > 0) {
  if (config.redisUrl) {
    cache = await RedisResultCache.connect(config.redisUrl).catch((error: unknown) => {
      logger.warn('redis unavailable; using the in-process result cache', { error });
      return undefined;
    });
  }
  cache ??= new MemoryResultCache(config.cacheMaxEntries);
}

const recommender = new Recommender({
  ranker: config.ai.enabled ? new ClaudeRanker({ model: config.ai.model, effort: config.ai.effort, timeoutMs: config.ai.timeoutMs }) : null,
  rankTimeoutMs: config.ai.timeoutMs + 5000,
  onRankerError: (error) => logger.warn('AI ranking failed; served rule-based suggestions', { error }),
});


const assistant = config.assistant.enabled
  ? new DashboardAssistant({ sources: data.sources, model: config.assistant.model, effort: config.assistant.effort, timeoutMs: config.assistant.timeoutMs })
  : null;

// Shared by the data routes and the platform jobs (subscriptions, alerts, refresh, export).
const queryServices: QueryServices = { cache, cacheTtlSeconds: config.cacheTtlSeconds, gate: new QueryGate(config.maxConcurrentQueries, config.maxQueuedQueries) };

// Platform features: comments, favorites, usage, subscriptions, alerts, refresh, metric catalog.
const viewerBaseUrl = config.viewerUrl ?? (config.publicHosts[0] ? `https://${config.publicHosts[0]}/view/` : undefined);
const platformService = new PlatformService({
  store: platformStore,
  dashboards: store,
  shares,
  engines: data.engines,
  queryServices,
  queryTimeoutMs: config.queryTimeoutMs,
  mailer: config.platform.smtpUrl ? new SmtpMailer(config.platform.smtpUrl, config.platform.smtpFrom) : null,
  webhooks: new HttpsWebhookSender({ allowedHosts: config.platform.webhookAllowedHosts, timeoutMs: config.platform.webhookTimeoutMs }),
  viewerBaseUrl,
  logger,
});
queryServices.metricCatalog = platformService.metricCatalog;
const scheduler = config.platform.schedulerEnabled
  ? new Scheduler({ store: platformStore, service: platformService, logger, intervalMs: config.platform.schedulerIntervalMs })
  : null;

const app = createApp({
  store,
  auth: StaticTokenVerifier.parse(config.tokens),
  engines: data.engines,
  sources: data.sources,
  corsOrigins: config.corsOrigins,
  queryTimeoutMs: config.queryTimeoutMs,
  recommender,
  assistant,
  queryServices,
  platform: {
    service: platformService,
    onDashboardView: (principal, id) => platformService.recordView(principal, id),
    schedulerEnabled: Boolean(scheduler),
    webhookAllowedHosts: config.platform.webhookAllowedHosts,
  },
  metrics,
  logger,
  rateLimits: config.rateLimits,
  metricsToken: config.metricsToken,
  shares,
  viewerUrl: config.viewerUrl,
  publicHosts: config.publicHosts,
  // The frontends call /bi-api/…; in the single container they reach the API under that prefix.
  pathPrefix: config.staticDir ? '/bi-api' : undefined,
});

// Production: one process serves the Studio, the viewer and the API (see web.ts). Dev: the API alone;
// Vite serves the frontends and proxies /bi-api here.
const handler = config.staticDir ? createWebApp({ api: app, staticDir: config.staticDir }) : app;

const server = serve({ fetch: handler.fetch, port: config.port }, (info) => {
  logger.info(`sratchpad listening on http://localhost:${info.port}`, {
    serving: config.staticDir ? 'studio + viewer + api' : 'api',
    store: config.store,
    snowflake: config.snowflake ? 'configured' : 'off',
    uploads: config.uploads,
    ai: config.ai.enabled ? config.ai.model : 'rules only',
    assistant: assistant ? config.assistant.model : 'off',
    email: config.platform.smtpUrl ? 'smtp' : 'off',
    scheduler: scheduler ? 'on' : 'off',
    cache: config.cacheTtlSeconds > 0 ? (cache instanceof RedisResultCache ? 'redis' : 'memory') : 'off',
  });
});

scheduler?.start();

const shutdown = async () => {
  server.close();
  await scheduler?.stop();
  await Promise.allSettled([closeStores(), data.close(), cache?.close?.()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
