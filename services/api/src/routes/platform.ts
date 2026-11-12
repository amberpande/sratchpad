import { ID_PATTERN, validateDashboard } from '@yourorg/bi-spec';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Principal } from '../auth';
import { HttpError } from '../errors';
import type { Logger } from '../obs/logger';
import type { Metrics } from '../obs/metrics';
import { EMAIL_PATTERN } from '../platform/mailer';
import { validateSchedule, type Schedule } from '../platform/schedule';
import { ALERT_OPS, METRIC_NAME, PlatformError, toCsv, type Alert, type PlatformService, type Subscription } from '../platform/service';
import { validateWebhookUrl, WebhookError } from '../platform/webhook';
import type { DashboardStore } from '../store/types';

/**
 * Platform routes: comments, favorites, usage, subscriptions, data alerts, scheduled refresh, the team
 * metric catalog and CSV export. app.ts calls registerPlatformRoutes when `platform` is set.
 *
 * Access: every route needs a team token (share tokens are confined to their dashboard's read routes by
 * the gateway, so they never reach these). Viewers read comments, favorites, usage and the catalog,
 * write comments and favorites, and export. Subscriptions, alerts, refresh schedules and catalog edits
 * are editor-only. Every read and write is scoped to the caller's team.
 */
export interface PlatformServices {
  /** Called when a dashboard is opened (usage analytics). Must never throw or block. */
  onDashboardView?(principal: Principal, dashboardId: string): void;
  /** The feature implementation (workstream D). Without it only onDashboardView applies. */
  service?: PlatformService;
  /** Whether the scheduler runs in this process (reported by /v1/platform). */
  schedulerEnabled?: boolean;
  /** Hostname allowlist for alert webhooks (BI_WEBHOOK_ALLOWED_HOSTS). */
  webhookAllowedHosts?: string[];
}

export interface PlatformRouteContext {
  services: PlatformServices;
  store: DashboardStore;
  logger: Logger;
  metrics?: Metrics;
  now: () => Date;
  /** Middleware: editors only (403 for viewers and share tokens). */
  editor: (c: Context, next: () => Promise<void>) => Promise<void>;
  /** Parses a JSON body or throws 400. */
  readJson: (c: Context) => Promise<unknown>;
}

const emails = z.array(z.string().regex(EMAIL_PATTERN, 'must be an email address')).max(50);
const ScheduleSchema = z.custom<Schedule>((v) => validateSchedule(v) === null, { message: 'invalid schedule' });

const CommentBody = z.object({ body: z.string().trim().min(1).max(4000), widgetId: z.string().regex(ID_PATTERN).optional() }).strict();
const SubscriptionBody = z
  .object({
    dashboardId: z.string().regex(ID_PATTERN),
    name: z.string().trim().min(1).max(100),
    recipients: emails.min(1),
    schedule: ScheduleSchema,
    widgets: z.array(z.string().regex(ID_PATTERN)).max(20).default([]),
    includeKpis: z.boolean().default(true),
  })
  .strict();
const AlertBody = z
  .object({
    dashboardId: z.string().regex(ID_PATTERN),
    name: z.string().trim().min(1).max(100),
    queryId: z.string().regex(ID_PATTERN),
    field: z.string().min(1).max(128),
    reduce: z.enum(['sum', 'avg', 'min', 'max', 'first', 'last', 'count']).default('sum'),
    op: z.enum(ALERT_OPS as [string, ...string[]]),
    threshold: z.number().finite(),
    intervalMinutes: z.number().int().min(5).max(1440).default(60),
    recipients: emails.default([]),
    webhookUrl: z.string().max(2000).optional(),
  })
  .strict()
  .refine((a) => a.recipients.length > 0 || a.webhookUrl, 'an alert needs recipients or a webhookUrl');
const RefreshBody = z.object({ intervalMinutes: z.number().int().min(5).max(1440) }).strict();
const MetricBody = z.record(z.unknown());

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new HttpError(400, 'invalid_body', issues.join('; '), { errors: issues });
  }
  return r.data;
}

/** Hides the webhook secret (it is returned once, at creation). */
function publicAlert(a: Alert) {
  const { webhookSecret, ...rest } = a;
  return { ...rest, webhookSecretSet: Boolean(webhookSecret) };
}

function principal(c: Context): Principal {
  const p = c.get('principal') as Principal;
  if (p.share) throw new HttpError(403, 'forbidden', 'Share tokens cannot use this route.');
  return p;
}

function idParam(c: Context, name: string): string {
  const v = c.req.param(name) ?? '';
  if (!ID_PATTERN.test(v)) throw new HttpError(400, 'invalid_id', `"${name}" is not a valid id.`);
  return v;
}

function daysParam(c: Context): number {
  const d = Number(c.req.query('days') ?? 30);
  return Number.isInteger(d) && d >= 1 && d <= 366 ? d : 30;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerPlatformRoutes(app: Hono<any>, ctx: PlatformRouteContext): void {
  const service = ctx.services.service;
  if (!service) return;
  const { editor, readJson } = ctx;

  // Map feature errors to API errors (app.onError renders HttpError).
  const wrap =
    (fn: (c: Context) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (error) {
        if (error instanceof PlatformError) throw new HttpError(error.status, error.code, error.message);
        if (error instanceof WebhookError) throw new HttpError(422, 'invalid_webhook', error.message);
        throw error;
      }
    };

  app.get(
    '/v1/platform',
    wrap(async (c) => {
      const p = principal(c);
      return c.json({ me: { subject: p.subject, teamId: p.teamId, role: p.role ?? 'editor' }, email: service.emailConfigured, scheduler: Boolean(ctx.services.schedulerEnabled) });
    }),
  );

  // ── comments ──
  app.get('/v1/dashboards/:id/comments', wrap(async (c) => {
    const p = principal(c);
    const id = idParam(c, 'id');
    await service.requireDashboard(p.teamId, id);
    return c.json({ comments: await service.listComments(p.teamId, id) });
  }));
  app.post('/v1/dashboards/:id/comments', wrap(async (c) => {
    const p = principal(c);
    const body = parse(CommentBody, await readJson(c));
    return c.json({ comment: await service.addComment(p, idParam(c, 'id'), body.body, body.widgetId) }, 201);
  }));
  app.patch('/v1/dashboards/:id/comments/:cid', wrap(async (c) => {
    const p = principal(c);
    const body = parse(CommentBody.pick({ body: true }), await readJson(c));
    return c.json({ comment: await service.editComment(p, idParam(c, 'id'), decodeURIComponent(c.req.param('cid') ?? ''), body.body) });
  }));
  app.delete('/v1/dashboards/:id/comments/:cid', wrap(async (c) => {
    await service.deleteComment(principal(c), idParam(c, 'id'), decodeURIComponent(c.req.param('cid') ?? ''));
    return c.body(null, 204);
  }));

  // ── favorites ──
  app.get('/v1/favorites', wrap(async (c) => c.json({ dashboards: await service.favorites(principal(c)) })));
  app.put('/v1/favorites/:id', wrap(async (c) => {
    await service.setFavorite(principal(c), idParam(c, 'id'), true);
    return c.body(null, 204);
  }));
  app.delete('/v1/favorites/:id', wrap(async (c) => {
    await service.setFavorite(principal(c), idParam(c, 'id'), false);
    return c.body(null, 204);
  }));

  // ── usage ──
  app.get('/v1/usage', wrap(async (c) => c.json(await service.usageSummary(principal(c), daysParam(c)))));
  app.get('/v1/dashboards/:id/usage', wrap(async (c) => c.json(await service.dashboardUsage(principal(c).teamId, idParam(c, 'id'), daysParam(c)))));

  // ── CSV export of one saved query (any team member; row-level security applies via runQuery) ──
  app.get('/v1/dashboards/:id/export', wrap(async (c) => {
    const p = principal(c);
    const id = idParam(c, 'id');
    const queryId = c.req.query('query') ?? '';
    if (!ID_PATTERN.test(queryId)) throw new HttpError(400, 'invalid_query', '"query" must name a saved query.');
    let params: Record<string, unknown> = {};
    const rawParams = c.req.query('params');
    if (rawParams) {
      try {
        const v: unknown = JSON.parse(rawParams);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        params = v as Record<string, unknown>;
      } catch {
        throw new HttpError(400, 'invalid_params', '"params" must be a JSON object.');
      }
    }
    const rawVersion = c.req.query('version');
    const version = rawVersion !== undefined && /^\d+$/.test(rawVersion) ? Number(rawVersion) : undefined;
    const record = await ctx.store.get(p.teamId, id, version);
    if (!record) throw new HttpError(404, 'not_found', `Dashboard "${id}" was not found.`);
    const v = validateDashboard(record.spec, { allowNewerMinor: false });
    if (!v.ok) throw new HttpError(500, 'stored_spec_invalid', `Stored dashboard "${id}" no longer validates.`);
    if (!v.dashboard.queries[queryId]) throw new HttpError(404, 'not_found', `Query "${queryId}" is not part of this dashboard.`);
    const line = (await service.runQueries(p, v.dashboard, [queryId], { params })).get(queryId)!;
    if (!line.ok) throw new HttpError(422, line.error.code, line.error.message);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${id}-${queryId}.csv"`);
    c.header('Cache-Control', 'no-store');
    return c.body(toCsv(line.result));
  }));

  // ── subscriptions (editors) ──
  app.get('/v1/subscriptions', editor, wrap(async (c) => {
    const p = principal(c);
    const d = c.req.query('dashboardId');
    return c.json({ subscriptions: await service.listSubscriptions(p.teamId, d && ID_PATTERN.test(d) ? d : undefined) });
  }));
  app.post('/v1/subscriptions', editor, wrap(async (c) => {
    const p = principal(c);
    const body = parse(SubscriptionBody, await readJson(c));
    return c.json({ subscription: await service.createSubscription(p, body as Omit<Subscription, 'id' | 'owner' | 'ownerRole' | 'nextRunAt'>) }, 201);
  }));
  app.post('/v1/subscriptions/:sid/run', editor, wrap(async (c) => {
    const p = principal(c);
    const sub = (await service.listSubscriptions(p.teamId)).find((s) => s.id === c.req.param('sid'));
    if (!sub) throw new HttpError(404, 'not_found', 'Subscription not found.');
    return c.json({ subscription: await service.runSubscription(p.teamId, sub, { reschedule: false }) });
  }));
  app.delete('/v1/subscriptions/:sid', editor, wrap(async (c) => {
    await service.deleteRecord(principal(c).teamId, 'subscriptions', c.req.param('sid') ?? '');
    return c.body(null, 204);
  }));

  // ── alerts (editors) ──
  app.get('/v1/alerts', editor, wrap(async (c) => {
    const p = principal(c);
    const d = c.req.query('dashboardId');
    return c.json({ alerts: (await service.listAlerts(p.teamId, d && ID_PATTERN.test(d) ? d : undefined)).map(publicAlert) });
  }));
  app.post('/v1/alerts', editor, wrap(async (c) => {
    const p = principal(c);
    const body = parse(AlertBody, await readJson(c));
    if (body.webhookUrl) validateWebhookUrl(body.webhookUrl, ctx.services.webhookAllowedHosts ?? []);
    const alert = await service.createAlert(p, body as Omit<Alert, 'id' | 'owner' | 'ownerRole' | 'state' | 'nextRunAt' | 'webhookSecret'>);
    // The webhook secret is shown here only; store it to verify X-Sratchpad-Signature.
    return c.json({ alert: publicAlert(alert), ...(alert.webhookSecret ? { webhookSecret: alert.webhookSecret } : {}) }, 201);
  }));
  app.post('/v1/alerts/:aid/test', editor, wrap(async (c) => {
    const p = principal(c);
    const alert = (await service.listAlerts(p.teamId)).find((a) => a.id === c.req.param('aid'));
    if (!alert) throw new HttpError(404, 'not_found', 'Alert not found.');
    return c.json({ alert: publicAlert(await service.evaluateAlert(p.teamId, alert, { force: true })) });
  }));
  app.delete('/v1/alerts/:aid', editor, wrap(async (c) => {
    await service.deleteRecord(principal(c).teamId, 'alerts', c.req.param('aid') ?? '');
    return c.body(null, 204);
  }));

  // ── scheduled refresh (editors) ──
  app.get('/v1/refresh', editor, wrap(async (c) => c.json({ schedules: await service.listRefresh(principal(c).teamId) })));
  app.put('/v1/dashboards/:id/refresh', editor, wrap(async (c) => {
    const body = parse(RefreshBody, await readJson(c));
    return c.json({ schedule: await service.setRefresh(principal(c), idParam(c, 'id'), body.intervalMinutes) });
  }));
  app.delete('/v1/dashboards/:id/refresh', editor, wrap(async (c) => {
    await service.deleteRecord(principal(c).teamId, 'refresh', idParam(c, 'id'));
    return c.body(null, 204);
  }));

  // ── metric catalog (team reads, editors write) ──
  app.get('/v1/metrics-catalog', wrap(async (c) => c.json({ metrics: await service.metricCatalog.get(principal(c).teamId) })));
  app.put('/v1/metrics-catalog/:name', editor, wrap(async (c) => {
    const name = c.req.param('name') ?? '';
    if (!METRIC_NAME.test(name)) throw new HttpError(400, 'invalid_name', 'Metric names are lower-case letters, digits and "_", starting with a letter.');
    const body = parse(MetricBody, await readJson(c));
    return c.json({ metric: await service.putMetric(principal(c).teamId, name, body) });
  }));
  app.delete('/v1/metrics-catalog/:name', editor, wrap(async (c) => {
    await service.deleteMetric(principal(c).teamId, c.req.param('name') ?? '');
    return c.body(null, 204);
  }));
}
