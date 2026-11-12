import { describe, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, MemoryShareStore, StaticTokenVerifier } from '../src';
import { MemoryPlatformStore } from '../src/platform/store';
import { PlatformService } from '../src/platform/service';

// Platform writes share the per-team "writes" budget; reads are not limited.
describe('platform routes and per-team rate limits', () => {
  it('limits comment writes, not reads', async () => {
    const now = () => new Date('2026-11-12T07:00:00Z');
    const store = new MemoryDashboardStore();
    const shares = new MemoryShareStore();
    const service = new PlatformService({
      store: new MemoryPlatformStore(),
      dashboards: store,
      shares,
      engines: defaultEngines(now),
      queryServices: {},
      queryTimeoutMs: 15_000,
      mailer: null,
      webhooks: { send: async () => ({ ok: true, status: 200 }) },
      viewerBaseUrl: 'https://sratchpad.example.com/view/',
      now,
    });
    const app = createApp({
      store,
      shares,
      auth: StaticTokenVerifier.parse(DEV_TOKENS),
      engines: defaultEngines(now),
      now,
      rateLimits: { writes: 2 },
      platform: { service, onDashboardView: (p, id) => service.recordView(p, id), schedulerEnabled: false },
    });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { Authorization: 'Bearer dev-token-team-a', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

    expect((await call('PUT', '/v1/dashboards/dash_9f2a', { spec: salesOverview })).status).toBe(201); // write 1
    expect((await call('POST', '/v1/dashboards/dash_9f2a/comments', { body: 'first' })).status).toBe(201); // write 2
    const limited = await call('POST', '/v1/dashboards/dash_9f2a/comments', { body: 'second' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    for (let i = 0; i < 3; i++) expect((await call('GET', '/v1/dashboards/dash_9f2a/comments')).status).toBe(200);
    // Both the collection and item paths are covered, each charged once.
    expect((await call('PUT', '/v1/favorites/dash_9f2a')).status).toBe(429);
  });
});
