import type { CreateShareResponse, DataResponseLine, Share, ShareIntrospection, StoredDashboard } from '@yourorg/bi-spec';
import { beforeEach, describe, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import opsMix from '../../../examples/dashboards/ops_mix.json';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, MemoryShareStore, StaticTokenVerifier, type App } from '../src';

const EDITOR = 'dev-token-team-a';
const VIEWER = 'dev-token-team-a-viewer';
const OTHER_TEAM = 'dev-token-team-b';

let clock: Date;
let app: App;
let shares: MemoryShareStore;

function call(method: string, path: string, { token = EDITOR as string | null, body }: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function share(body: unknown, id = 'dash_9f2a', token = EDITOR) {
  const res = await call('POST', `/v1/dashboards/${id}/shares`, { body, token });
  return { res, json: res.status === 201 ? ((await res.json()) as CreateShareResponse) : null };
}

async function data(token: string, body: unknown, id = 'dash_9f2a') {
  const res = await call('POST', `/v1/dashboards/${id}/data`, { token, body });
  const lines = res.ok ? (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as DataResponseLine) : [];
  return { res, lines };
}

async function save(spec: unknown, token = EDITOR) {
  const id = (spec as { id: string }).id;
  const res = await call('PUT', `/v1/dashboards/${id}`, { token, body: { spec } });
  expect(res.status).toBeLessThan(300);
}

beforeEach(async () => {
  clock = new Date('2026-11-09T15:30:00Z');
  shares = new MemoryShareStore();
  app = createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: defaultEngines(() => clock),
    now: () => clock,
    shares,
    viewerUrl: 'https://bi.example.com/view/',
  });
  await save(salesOverview);
  await save(opsMix);
});

describe('creating shares', () => {
  it('returns the token once, a viewer link for viewers, and stores only a hash', async () => {
    const { res, json } = await share({ audience: 'viewer', label: 'Exec team', expiresInDays: 30 });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(json!.token).toMatch(/^bis_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(json!.viewerUrl).toBe(`https://bi.example.com/view/#token=${json!.token}`);
    expect(json!.share).toMatchObject({ dashboardId: 'dash_9f2a', audience: 'viewer', label: 'Exec team', createdBy: 'dev-a', expiresAt: '2026-12-09T15:30:00.000Z' });
    expect(json!.share).not.toHaveProperty('secretHash');
    expect(json!.share).not.toHaveProperty('teamId');
    const stored = await shares.get(json!.share.id);
    expect(stored!.secretHash).toMatch(/^[0-9a-f]{64}$/);
    // The secret is everything after "bis_<id>_" (it may itself contain "_").
    const secret = json!.token.slice(`bis_${json!.share.id}_`.length);
    expect(secret).toHaveLength(43);
    expect(JSON.stringify(stored)).not.toContain(secret);

    const app2 = (await share({ audience: 'app' })).json!;
    expect(app2.viewerUrl).toBeUndefined();
    expect(app2.share.label).toBe('Application access');

    const list = (await (await call('GET', '/v1/dashboards/dash_9f2a/shares')).json()) as { shares: Share[] };
    expect(list.shares.map((s) => s.audience)).toEqual(expect.arrayContaining(['viewer', 'app']));
    expect(JSON.stringify(list)).not.toContain('bis_');
  });

  it('validates input and the dashboard/version', async () => {
    expect((await share({})).res.status).toBe(400);
    expect((await share({ audience: 'everyone' })).res.status).toBe(400);
    expect((await share({ audience: 'app', expiresInDays: 0 })).res.status).toBe(400);
    expect((await share({ audience: 'app', expiresInDays: 1.5 })).res.status).toBe(400);
    expect((await share({ audience: 'app', label: 'x'.repeat(101) })).res.status).toBe(400);
    expect((await share({ audience: 'app', version: 9 })).res.status).toBe(404);
    expect((await share({ audience: 'app' }, 'dash_missing')).res.status).toBe(404);
  });

  it('only editors of the owning team can create, list or revoke', async () => {
    expect((await share({ audience: 'app' }, 'dash_9f2a', VIEWER)).res.status).toBe(403);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/shares', { token: VIEWER })).status).toBe(403);
    // Another team sees nothing to share.
    expect((await share({ audience: 'app' }, 'dash_9f2a', OTHER_TEAM)).res.status).toBe(404);
    const { json } = await share({ audience: 'app' });
    expect((await call('DELETE', `/v1/dashboards/dash_9f2a/shares/${json!.share.id}`, { token: OTHER_TEAM })).status).toBe(404);
    expect((await call('DELETE', `/v1/dashboards/dash_9f2a/shares/${json!.share.id}`, { token: VIEWER })).status).toBe(403);
  });

  it('answers 503 when sharing is not configured', async () => {
    app = createApp({ store: new MemoryDashboardStore(), auth: StaticTokenVerifier.parse(DEV_TOKENS), engines: defaultEngines() });
    await save(salesOverview);
    expect((await share({ audience: 'app' })).res.status).toBe(503);
  });
});

describe('using a share token', () => {
  let token: string;
  beforeEach(async () => {
    token = (await share({ audience: 'app' })).json!.token;
  });

  it('reads the dashboard JSON and runs its saved queries', async () => {
    const res = await call('GET', '/v1/dashboards/dash_9f2a', { token });
    expect(res.status).toBe(200);
    const stored = (await res.json()) as StoredDashboard;
    expect(stored.spec).toEqual(salesOverview);
    const { res: dres, lines } = await data(token, { queries: ['q_totals', 'q_rev_by_month'], params: { dateRange: 'last_90d' } });
    expect(dres.status).toBe(200);
    expect(lines.every((l) => l.ok)).toBe(true);
    // Listing shows only the shared dashboard.
    expect(await (await call('GET', '/v1/dashboards', { token })).json()).toMatchObject({ dashboards: [{ id: 'dash_9f2a' }] });
    // Introspection: the token alone tells a viewer what to open.
    const intro = (await (await call('GET', '/v1/share', { token })).json()) as ShareIntrospection;
    expect(intro).toMatchObject({ share: { dashboardId: 'dash_9f2a', audience: 'app' }, dashboard: { id: 'dash_9f2a', title: 'Sales overview', latestVersion: 1 } });
    expect((await shares.get(intro.share.id))!.lastUsedAt).toBe(clock.toISOString());
  });

  it('is confined to its dashboard and to reading', async () => {
    expect((await call('GET', '/v1/dashboards/ops_mix', { token })).status).toBe(404);
    expect((await data(token, { queries: ['q_totals'] }, 'ops_mix')).res.status).toBe(404);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/versions', { token })).status).toBe(403);
    expect((await call('PUT', '/v1/dashboards/dash_9f2a', { token, body: { spec: salesOverview } })).status).toBe(403);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/shares', { token })).status).toBe(403);
    expect((await call('POST', '/v1/dashboards/dash_9f2a/shares', { token, body: { audience: 'app' } })).status).toBe(403);
    expect((await call('GET', '/v1/sources', { token })).status).toBe(403);
    expect((await call('POST', '/v1/preview/data', { token, body: { spec: salesOverview, queries: ['q_totals'] } })).status).toBe(403);
    expect((await call('POST', '/v1/recommendations', { token, body: { source: { type: 'sample', ref: 'orders' } } })).status).toBe(403);
    // Queries are named, never sent, so the token can only run what the author saved.
    const { lines } = await data(token, { queries: ['q_not_there'] });
    expect(lines[0]).toMatchObject({ ok: false, error: { code: 'unknown_query' } });
  });

  it('follows the latest version unless pinned', async () => {
    const edited = { ...salesOverview, title: 'Sales overview v2' };
    await save(edited);
    const pinned = (await share({ audience: 'viewer', version: 1 })).json!.token;
    expect(((await (await call('GET', '/v1/dashboards/dash_9f2a', { token })).json()) as StoredDashboard).version).toBe(2);
    const p = (await (await call('GET', '/v1/dashboards/dash_9f2a', { token: pinned })).json()) as StoredDashboard;
    expect(p).toMatchObject({ version: 1, title: 'Sales overview' });
    expect((await call('GET', '/v1/dashboards/dash_9f2a?version=2', { token: pinned })).status).toBe(404);
    expect((await data(pinned, { queries: ['q_totals'], version: 2 })).res.status).toBe(404);
    expect((await data(pinned, { queries: ['q_totals'] })).res.headers.get('X-Dashboard-Version')).toBe('1');
  });

  it('stops working when revoked, expired or tampered with', async () => {
    const created = (await share({ audience: 'viewer', expiresInDays: 1 })).json!;
    expect((await call('GET', '/v1/share', { token: created.token })).status).toBe(200);

    clock = new Date(clock.getTime() + 86_400_000 + 1);
    expect((await call('GET', '/v1/share', { token: created.token })).status).toBe(401);

    const revocable = (await share({ audience: 'app' })).json!;
    expect((await call('DELETE', `/v1/dashboards/dash_9f2a/shares/${revocable.share.id}`)).status).toBe(204);
    expect((await call('DELETE', `/v1/dashboards/dash_9f2a/shares/${revocable.share.id}`)).status).toBe(204); // idempotent
    expect((await call('GET', '/v1/dashboards/dash_9f2a', { token: revocable.token })).status).toBe(401);

    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect((await call('GET', '/v1/dashboards/dash_9f2a', { token: flipped })).status).toBe(401);
    expect((await call('GET', '/v1/dashboards/dash_9f2a', { token: 'bis_nope' })).status).toBe(401);
    // The original, untouched token still works.
    expect((await call('GET', '/v1/dashboards/dash_9f2a', { token })).status).toBe(200);
  });

  it('/v1/share is only for share tokens', async () => {
    expect((await call('GET', '/v1/share')).status).toBe(400);
  });
});

describe('team viewer role', () => {
  it('reads and runs dashboards but cannot author', async () => {
    expect((await call('GET', '/v1/dashboards', { token: VIEWER })).status).toBe(200);
    expect((await call('GET', '/v1/dashboards/ops_mix', { token: VIEWER })).status).toBe(200);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/versions', { token: VIEWER })).status).toBe(200);
    expect((await data(VIEWER, { queries: ['q_totals'] })).res.status).toBe(200);
    const forbidden = await call('PUT', '/v1/dashboards/dash_9f2a', { token: VIEWER, body: { spec: salesOverview } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await call('GET', '/v1/sources', { token: VIEWER })).status).toBe(403);
    expect((await call('POST', '/v1/recommendations', { token: VIEWER, body: { source: { type: 'sample', ref: 'orders' } } })).status).toBe(403);
  });

  it('parses roles from token config', () => {
    expect(() => StaticTokenVerifier.parse('t:team:me:admin')).toThrow(/Bad role/);
  });
});
