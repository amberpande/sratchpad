import { randomBytes } from 'node:crypto';
import {
  coerceParamValue,
  effectiveParamValues,
  validateDashboard,
  type Cell,
  type DataResponseLine,
  type QueryResult,
  type ValidDashboard,
} from '@yourorg/bi-spec';
import type { Principal } from '../auth';
import type { EngineRegistry } from '../data/engine';
import * as metricsModule from '../data/metrics';
import type { MetricCatalog, MetricDefinition } from '../data/metrics';
import { renderPdf } from './pdf';
import { runQuery, type QueryServices, type RunContext } from '../data/run';
import type { Logger } from '../obs/logger';
import { newShare, type ShareStore } from '../sharing/store';
import type { DashboardStore } from '../store/types';
import { escapeHtml, type Mailer } from './mailer';
import { linkLifetimeDays, nextRun, type Schedule } from './schedule';
import type { PlatformStore } from './store';
import type { WebhookSender } from './webhook';

/**
 * Platform features on top of the platform store: comments, favorites, usage analytics,
 * subscriptions, data alerts, scheduled cache refresh, and the team metric catalog. Every method
 * takes the caller's team; nothing crosses teams. Queries run through `runQuery`, the same path as
 * dashboards (row-level security, cache, per-team limits), as the record's owner.
 */

export class PlatformError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Comment {
  id: string;
  dashboardId: string;
  widgetId?: string;
  body: string;
  author: string;
  createdAt: string;
  editedAt?: string;
}

export interface Subscription {
  id: string;
  dashboardId: string;
  name: string;
  recipients: string[];
  schedule: Schedule;
  /** Widgets whose data is attached as CSV. */
  widgets: string[];
  /** Include the dashboard's KPI values in the email body. */
  includeKpis: boolean;
  /** Also attach a PDF report: KPIs and the selected widgets' data (D-096). */
  attachPdf?: boolean;
  owner: string;
  ownerRole: 'editor' | 'viewer';
  /** The owner's row-level security attributes at creation: the job sees exactly what they saw. */
  ownerAttributes?: Record<string, string[]>;
  nextRunAt: string;
  /** The share created for the latest email (revoked when the next one is sent). */
  shareId?: string;
  lastRun?: RunRecord;
}

export interface RunRecord {
  at: string;
  status: 'sent' | 'not_delivered' | 'failed' | 'ok' | 'firing';
  message?: string;
}

export type AlertOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'change_pct';
export const ALERT_OPS: readonly AlertOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'change_pct'];
export type Reduce = 'sum' | 'avg' | 'min' | 'max' | 'first' | 'last' | 'count';

export interface Alert {
  id: string;
  dashboardId: string;
  name: string;
  queryId: string;
  field: string;
  reduce: Reduce;
  /** change_pct: fires when |value − previous| / |previous| × 100 ≥ threshold. */
  op: AlertOp;
  threshold: number;
  intervalMinutes: number;
  recipients: string[];
  webhookUrl?: string;
  /** Signs webhook payloads. Returned once, at creation. */
  webhookSecret?: string;
  owner: string;
  ownerRole: 'editor' | 'viewer';
  ownerAttributes?: Record<string, string[]>;
  state: 'unknown' | 'ok' | 'firing';
  lastValue?: number | null;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  lastError?: string;
  nextRunAt: string;
  /** Since D-094: no notifications until this time (checks still run, state still updates). */
  snoozedUntil?: string;
  /** Still firing this many minutes after it fired: notify `escalateTo` once per firing episode. */
  escalateAfterMinutes?: number;
  escalateTo?: string[];
  escalatedAt?: string;
}

export interface RefreshSchedule {
  dashboardId: string;
  intervalMinutes: number;
  /** Who set it: refresh runs as them (row-level security), so it warms what they would see. */
  owner?: string;
  ownerRole?: 'editor' | 'viewer';
  ownerAttributes?: Record<string, string[]>;
  nextRunAt: string;
  lastRun?: RunRecord;
}

export interface PlatformDeps {
  store: PlatformStore;
  dashboards: DashboardStore;
  shares?: ShareStore;
  engines: EngineRegistry;
  queryServices: QueryServices;
  queryTimeoutMs: number;
  mailer: Mailer | null;
  webhooks: WebhookSender;
  /** Viewer base URL for subscription links, e.g. "https://sratchpad.example.com/view/". */
  viewerBaseUrl?: string;
  logger?: Logger;
  now?: () => Date;
  /** BI_METRIC_OWNERS: subjects allowed to change each team's metric catalog (D-078). */
  metricOwners?: Record<string, string[]>;
}

const C = { comments: 'comments', favorites: 'favorites', recent: 'recent', subscriptions: 'subscriptions', alerts: 'alerts', refresh: 'refresh', metrics: 'metrics', metricVersions: 'metric_versions' } as const;

/** The principal a job runs as: its owner, with the attributes captured when it was created. */
function ownerPrincipal(teamId: string, r: { owner?: string; ownerRole?: 'editor' | 'viewer'; ownerAttributes?: Record<string, string[]> }): Principal {
  return { teamId, subject: r.owner ?? 'scheduler', role: r.ownerRole ?? 'viewer', ...(r.ownerAttributes ? { attributes: structuredClone(r.ownerAttributes) } : {}) };
}

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function reduceValue(rows: QueryResult['rows'], field: string, reduce: Reduce): number | null {
  const nums = rows.map((r) => r[field]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (reduce === 'count') return rows.length;
  if (!nums.length) return null;
  switch (reduce) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    case 'first':
      return nums[0]!;
    case 'last':
      return nums[nums.length - 1]!;
  }
}

export function conditionMet(op: AlertOp, threshold: number, value: number | null, previous: number | null | undefined): boolean {
  if (value === null) return false;
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    case 'neq':
      return value !== threshold;
    case 'change_pct':
      if (previous === null || previous === undefined || previous === 0) return false;
      return (Math.abs(value - previous) / Math.abs(previous)) * 100 >= threshold;
  }
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as formulas are prefixed with "'". */
export function toCsv(result: QueryResult): string {
  const cols = result.columns.map((c) => c.name);
  const cell = (v: Cell): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => cell(c)), ...result.rows.map((r) => cols.map((c) => cell(r[c] ?? null)))].map((line) => line.join(',')).join('\r\n') + '\r\n';
}

function formatNumber(v: number | null): string {
  if (v === null) return '–';
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
}

export class PlatformService {
  private readonly now: () => Date;

  constructor(readonly deps: PlatformDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get emailConfigured(): boolean {
    return this.deps.mailer !== null;
  }

  /** Existence check that reads like "not found" for other teams. */
  async requireDashboard(teamId: string, dashboardId: string) {
    const record = await this.deps.dashboards.get(teamId, dashboardId);
    if (!record) throw new PlatformError(404, 'not_found', `Dashboard "${dashboardId}" was not found.`);
    return record;
  }

  // ── comments ──

  async listComments(teamId: string, dashboardId: string): Promise<Comment[]> {
    const recs = await this.deps.store.list<Comment>(teamId, C.comments, { prefix: `${dashboardId}:` });
    return recs.map((r) => r.data).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addComment(p: Principal, dashboardId: string, body: string, widgetId?: string): Promise<Comment> {
    await this.requireDashboard(p.teamId, dashboardId);
    const at = this.now().toISOString();
    const id = `${dashboardId}:${at}:${randomBytes(4).toString('hex')}`;
    const comment: Comment = { id, dashboardId, ...(widgetId ? { widgetId } : {}), body, author: p.subject, createdAt: at };
    await this.deps.store.put(p.teamId, C.comments, id, comment);
    return comment;
  }

  private async ownComment(p: Principal, dashboardId: string, commentId: string, allowEditors: boolean) {
    if (!commentId.startsWith(`${dashboardId}:`)) throw new PlatformError(404, 'not_found', 'Comment not found.');
    const rec = await this.deps.store.get<Comment>(p.teamId, C.comments, commentId);
    if (!rec) throw new PlatformError(404, 'not_found', 'Comment not found.');
    const mine = rec.data.author === p.subject;
    if (!mine && !(allowEditors && (p.role ?? 'editor') === 'editor')) throw new PlatformError(403, 'forbidden', 'You can only change your own comments.');
    return rec.data;
  }

  async editComment(p: Principal, dashboardId: string, commentId: string, body: string): Promise<Comment> {
    const c = await this.ownComment(p, dashboardId, commentId, false);
    const next = { ...c, body, editedAt: this.now().toISOString() };
    await this.deps.store.put(p.teamId, C.comments, commentId, next);
    return next;
  }

  /** Authors delete their own comments; editors may remove any (moderation). */
  async deleteComment(p: Principal, dashboardId: string, commentId: string): Promise<void> {
    await this.ownComment(p, dashboardId, commentId, true);
    await this.deps.store.delete(p.teamId, C.comments, commentId);
  }

  // ── favorites ──

  async favorites(p: Principal): Promise<string[]> {
    return (await this.deps.store.list<{ dashboardId: string }>(p.teamId, C.favorites, { prefix: `${p.subject}:` })).map((r) => r.data.dashboardId);
  }

  async setFavorite(p: Principal, dashboardId: string, on: boolean): Promise<void> {
    const id = `${p.subject}:${dashboardId}`;
    if (on) {
      await this.requireDashboard(p.teamId, dashboardId);
      await this.deps.store.put(p.teamId, C.favorites, id, { dashboardId });
    } else await this.deps.store.delete(p.teamId, C.favorites, id);
  }

  // ── usage ──

  /** Fire-and-forget from the read path: never throws. */
  recordView(p: Principal, dashboardId: string): void {
    const at = this.now();
    void (async () => {
      await this.deps.store.increment(p.teamId, `views:${dashboardId}`, day(at));
      if (!p.share) await this.deps.store.put(p.teamId, C.recent, `${p.subject}:${dashboardId}`, { dashboardId, at: at.toISOString() });
    })().catch((error: unknown) => this.deps.logger?.warn('usage record failed', { error }));
  }

  async usageSummary(p: Principal, days = 30) {
    const from = day(new Date(this.now().getTime() - (days - 1) * 86_400_000));
    const rows = await this.deps.store.counters(p.teamId, 'views:', from);
    const byDashboard = new Map<string, { views: number; lastDay: string }>();
    for (const r of rows) {
      const id = r.counter.slice('views:'.length);
      const e = byDashboard.get(id) ?? { views: 0, lastDay: '' };
      e.views += r.value;
      if (r.bucket > e.lastDay) e.lastDay = r.bucket;
      byDashboard.set(id, e);
    }
    const recent = await this.deps.store.list<{ dashboardId: string; at: string }>(p.teamId, C.recent, { prefix: `${p.subject}:` });
    const mine = new Map(recent.map((r) => [r.data.dashboardId, r.data.at]));
    const ids = new Set([...byDashboard.keys(), ...mine.keys()]);
    return {
      days,
      dashboards: [...ids].map((id) => ({ dashboardId: id, views: byDashboard.get(id)?.views ?? 0, lastViewedDay: byDashboard.get(id)?.lastDay || undefined, myLastViewedAt: mine.get(id) })),
    };
  }

  /** Per-widget usage (D-095): data loads and interactions (cross-filter / drill variants) per saved query. */
  recordQueries(p: Principal, dashboardId: string, queries: Array<{ queryId: string; variant: boolean }>): void {
    const at = day(this.now());
    void (async () => {
      for (const q of queries) await this.deps.store.increment(p.teamId, `${q.variant ? 'qinteract' : 'qloads'}:${dashboardId}:${q.queryId}`, at);
    })().catch((error: unknown) => this.deps.logger?.warn('usage record failed', { error }));
  }

  async dashboardUsage(teamId: string, dashboardId: string, days = 30) {
    const record = await this.requireDashboard(teamId, dashboardId);
    const from = day(new Date(this.now().getTime() - (days - 1) * 86_400_000));
    const rows = await this.deps.store.counters(teamId, `views:${dashboardId}`, from);
    const series = rows.filter((r) => r.counter === `views:${dashboardId}`).map((r) => ({ day: r.bucket, views: r.value }));
    // Widgets: a widget's numbers are its query's (widgets sharing a query share them).
    const sum = async (kind: string) => {
      const out = new Map<string, number>();
      for (const r of await this.deps.store.counters(teamId, `${kind}:${dashboardId}:`, from)) {
        const qid = r.counter.slice(`${kind}:${dashboardId}:`.length);
        out.set(qid, (out.get(qid) ?? 0) + r.value);
      }
      return out;
    };
    const [loads, interactions] = await Promise.all([sum('qloads'), sum('qinteract')]);
    const spec = record.spec as { widgets?: Record<string, { query?: string; type?: string; options?: { title?: unknown } }> };
    const widgets = Object.entries(spec.widgets ?? {})
      .filter(([, w]) => typeof w.query === 'string')
      .map(([widgetId, w]) => ({ widgetId, type: w.type, title: typeof w.options?.title === 'string' ? w.options.title : undefined, loads: loads.get(w.query!) ?? 0, interactions: interactions.get(w.query!) ?? 0 }))
      .sort((a, b) => b.interactions - a.interactions || b.loads - a.loads);
    return { dashboardId, days, total: series.reduce((a, b) => a + b.views, 0), series, widgets };
  }

  // ── running a saved dashboard's queries (as a principal) ──

  async loadDashboard(teamId: string, dashboardId: string): Promise<ValidDashboard> {
    const record = await this.requireDashboard(teamId, dashboardId);
    const v = validateDashboard(record.spec, { allowNewerMinor: false });
    if (!v.ok) throw new PlatformError(422, 'stored_spec_invalid', `Dashboard "${dashboardId}" no longer validates.`);
    return v.dashboard;
  }

  /** Resolves params like the data route: unknown or invalid values are rejected. */
  resolveParams(dashboard: ValidDashboard, raw: Record<string, unknown> = {}) {
    for (const [name, value] of Object.entries(raw)) {
      const param = dashboard.params[name];
      if (!param) throw new PlatformError(400, 'unknown_param', `Dashboard "${dashboard.id}" has no param "${name}".`);
      const c = coerceParamValue(param, value);
      if (!c.ok) throw new PlatformError(400, 'invalid_param', `Param "${name}": ${c.message}.`);
    }
    return effectiveParamValues(dashboard, raw);
  }

  async runQueries(
    principal: Principal,
    dashboard: ValidDashboard,
    queryIds: string[],
    options: { params?: Record<string, unknown>; bypassCache?: boolean; signal?: AbortSignal } = {},
  ): Promise<Map<string, DataResponseLine>> {
    const values = this.resolveParams(dashboard, options.params);
    const at = this.now();
    const out = new Map<string, DataResponseLine>();
    await Promise.all(
      [...new Set(queryIds)].map(async (queryId) => {
        // `principal` lets runQuery apply row-level security (workstream B) for this user.
        const ctx = {
          dashboard,
          values,
          engines: this.deps.engines,
          teamId: principal.teamId,
          principal,
          now: at,
          timeoutMs: this.deps.queryTimeoutMs,
          services: this.deps.queryServices,
          bypassCache: options.bypassCache,
          signal: options.signal,
        } as RunContext;
        out.set(queryId, await runQuery(queryId, ctx));
      }),
    );
    return out;
  }

  // ── subscriptions ──

  async listSubscriptions(teamId: string, dashboardId?: string): Promise<Subscription[]> {
    const all = (await this.deps.store.list<Subscription>(teamId, C.subscriptions)).map((r) => r.data);
    return dashboardId ? all.filter((s) => s.dashboardId === dashboardId) : all;
  }

  async createSubscription(p: Principal, input: Omit<Subscription, 'id' | 'owner' | 'ownerRole' | 'nextRunAt' | 'lastRun' | 'shareId'>): Promise<Subscription> {
    const dashboard = await this.loadDashboard(p.teamId, input.dashboardId);
    for (const w of input.widgets) if (!dashboard.widgets[w]) throw new PlatformError(422, 'unknown_widget', `Widget "${w}" is not on this dashboard.`);
    const sub: Subscription = { ...input, id: newId('sub'), owner: p.subject, ownerRole: p.role ?? 'editor', ...(p.attributes ? { ownerAttributes: structuredClone(p.attributes) } : {}), nextRunAt: nextRun(input.schedule, this.now()).toISOString() };
    await this.deps.store.put(p.teamId, C.subscriptions, sub.id, sub);
    return sub;
  }

  async deleteRecord(teamId: string, kind: 'subscriptions' | 'alerts' | 'refresh', id: string): Promise<void> {
    const rec = await this.deps.store.get<Subscription>(teamId, C[kind], id);
    if (!rec) throw new PlatformError(404, 'not_found', 'Not found.');
    if (kind === 'subscriptions' && rec.data.shareId) await this.deps.shares?.revoke(teamId, rec.data.dashboardId, rec.data.shareId, this.now().toISOString()).catch(() => false);
    await this.deps.store.delete(teamId, C[kind], id);
  }

  /** Builds and sends one subscription email (also used by "send now"). */
  async runSubscription(teamId: string, sub: Subscription, options: { reschedule: boolean }): Promise<Subscription> {
    const at = this.now();
    let lastRun: RunRecord;
    let shareId = sub.shareId;
    try {
      const dashboard = await this.loadDashboard(teamId, sub.dashboardId);
      const owner = ownerPrincipal(teamId, sub);
      const kpiWidgets = sub.includeKpis ? Object.entries(dashboard.widgets).filter(([, w]) => w.type === 'kpi') : [];
      const csvWidgets = sub.widgets.map((id) => [id, dashboard.widgets[id]] as const).filter(([, w]) => w && w.type !== '__unsupported__' && 'query' in w && w.query);
      const queryIds = [...kpiWidgets, ...csvWidgets].map(([, w]) => (w as { query: string }).query);
      const lines = await this.runQueries(owner, dashboard, queryIds);

      const kpis = kpiWidgets.map(([id, w]) => {
        const opts = (w as { options: { field: string; reduce?: Reduce; label?: string; title?: string } }).options;
        const line = lines.get((w as { query: string }).query);
        const value = line?.ok ? reduceValue(line.result.rows, opts.field, opts.reduce ?? 'sum') : null;
        return { id, label: opts.label ?? opts.title ?? opts.field, value };
      });
      const attachments = csvWidgets.flatMap(([id, w]) => {
        const line = lines.get((w as { query: string }).query);
        if (!line?.ok) return [];
        const name = ((w as { options?: { title?: string } }).options?.title ?? id).replace(/[^\w.-]+/g, '_').slice(0, 60) || id;
        return [{ filename: `${name}.csv`, content: toCsv(line.result) as string | Uint8Array, contentType: 'text/csv' }];
      });
      if (sub.attachPdf) {
        const sections = csvWidgets.flatMap(([id, w]) => {
          const line = lines.get((w as { query: string }).query);
          return line?.ok ? [{ title: (w as { options?: { title?: string } }).options?.title ?? id, result: line.result }] : [];
        });
        const pdf = renderPdf(dashboard.title, kpis.map((k) => ({ label: k.label, value: formatNumber(k.value) })), sections, at);
        attachments.unshift({ filename: `${dashboard.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'report'}.pdf`, content: pdf, contentType: 'application/pdf' });
      }

      // A fresh viewer link per email; the previous one is revoked, and each expires on its own.
      let link: string | undefined;
      if (this.deps.shares && this.deps.viewerBaseUrl) {
        const expiresAt = new Date(at.getTime() + linkLifetimeDays(sub.schedule.frequency) * 86_400_000).toISOString();
        const { record, token } = newShare(
          { teamId, dashboardId: sub.dashboardId, audience: 'viewer', label: `Subscription: ${sub.name}`.slice(0, 100), createdBy: sub.owner, expiresAt, ...(sub.ownerAttributes ? { attributes: structuredClone(sub.ownerAttributes) } : {}) },
          at,
        );
        await this.deps.shares.insert(record);
        if (shareId) await this.deps.shares.revoke(teamId, sub.dashboardId, shareId, at.toISOString()).catch(() => false);
        shareId = record.id;
        link = `${this.deps.viewerBaseUrl.replace(/\/+$/, '')}/#token=${token}`;
      }

      if (!this.deps.mailer) {
        lastRun = { at: at.toISOString(), status: 'not_delivered', message: 'Email is not configured on this server (SMTP_URL).' };
      } else {
        const lines2 = [
          `${dashboard.title}`,
          '',
          ...kpis.map((k) => `${k.label}: ${formatNumber(k.value)}`),
          ...(link ? ['', `Open the dashboard: ${link}`] : []),
          ...(attachments.length ? ['', `Attached: ${attachments.map((a) => a.filename).join(', ')}`] : []),
          '',
          `You receive this because of the subscription "${sub.name}".`,
        ];
        const html = `<h2>${escapeHtml(dashboard.title)}</h2>${kpis.length ? `<table>${kpis.map((k) => `<tr><td>${escapeHtml(k.label)}</td><td><strong>${escapeHtml(formatNumber(k.value))}</strong></td></tr>`).join('')}</table>` : ''}${link ? `<p><a href="${escapeHtml(link)}">Open the dashboard</a></p>` : ''}<p style="color:#666">Subscription “${escapeHtml(sub.name)}”.</p>`;
        await this.deps.mailer.send({ to: sub.recipients, subject: `${dashboard.title} (${sub.name})`, text: lines2.join('\n'), html, attachments });
        lastRun = { at: at.toISOString(), status: 'sent', message: `Sent to ${sub.recipients.length} recipient(s).` };
      }
    } catch (error) {
      lastRun = { at: at.toISOString(), status: 'failed', message: (error as Error).message.slice(0, 300) };
      this.deps.logger?.warn('subscription run failed', { subscription: sub.id, error });
    }
    const next: Subscription = { ...sub, ...(shareId ? { shareId } : {}), lastRun, ...(options.reschedule ? { nextRunAt: nextRun(sub.schedule, at).toISOString() } : {}) };
    await this.deps.store.put(teamId, C.subscriptions, sub.id, next);
    return next;
  }

  // ── alerts ──

  async listAlerts(teamId: string, dashboardId?: string): Promise<Alert[]> {
    const all = (await this.deps.store.list<Alert>(teamId, C.alerts)).map((r) => r.data);
    return dashboardId ? all.filter((a) => a.dashboardId === dashboardId) : all;
  }

  async createAlert(p: Principal, input: Omit<Alert, 'id' | 'owner' | 'ownerRole' | 'state' | 'nextRunAt' | 'webhookSecret'>): Promise<Alert> {
    const dashboard = await this.loadDashboard(p.teamId, input.dashboardId);
    if (!dashboard.queries[input.queryId]) throw new PlatformError(422, 'unknown_query', `Query "${input.queryId}" is not on this dashboard.`);
    const alert: Alert = {
      ...input,
      id: newId('alr'),
      owner: p.subject,
      ownerRole: p.role ?? 'editor',
      ...(p.attributes ? { ownerAttributes: structuredClone(p.attributes) } : {}),
      state: 'unknown',
      nextRunAt: this.now().toISOString(),
      ...(input.webhookUrl ? { webhookSecret: randomBytes(24).toString('base64url') } : {}),
    };
    await this.deps.store.put(p.teamId, C.alerts, alert.id, alert);
    return alert;
  }

  /** Snoozes (minutes > 0) or unsnoozes (0) an alert's notifications. */
  async snoozeAlert(teamId: string, alertId: string, minutes: number): Promise<Alert> {
    const rec = await this.deps.store.get<Alert>(teamId, C.alerts, alertId);
    if (!rec) throw new PlatformError(404, 'not_found', 'Alert not found.');
    const next: Alert = { ...rec.data, snoozedUntil: minutes > 0 ? new Date(this.now().getTime() + minutes * 60_000).toISOString() : undefined };
    await this.deps.store.put(teamId, C.alerts, alertId, next);
    return next;
  }

  /** Evaluates an alert; notifies on a transition into "firing" (or always, when `force`). */
  async evaluateAlert(teamId: string, alert: Alert, options: { force?: boolean } = {}): Promise<Alert> {
    const at = this.now();
    let next: Alert = { ...alert, lastCheckedAt: at.toISOString(), nextRunAt: new Date(at.getTime() + alert.intervalMinutes * 60_000).toISOString() };
    try {
      const dashboard = await this.loadDashboard(teamId, alert.dashboardId);
      const owner = ownerPrincipal(teamId, alert);
      const line = (await this.runQueries(owner, dashboard, [alert.queryId], { bypassCache: true })).get(alert.queryId)!;
      if (!line.ok) throw new Error(`${line.error.code}: ${line.error.message}`);
      const value = reduceValue(line.result.rows, alert.field, alert.reduce);
      const firing = conditionMet(alert.op, alert.threshold, value, alert.lastValue);
      next = { ...next, lastValue: value, state: firing ? 'firing' : 'ok', lastError: undefined };
      const snoozed = !options.force && alert.snoozedUntil !== undefined && Date.parse(alert.snoozedUntil) > at.getTime();
      if (alert.snoozedUntil && !snoozed) next.snoozedUntil = undefined;
      if (!firing) next.escalatedAt = undefined; // a new episode can escalate again
      if (firing && (alert.state !== 'firing' || options.force)) {
        next.lastFiredAt = at.toISOString();
        next.escalatedAt = undefined;
        if (!snoozed) {
          const problems = await this.notifyAlert(dashboard, alert, value);
          if (problems.length) next.lastError = problems.join('; ');
        }
      } else if (
        firing &&
        !snoozed &&
        alert.escalateAfterMinutes &&
        alert.escalateTo?.length &&
        !alert.escalatedAt &&
        alert.lastFiredAt &&
        at.getTime() - Date.parse(alert.lastFiredAt) >= alert.escalateAfterMinutes * 60_000
      ) {
        // Escalation (D-094): still firing after the grace period: tell the escalation list once.
        next.escalatedAt = at.toISOString();
        const problems = await this.notifyAlert(dashboard, { ...alert, recipients: alert.escalateTo, webhookUrl: undefined, name: `${alert.name} (still firing)` }, value);
        if (problems.length) next.lastError = problems.join('; ');
      }
    } catch (error) {
      next = { ...next, lastError: (error as Error).message.slice(0, 300) };
      this.deps.logger?.warn('alert evaluation failed', { alert: alert.id, error });
    }
    await this.deps.store.put(teamId, C.alerts, alert.id, next);
    return next;
  }

  private async notifyAlert(dashboard: ValidDashboard, alert: Alert, value: number | null): Promise<string[]> {
    const problems: string[] = [];
    const text = `Alert "${alert.name}" on "${dashboard.title}": ${alert.field} is ${formatNumber(value)} (${alert.op} ${alert.threshold}${alert.op === 'change_pct' ? ' %' : ''}; previous ${formatNumber(alert.lastValue ?? null)}).`;
    if (alert.recipients.length) {
      if (!this.deps.mailer) problems.push('Email is not configured on this server (SMTP_URL).');
      else {
        try {
          await this.deps.mailer.send({ to: alert.recipients, subject: `Alert: ${alert.name}`, text, html: `<p>${escapeHtml(text)}</p>` });
        } catch (error) {
          problems.push(`Email failed: ${(error as Error).message}`);
        }
      }
    }
    if (alert.webhookUrl && alert.webhookSecret) {
      const res = await this.deps.webhooks.send(
        alert.webhookUrl,
        { type: 'alert.fired', alert: { id: alert.id, name: alert.name }, dashboard: { id: dashboard.id, title: dashboard.title }, field: alert.field, value, previous: alert.lastValue ?? null, op: alert.op, threshold: alert.threshold, firedAt: this.now().toISOString() },
        alert.webhookSecret,
      );
      if (!res.ok) problems.push(`Webhook failed: ${res.error ?? `HTTP ${res.status}`}`);
    }
    return problems;
  }

  // ── scheduled refresh (cache warming) ──

  async listRefresh(teamId: string): Promise<RefreshSchedule[]> {
    return (await this.deps.store.list<RefreshSchedule>(teamId, C.refresh)).map((r) => r.data);
  }

  async setRefresh(p: Principal, dashboardId: string, intervalMinutes: number): Promise<RefreshSchedule> {
    await this.requireDashboard(p.teamId, dashboardId);
    const r: RefreshSchedule = {
      dashboardId,
      intervalMinutes,
      owner: p.subject,
      ownerRole: p.role ?? 'editor',
      ...(p.attributes ? { ownerAttributes: structuredClone(p.attributes) } : {}),
      nextRunAt: this.now().toISOString(),
    };
    await this.deps.store.put(p.teamId, C.refresh, dashboardId, r);
    return r;
  }

  /** Re-runs every placed query with the cache bypassed, so the next viewers get fresh cached results. */
  async runRefresh(teamId: string, r: RefreshSchedule): Promise<RefreshSchedule> {
    const at = this.now();
    let lastRun: RunRecord;
    try {
      const dashboard = await this.loadDashboard(teamId, r.dashboardId);
      const ids = dashboard.layout.map((l) => dashboard.widgets[l.i]).flatMap((w) => (w && w.type !== '__unsupported__' && w.query ? [w.query] : []));
      const lines = await this.runQueries(ownerPrincipal(teamId, r), dashboard, ids, { bypassCache: true });
      const failed = [...lines.values()].filter((l) => !l.ok).length;
      lastRun = { at: at.toISOString(), status: failed ? 'failed' : 'ok', message: `${lines.size - failed}/${lines.size} queries refreshed.` };
    } catch (error) {
      lastRun = { at: at.toISOString(), status: 'failed', message: (error as Error).message.slice(0, 300) };
    }
    const next = { ...r, lastRun, nextRunAt: new Date(at.getTime() + r.intervalMinutes * 60_000).toISOString() };
    await this.deps.store.put(teamId, C.refresh, r.dashboardId, next);
    return next;
  }

  // ── metric catalog ──

  readonly metricCatalog: MetricCatalog = {
    get: async (teamId: string) => (await this.deps.store.list<MetricDefinition>(teamId, C.metrics, { limit: 5000 })).map((r) => r.data).sort((a, b) => a.name.localeCompare(b.name)),
  };

  /**
   * Who may change a team's catalog (D-078): `BI_METRIC_OWNERS` lists subjects per team; teams without
   * an entry let every editor change it (the previous behavior).
   */
  private assertMetricOwner(teamId: string, subject: string | undefined) {
    const owners = this.deps.metricOwners?.[teamId];
    if (owners && (!subject || !owners.includes(subject))) {
      throw new PlatformError(403, 'not_metric_owner', 'Only the team\'s metric owners can change the metric catalog.');
    }
  }

  async putMetric(teamId: string, name: string, def: Record<string, unknown>, subject?: string): Promise<MetricDefinition> {
    this.assertMetricOwner(teamId, subject);
    const metric = { ...def, name } as MetricDefinition;
    const problems = validateMetric(metric);
    if (problems.length) throw new PlatformError(422, 'invalid_metric', problems.join('; '));
    await this.deps.store.put(teamId, C.metrics, name, metric);
    await this.recordMetricVersion(teamId, name, metric, subject, 'saved');
    return metric;
  }

  async deleteMetric(teamId: string, name: string, subject?: string): Promise<void> {
    this.assertMetricOwner(teamId, subject);
    const old = await this.deps.store.get<MetricDefinition>(teamId, C.metrics, name);
    if (!old || !(await this.deps.store.delete(teamId, C.metrics, name))) throw new PlatformError(404, 'not_found', `Metric "${name}" was not found.`);
    await this.recordMetricVersion(teamId, name, old.data, subject, 'deleted');
  }

  /** Every change is kept (never overwritten): who, when, what. Newest first. */
  async metricHistory(teamId: string, name: string): Promise<MetricVersion[]> {
    const rows = await this.deps.store.list<MetricVersion>(teamId, C.metricVersions, { prefix: `${name}:`, limit: 500 });
    return rows.map((r) => r.data).sort((a, b) => b.version - a.version);
  }

  private async recordMetricVersion(teamId: string, name: string, metric: MetricDefinition, subject: string | undefined, action: 'saved' | 'deleted') {
    const latest = (await this.metricHistory(teamId, name))[0]?.version ?? 0;
    const version = latest + 1;
    const entry: MetricVersion = { name, version, action, metric, by: subject ?? 'unknown', at: new Date().toISOString() };
    await this.deps.store.put(teamId, C.metricVersions, `${name}:${String(version).padStart(6, '0')}`, entry);
  }
}

/** One change to a catalog metric (D-078). */
export interface MetricVersion {
  name: string;
  version: number;
  action: 'saved' | 'deleted';
  metric: MetricDefinition;
  by: string;
  at: string;
}

/** Same rule as the query layer's metric names (data/metrics.ts): lower-case. */
export const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Baseline checks plus workstream A's `validateMetricDefinition` (from data/metrics.ts) when present.
 * A's function may return string[] of problems, {ok, errors}, or throw; all are accepted.
 */
export function validateMetric(def: MetricDefinition): string[] {
  const problems: string[] = [];
  if (!METRIC_NAME.test(def.name)) problems.push('name must be lower-case letters, digits and "_", starting with a letter (max 64)');
  if (def.label !== undefined && (typeof def.label !== 'string' || def.label.length > 200)) problems.push('label must be a string of at most 200 characters');
  if (def.description !== undefined && (typeof def.description !== 'string' || def.description.length > 2000)) problems.push('description must be at most 2000 characters');
  const external = (metricsModule as Record<string, unknown>).validateMetricDefinition;
  if (typeof external === 'function') {
    try {
      const r = (external as (d: unknown) => unknown)(def);
      if (Array.isArray(r)) problems.push(...r.map((x) => (typeof x === 'string' ? x : String((x as { message?: string }).message ?? x))));
      else if (r && typeof r === 'object' && (r as { ok?: boolean }).ok === false) {
        const errs = (r as { errors?: unknown[]; message?: string }).errors;
        problems.push(...(errs?.length ? errs.map((e) => (typeof e === 'string' ? e : String((e as { message?: string }).message ?? e))) : [String((r as { message?: string }).message ?? 'invalid metric')]));
      }
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
}
