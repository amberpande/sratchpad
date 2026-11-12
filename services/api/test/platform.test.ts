import { describe, expect, it, vi } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, MemoryShareStore, StaticTokenVerifier, verifyShareToken } from '../src';
import type { MailMessage, Mailer } from '../src/platform/mailer';
import { nextRun, validateSchedule, zonedTimeToUtc } from '../src/platform/schedule';
import { Scheduler } from '../src/platform/scheduler';
import { conditionMet, PlatformService, reduceValue, toCsv, type Alert, type Subscription } from '../src/platform/service';
import { MemoryPlatformStore } from '../src/platform/store';
import { hostAllowed, isBlockedAddress, safeLookup, signPayload, validateWebhookUrl, type WebhookSender } from '../src/platform/webhook';

const EDITOR = 'dev-token-team-a';
const VIEWER = 'dev-token-team-a-viewer';
const OTHER = 'dev-token-team-b';

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  async send(m: MailMessage) {
    this.sent.push(m);
  }
}

function setup(opts: { mailer?: Mailer | null; webhooks?: WebhookSender; rls?: Record<string, Array<{ field: string; attribute: string }>> } = {}) {
  let clock = new Date('2026-11-10T07:00:00Z');
  const now = () => clock;
  const store = new MemoryDashboardStore();
  const shares = new MemoryShareStore();
  const platformStore = new MemoryPlatformStore();
  const mailer = opts.mailer === undefined ? new FakeMailer() : opts.mailer;
  const webhooks = opts.webhooks ?? { send: vi.fn(async () => ({ ok: true, status: 200 })) };
  const service = new PlatformService({
    store: platformStore,
    dashboards: store,
    shares,
    engines: defaultEngines(now),
    queryServices: opts.rls ? { rls: opts.rls } : {},
    queryTimeoutMs: 15_000,
    mailer,
    webhooks,
    viewerBaseUrl: 'https://sratchpad.example.com/view/',
    now,
  });
  const app = createApp({
    store,
    shares,
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: defaultEngines(now),
    now,
    platform: { service, onDashboardView: (p, id) => service.recordView(p, id), schedulerEnabled: true },
  });
  const call = async (method: string, path: string, { token = EDITOR, body }: { token?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json: json as Record<string, unknown>, text, headers: res.headers };
  };
  return { app, call, service, platformStore, shares, mailer, webhooks, setClock: (d: Date) => (clock = d), now };
}

async function seeded(opts?: Parameters<typeof setup>[0]) {
  const s = setup(opts);
  expect((await s.call('PUT', '/v1/dashboards/dash_9f2a', { body: { spec: salesOverview } })).status).toBe(201);
  return s;
}

describe('platform routes', () => {
  it('reports who you are and what is configured', async () => {
    const { call } = setup();
    expect((await call('GET', '/v1/platform', { token: VIEWER })).json).toEqual({ me: { subject: 'viewer-a', teamId: 'team-a', role: 'viewer' }, email: true, scheduler: true });
  });

  it('comments: viewers and editors write; authors edit own; editors moderate; teams isolated', async () => {
    const { call } = await seeded();
    const created = await call('POST', '/v1/dashboards/dash_9f2a/comments', { token: VIEWER, body: { body: 'Why did EU dip?', widgetId: 'w_region' } });
    expect(created.status).toBe(201);
    const id = (created.json.comment as { id: string }).id;
    const enc = encodeURIComponent(id);
    expect((await call('PATCH', `/v1/dashboards/dash_9f2a/comments/${enc}`, { body: { body: 'hijack' } })).status).toBe(403);
    expect((await call('PATCH', `/v1/dashboards/dash_9f2a/comments/${enc}`, { token: VIEWER, body: { body: 'Why did Europe dip?' } })).json.comment).toMatchObject({ body: 'Why did Europe dip?', author: 'viewer-a' });
    const list = await call('GET', '/v1/dashboards/dash_9f2a/comments');
    expect(list.json.comments).toMatchObject([{ widgetId: 'w_region', author: 'viewer-a' }]);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/comments', { token: OTHER })).status).toBe(404);
    expect((await call('POST', '/v1/dashboards/dash_9f2a/comments', { token: OTHER, body: { body: 'x' } })).status).toBe(404);
    expect((await call('DELETE', `/v1/dashboards/dash_9f2a/comments/${enc}`)).status).toBe(204); // editor moderation
    expect((await call('POST', '/v1/dashboards/dash_9f2a/comments', { body: { body: '' } })).status).toBe(400);
  });

  it('share tokens cannot use platform routes', async () => {
    const { call } = await seeded();
    const token = ((await call('POST', '/v1/dashboards/dash_9f2a/shares', { body: { audience: 'app' } })).json as { token: string }).token;
    expect((await call('GET', '/v1/dashboards/dash_9f2a/comments', { token })).status).toBe(403);
    expect((await call('GET', '/v1/favorites', { token })).status).toBe(403);
  });

  it('favorites are personal; usage counts views and recent views per user', async () => {
    const { call } = await seeded();
    expect((await call('PUT', '/v1/favorites/dash_9f2a', { token: VIEWER })).status).toBe(204);
    expect((await call('PUT', '/v1/favorites/nope', { token: VIEWER })).status).toBe(404);
    expect((await call('GET', '/v1/favorites', { token: VIEWER })).json).toEqual({ dashboards: ['dash_9f2a'] });
    expect((await call('GET', '/v1/favorites')).json).toEqual({ dashboards: [] });
    await call('GET', '/v1/dashboards/dash_9f2a', { token: VIEWER });
    await call('GET', '/v1/dashboards/dash_9f2a');
    await new Promise((r) => setTimeout(r, 10)); // views are recorded off the read path
    const usage = (await call('GET', '/v1/usage', { token: VIEWER })).json as { dashboards: Array<{ dashboardId: string; views: number; myLastViewedAt?: string }> };
    expect(usage.dashboards).toEqual([{ dashboardId: 'dash_9f2a', views: 2, lastViewedDay: '2026-11-10', myLastViewedAt: '2026-11-10T07:00:00.000Z' }]);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/usage')).json).toMatchObject({ total: 2, series: [{ day: '2026-11-10', views: 2 }] });
    expect(((await call('GET', '/v1/usage', { token: OTHER })).json as { dashboards: unknown[] }).dashboards).toEqual([]);
  });

  it('exports one saved query as CSV for any team member, with params', async () => {
    const { call } = await seeded();
    const res = await call('GET', `/v1/dashboards/dash_9f2a/export?query=q_rev_by_region&params=${encodeURIComponent(JSON.stringify({ dateRange: 'last_30d' }))}`, { token: VIEWER });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="dash_9f2a-q_rev_by_region.csv"');
    expect(res.text.split('\r\n')[0]).toBe('region,revenue');
    expect((await call('GET', '/v1/dashboards/dash_9f2a/export?query=q_nope')).status).toBe(404);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/export?query=q_totals&params={bad')).status).toBe(400);
    expect((await call('GET', '/v1/dashboards/dash_9f2a/export?query=q_totals', { token: OTHER })).status).toBe(404);
  });

  it('subscriptions, alerts, refresh and catalog edits are editor-only', async () => {
    const { call } = await seeded();
    const schedule = { frequency: 'daily', time: '08:00', timezone: 'Europe/Berlin' };
    const sub = { dashboardId: 'dash_9f2a', name: 'Daily', recipients: ['a@example.com'], schedule, widgets: ['w_region'] };
    expect((await call('POST', '/v1/subscriptions', { token: VIEWER, body: sub })).status).toBe(403);
    expect((await call('POST', '/v1/subscriptions', { body: { ...sub, schedule: { ...schedule, timezone: 'Mars/Base' } } })).status).toBe(400);
    expect((await call('POST', '/v1/subscriptions', { body: { ...sub, widgets: ['w_missing'] } })).status).toBe(422);
    const created = await call('POST', '/v1/subscriptions', { body: sub });
    expect(created.status).toBe(201);
    expect(created.json.subscription).toMatchObject({ owner: 'dev-a', nextRunAt: '2026-11-11T07:00:00.000Z' }); // 08:00 CET
    expect(((await call('GET', '/v1/subscriptions', { token: OTHER })).json as { subscriptions: unknown[] }).subscriptions).toEqual([]);

    const alert = { dashboardId: 'dash_9f2a', name: 'Big revenue', queryId: 'q_totals', field: 'orders', op: 'gt', threshold: 1, webhookUrl: 'https://hooks.example.com/x' };
    expect((await call('POST', '/v1/alerts', { body: { ...alert, webhookUrl: 'http://hooks.example.com/x' } })).status).toBe(422);
    expect((await call('POST', '/v1/alerts', { body: { ...alert, webhookUrl: 'https://127.0.0.1/x' } })).status).toBe(422);
    const a = await call('POST', '/v1/alerts', { body: alert });
    expect(a.status).toBe(201);
    expect(typeof a.json.webhookSecret).toBe('string');
    const listed = (await call('GET', '/v1/alerts')).json as { alerts: Array<Record<string, unknown>> };
    expect(listed.alerts[0]).toMatchObject({ webhookSecretSet: true });
    expect(listed.alerts[0]).not.toHaveProperty('webhookSecret');

    expect((await call('PUT', '/v1/dashboards/dash_9f2a/refresh', { token: VIEWER, body: { intervalMinutes: 30 } })).status).toBe(403);
    expect((await call('PUT', '/v1/dashboards/dash_9f2a/refresh', { body: { intervalMinutes: 30 } })).status).toBe(200);

    expect((await call('PUT', '/v1/metrics-catalog/revenue', { token: VIEWER, body: { label: 'Revenue' } })).status).toBe(403);
    expect((await call('PUT', '/v1/metrics-catalog/9bad', { body: {} })).status).toBe(400);
  });

  it('metric catalog: editors define metrics validated by the query layer; the team reads them', async () => {
    const { call, service } = await seeded();
    const bad = await call('PUT', '/v1/metrics-catalog/revenue', { body: { field: 'amount', agg: 'median_ish' } });
    expect(bad.status).toBe(422);
    expect((await call('PUT', '/v1/metrics-catalog/revenue', { body: { label: 'Revenue', field: 'amount', agg: 'sum', format: 'currency' } })).status).toBe(200);
    expect((await call('GET', '/v1/metrics-catalog', { token: VIEWER })).json).toEqual({ metrics: [{ name: 'revenue', label: 'Revenue', field: 'amount', agg: 'sum', format: 'currency' }] });
    expect((await call('GET', '/v1/metrics-catalog', { token: OTHER })).json).toEqual({ metrics: [] });
    expect(await service.metricCatalog.get('team-a')).toHaveLength(1);
    expect((await call('DELETE', '/v1/metrics-catalog/revenue')).status).toBe(204);
  });
});

describe('subscriptions', () => {
  const schedule = { frequency: 'daily' as const, time: '08:00', timezone: 'Europe/Berlin' };

  it('emails KPIs, a fresh viewer link (revoking the previous one) and CSV attachments', async () => {
    const s = await seeded();
    const sub = await s.service.createSubscription({ teamId: 'team-a', subject: 'dev-a', role: 'editor' }, { dashboardId: 'dash_9f2a', name: 'Daily', recipients: ['a@example.com'], schedule, widgets: ['w_region'], includeKpis: true });
    const first = await s.service.runSubscription('team-a', sub, { reschedule: true });
    const mail = (s.mailer as FakeMailer).sent[0]!;
    expect(first.lastRun).toMatchObject({ status: 'sent' });
    expect(mail.to).toEqual(['a@example.com']);
    expect(mail.text).toMatch(/Total revenue: [\d,]+/);
    expect(mail.attachments![0]).toMatchObject({ filename: 'Revenue_by_region.csv', contentType: 'text/csv' });
    const token = /#token=(bis_\S+)/.exec(mail.text)![1]!;
    const share = await verifyShareToken(s.shares, token, s.now());
    expect(share).toMatchObject({ audience: 'viewer', dashboardId: 'dash_9f2a', expiresAt: '2026-11-13T07:00:00.000Z' });

    const second = await s.service.runSubscription('team-a', first, { reschedule: true });
    expect(second.shareId).not.toBe(first.shareId);
    expect(await verifyShareToken(s.shares, token, s.now())).toBeNull(); // previous link revoked
    expect(second.nextRunAt).toBe('2026-11-11T07:00:00.000Z');
  });

  it('records "email not configured" instead of failing without SMTP', async () => {
    const s = await seeded({ mailer: null });
    const sub = await s.service.createSubscription({ teamId: 'team-a', subject: 'dev-a' }, { dashboardId: 'dash_9f2a', name: 'Daily', recipients: ['a@example.com'], schedule, widgets: [], includeKpis: true });
    const ran = await s.service.runSubscription('team-a', sub, { reschedule: false });
    expect(ran.lastRun).toMatchObject({ status: 'not_delivered', message: expect.stringMatching(/SMTP_URL/) });
  });
});

describe('alerts', () => {
  it('fires once on the transition, emails and calls the webhook, then stays quiet until it recovers', async () => {
    const send = vi.fn(async () => ({ ok: true, status: 200 }));
    const s = await seeded({ webhooks: { send } });
    const alert = await s.service.createAlert({ teamId: 'team-a', subject: 'dev-a' }, {
      dashboardId: 'dash_9f2a', name: 'Orders', queryId: 'q_totals', field: 'orders', reduce: 'sum', op: 'gt', threshold: 1, intervalMinutes: 15,
      recipients: ['ops@example.com'], webhookUrl: 'https://hooks.example.com/x',
    });
    const fired = await s.service.evaluateAlert('team-a', alert);
    expect(fired).toMatchObject({ state: 'firing', lastFiredAt: '2026-11-10T07:00:00.000Z', nextRunAt: '2026-11-10T07:15:00.000Z' });
    expect((s.mailer as FakeMailer).sent).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, payload, secret] = send.mock.calls[0] as unknown as [string, Record<string, unknown>, string];
    expect(url).toBe('https://hooks.example.com/x');
    expect(payload).toMatchObject({ type: 'alert.fired', field: 'orders', op: 'gt', threshold: 1 });
    expect(secret).toBe(alert.webhookSecret);
    await s.service.evaluateAlert('team-a', fired);
    expect(send).toHaveBeenCalledTimes(1); // still firing: no repeat
  });

  it('change_pct compares with the previous value; reduce and conditions', () => {
    expect(conditionMet('change_pct', 10, 120, 100)).toBe(true);
    expect(conditionMet('change_pct', 30, 120, 100)).toBe(false);
    expect(conditionMet('change_pct', 10, 120, undefined)).toBe(false);
    expect(conditionMet('lte', 5, null, 1)).toBe(false);
    const rows = [{ v: 1 }, { v: 3 }, { v: null }];
    expect([reduceValue(rows, 'v', 'sum'), reduceValue(rows, 'v', 'avg'), reduceValue(rows, 'v', 'last'), reduceValue(rows, 'v', 'count')]).toEqual([4, 2, 3, 3]);
  });
});

describe('row-level security in jobs', () => {
  it('alerts and refresh run as their owner with the owner’s attributes; none means denied', async () => {
    const s = await seeded({ rls: { 'team-a': [{ field: 'region', attribute: 'region' }] } });
    const make = (attributes?: Record<string, string[]>) =>
      s.service.createAlert({ teamId: 'team-a', subject: 'dev-a', role: 'editor', ...(attributes ? { attributes } : {}) }, {
        dashboardId: 'dash_9f2a', name: 'EU', queryId: 'q_rev_by_region', field: 'revenue', reduce: 'count', op: 'gt', threshold: 100, intervalMinutes: 15, recipients: ['a@example.com'],
      });
    const eu = await s.service.evaluateAlert('team-a', await make({ region: ['Europe'] }));
    expect(eu.lastError).toBeUndefined();
    expect(eu.lastValue).toBe(1); // one region row: only Europe is visible to this owner
    const none = await s.service.evaluateAlert('team-a', await make());
    expect(none.lastError).toMatch(/rls_denied/);
    await s.service.setRefresh({ teamId: 'team-a', subject: 'dev-a', role: 'editor', attributes: { region: ['*'] } }, 'dash_9f2a', 30);
    const [r] = await s.service.listRefresh('team-a');
    expect((await s.service.runRefresh('team-a', r!)).lastRun).toMatchObject({ status: 'ok' });
  });
});

describe('scheduler', () => {
  it('only the lease holder runs due jobs; another task takes over after the lease expires', async () => {
    const s = await seeded();
    const sub: Subscription = await s.service.createSubscription({ teamId: 'team-a', subject: 'dev-a' }, { dashboardId: 'dash_9f2a', name: 'D', recipients: ['a@example.com'], schedule: { frequency: 'daily', time: '08:00', timezone: 'UTC' }, widgets: [], includeKpis: false });
    const a = new Scheduler({ store: s.platformStore, service: s.service, now: s.now, holder: 'task-a', intervalMs: 60_000 });
    const b = new Scheduler({ store: s.platformStore, service: s.service, now: s.now, holder: 'task-b', intervalMs: 60_000 });
    s.setClock(new Date('2026-11-10T07:58:30Z'));
    expect(await a.tick()).toMatchObject({ leader: true, subscriptions: 0 }); // not due yet (08:00 UTC)
    s.setClock(new Date('2026-11-10T07:59:30Z'));
    expect(await b.tick()).toMatchObject({ leader: false }); // a's lease (3 ticks) is still live
    expect(await a.tick()).toMatchObject({ leader: true, subscriptions: 0 });
    s.setClock(new Date('2026-11-10T08:00:30Z'));
    expect(await a.tick()).toMatchObject({ leader: true, subscriptions: 1 });
    expect((s.mailer as FakeMailer).sent).toHaveLength(1);
    expect((await a.tick()).subscriptions).toBe(0); // rescheduled to tomorrow
    s.setClock(new Date('2026-11-10T08:10:00Z')); // a died; its 3-minute lease expired
    expect((await b.tick()).leader).toBe(true);
    void sub;
  });

  it('refresh re-runs a dashboard’s queries bypassing the cache', async () => {
    const s = await seeded();
    await s.service.setRefresh({ teamId: 'team-a', subject: 'dev-a', role: 'editor' }, 'dash_9f2a', 30);
    const [r] = await s.service.listRefresh('team-a');
    const ran = await s.service.runRefresh('team-a', r!);
    expect(ran.lastRun).toMatchObject({ status: 'ok', message: expect.stringMatching(/^\d+\/\d+ queries refreshed/) });
    expect(ran.nextRunAt).toBe('2026-11-10T07:30:00.000Z');
  });
});

describe('schedules (time zones)', () => {
  it('computes wall-clock runs across DST', () => {
    const daily = { frequency: 'daily' as const, time: '08:00', timezone: 'Europe/Berlin' };
    expect(nextRun(daily, new Date('2026-03-28T08:00:00Z')).toISOString()).toBe('2026-03-29T06:00:00.000Z'); // CEST starts
    expect(nextRun(daily, new Date('2026-03-27T06:30:00Z')).toISOString()).toBe('2026-03-27T07:00:00.000Z');
    expect(nextRun({ frequency: 'weekly', time: '09:30', timezone: 'America/New_York', dayOfWeek: 1 }, new Date('2026-11-10T00:00:00Z')).toISOString()).toBe('2026-11-16T14:30:00.000Z');
    expect(nextRun({ frequency: 'monthly', time: '00:00', timezone: 'UTC', dayOfMonth: 1 }, new Date('2026-11-10T00:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(nextRun({ frequency: 'hourly', time: '00:15', timezone: 'Asia/Kolkata' }, new Date('2026-11-10T07:00:00Z')).toISOString()).toBe('2026-11-10T07:15:00.000Z'.replace('07:15', '07:45'));
    expect(zonedTimeToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin').toISOString()).toBe('2026-03-29T01:30:00.000Z'); // gap → forward
    expect(validateSchedule({ frequency: 'weekly', time: '25:00', timezone: 'UTC' })).toMatch(/time/);
    expect(validateSchedule({ frequency: 'monthly', time: '08:00', timezone: 'UTC', dayOfMonth: 31 })).toMatch(/dayOfMonth/);
  });
});

describe('webhook safety', () => {
  it('blocks private, loopback, link-local, CGNAT, mapped and reserved addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1', 'not-an-ip']) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '2606:4700::1111', '8.8.8.8']) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('validates URLs, allowlists and signs payloads', () => {
    expect(() => validateWebhookUrl('http://x.example.com')).toThrow(/https/);
    expect(() => validateWebhookUrl('https://u:p@x.example.com')).toThrow(/credentials/);
    expect(() => validateWebhookUrl('https://localhost/x')).toThrow(/private/);
    expect(() => validateWebhookUrl('https://[::1]/x')).toThrow(/private/);
    expect(() => validateWebhookUrl('https://evil.com/x', ['.example.com'])).toThrow(/not allowed/);
    expect(validateWebhookUrl('https://hooks.example.com/x', ['.example.com']).hostname).toBe('hooks.example.com');
    expect(hostAllowed('example.com', ['.example.com'])).toBe(true);
    expect(signPayload('s3cret', '1700000000', '{"a":1}')).toBe('sha256=' + require('node:crypto').createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex'));
  });

  it('refuses hostnames that resolve to a private address at connect time (DNS rebinding safe)', async () => {
    const lookup = safeLookup((host, _o, cb) => cb(null, host === 'rebind.example.com' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]));
    const run = (host: string) => new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => lookup(host, {}, (err, address) => resolve({ err, address })));
    expect((await run('rebind.example.com')).err?.code).toBe('EBLOCKED');
    expect(await run('ok.example.com')).toEqual({ err: null, address: '93.184.216.34' });
  });

  it('CSV output escapes and neutralizes formulas', () => {
    const csv = toCsv({ columns: [{ name: 'a', type: 'string' }, { name: 'b', type: 'number' }], rows: [{ a: '=HYPERLINK("x")', b: 1 }, { a: 'x,"y"', b: null }], truncated: false });
    expect(csv).toBe('a,b\r\n"\'=HYPERLINK(""x"")",1\r\n"x,""y""",\r\n');
  });
});

void (null as unknown as Alert);
