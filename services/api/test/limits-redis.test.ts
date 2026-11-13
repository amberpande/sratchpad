import { describe, expect, it } from 'vitest';
import { RedisRateLimiter, type RedisCounter } from '../src/guard/limits';

// Global rate limits (D-076) against an in-memory stand-in for Redis INCR/PEXPIRE shared by "replicas".
function fakeRedis(fail = false): RedisCounter & { store: Map<string, number> } {
  const store = new Map<string, number>();
  return {
    store,
    async incr(k) {
      if (fail) throw new Error('down');
      const v = (store.get(k) ?? 0) + 1;
      store.set(k, v);
      return v;
    },
    async pexpire() {
      return 1;
    },
  };
}

describe('RedisRateLimiter', () => {
  it('counts one budget across replicas and tells when to retry', async () => {
    const redis = fakeRedis();
    let t = 60_000 * 1000 + 15_000;
    const a = new RedisRateLimiter(redis, 'data', 3, () => t);
    const b = new RedisRateLimiter(redis, 'data', 3, () => t);
    expect(await a.take('team-a')).toBe(0);
    expect(await b.take('team-a')).toBe(0);
    expect(await a.take('team-a')).toBe(0);
    expect(await b.take('team-a')).toBe(45); // 4th in this minute: wait for the next window
    expect(await b.take('team-b')).toBe(0); // other teams have their own budget
    t += 45_000;
    expect(await a.take('team-a')).toBe(0);
  });

  it('falls back to the in-process limit when Redis is down', async () => {
    const l = new RedisRateLimiter(fakeRedis(true), 'data', 2, () => 0);
    expect(await l.take('x')).toBe(0);
    expect(await l.take('x')).toBe(0);
    expect(await l.take('x')).toBeGreaterThan(0);
  });
});
