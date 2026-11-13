import { createHash } from 'node:crypto';
import { stableStringify, type DataSource, type Query, type QueryResult } from '@yourorg/bi-spec';
import type { Redis } from 'ioredis';

/**
 * Server-side result cache, keyed on (team, source, fully resolved semantic query). Params are
 * already applied to the query, so a different date range is a different key, and relative presets
 * ("last_30d") roll over with the date. The team is part of the key so a cached result never
 * bypasses an engine's per-team visibility checks (uploads, Snowflake roles).
 *
 * Results keep the `asOf` of the original read and come back with `cached: true`, so widgets can say
 * how fresh the numbers are.
 */

export interface ResultCache {
  get(key: string): Promise<QueryResult | undefined>;
  set(key: string, result: QueryResult, ttlSeconds: number): Promise<void>;
  close?(): Promise<void>;
}

export function resultCacheKey(teamId: string, source: DataSource, query: Query): string {
  const digest = createHash('sha256').update(stableStringify({ teamId, source: { type: source.type, ref: source.ref }, query })).digest('base64url');
  return `bi:q:v1:${digest}`;
}

/** In-process LRU with per-entry expiry. Bounded by entry count. */
export class MemoryResultCache implements ResultCache {
  private readonly entries = new Map<string, { expires: number; result: QueryResult }>();

  constructor(
    private readonly maxEntries = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<QueryResult | undefined> {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, e);
    return structuredClone(e.result);
  }

  async set(key: string, result: QueryResult, ttlSeconds: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { expires: this.now() + ttlSeconds * 1000, result: structuredClone(result) });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Shared cache across API replicas. Values are JSON with a Redis-side TTL. */
export class RedisResultCache implements ResultCache {
  constructor(readonly redis: Redis) {}

  static async connect(url: string): Promise<RedisResultCache> {
    const { Redis } = await import('ioredis');
    // Fail fast instead of queueing commands while Redis is down; the cache is optional.
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000 });
    await redis.connect();
    return new RedisResultCache(redis);
  }

  async get(key: string): Promise<QueryResult | undefined> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as QueryResult) : undefined;
  }

  async set(key: string, result: QueryResult, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(result), 'EX', Math.max(1, Math.round(ttlSeconds)));
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
