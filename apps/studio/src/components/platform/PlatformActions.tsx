import { outputColumns, type Dimension, type Measure } from '@yourorg/bi-spec';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  isRouteMissing,
  type AlertInfo,
  type CatalogMetric,
  type DashboardComment,
  type PlatformStatus,
  type RefreshInfo,
  type StudioApi,
  type SubscriptionInfo,
} from '../../api/studioApi';
import type { DraftSpec } from '../../draft/types';
import { Modal } from '../Modal';
import './platform.css';

/**
 * Platform actions in the Studio top bar (workstream D): comments, schedules (email subscriptions and
 * cache refresh), data alerts, and the team metric catalog. Dashboard-scoped features need a saved
 * dashboard (they run what was saved, never the draft).
 */

type Panel = 'comments' | 'schedule' | 'alerts' | 'metrics' | null;

export function PlatformActions({ api, draft, savedVersion, dirty }: { api: StudioApi; draft: DraftSpec; savedVersion: number; dirty: boolean }) {
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState<Panel>(null);

  useEffect(() => {
    let cancelled = false;
    api.platformStatus().then(
      (s) => !cancelled && setStatus(s),
      (e: unknown) => !cancelled && setAvailable(!isRouteMissing(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!available || !status) return null;
  const saved = savedVersion > 0;
  const editor = status.me.role === 'editor';
  const needSave = saved ? undefined : 'Save first: these work on the saved dashboard';
  const close = () => setOpen(null);

  return (
    <>
      <div className="btn-group platform-actions" role="group" aria-label="Collaboration">
        <button type="button" className="btn ghost small" disabled={!saved} title={needSave ?? 'Comments'} onClick={() => setOpen('comments')}>
          Comments
        </button>
        {editor && (
          <button type="button" className="btn ghost small" disabled={!saved} title={needSave ?? 'Email subscriptions and scheduled refresh'} onClick={() => setOpen('schedule')}>
            Schedule
          </button>
        )}
        {editor && (
          <button type="button" className="btn ghost small" disabled={!saved} title={needSave ?? 'Data alerts'} onClick={() => setOpen('alerts')}>
            Alerts
          </button>
        )}
        <button type="button" className="btn ghost small" title="Team metric catalog" onClick={() => setOpen('metrics')}>
          Metrics
        </button>
      </div>
      {open === 'comments' && <CommentsDialog api={api} draft={draft} status={status} onClose={close} />}
      {open === 'schedule' && <ScheduleDialog api={api} draft={draft} status={status} dirty={dirty} onClose={close} />}
      {open === 'alerts' && <AlertsDialog api={api} draft={draft} status={status} onClose={close} />}
      {open === 'metrics' && <MetricsDialog api={api} editor={editor} onClose={close} />}
    </>
  );
}

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    load().then(setData, (e: unknown) => setError((e as Error).message));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, setError, reload };
}

const widgetLabel = (draft: DraftSpec, id: string) => {
  const w = draft.widgets[id];
  const t = (w?.options?.title ?? w?.options?.label) as string | undefined;
  return t ? `${t} (${id})` : id;
};

// ── comments ──

function CommentsDialog({ api, draft, status, onClose }: { api: StudioApi; draft: DraftSpec; status: PlatformStatus; onClose: () => void }) {
  const load = useCallback(() => api.listComments(draft.id), [api, draft.id]);
  const { data, error, setError, reload } = useLoad<DashboardComment[]>(load);
  const [body, setBody] = useState('');
  const [widgetId, setWidgetId] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await api.addComment(draft.id, body.trim(), widgetId || undefined);
      setBody('');
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const act = (fn: () => Promise<unknown>) => () => void fn().then(reload, (err: unknown) => setError((err as Error).message));

  return (
    <Modal title="Comments" onClose={onClose} wide>
      {error && <p className="note small">{error}</p>}
      {!data && !error && <p className="muted small">Loading…</p>}
      {data?.length === 0 && <p className="muted small">No comments yet.</p>}
      {data && data.length > 0 && (
        <ul className="platform-list" aria-label="Comments">
          {data.map((c) => {
            const mine = c.author === status.me.subject;
            return (
              <li key={c.id}>
                <div className="grow">
                  <span className="muted small">
                    <strong>{c.author}</strong> · {new Date(c.createdAt).toLocaleString()}
                    {c.editedAt ? ' · edited' : ''}
                    {c.widgetId ? <> · on <code>{widgetLabel(draft, c.widgetId)}</code></> : null}
                  </span>
                  {editing?.id === c.id ? (
                    <div className="row gap-s">
                      <textarea aria-label="Edit comment" value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} rows={2} />
                      <button type="button" className="btn small" onClick={act(async () => (await api.editComment(draft.id, c.id, editing.body), setEditing(null)))}>
                        Save
                      </button>
                    </div>
                  ) : (
                    <p className="comment-body">{c.body}</p>
                  )}
                </div>
                <div className="row gap-s">
                  {mine && editing?.id !== c.id && (
                    <button type="button" className="btn small ghost" onClick={() => setEditing({ id: c.id, body: c.body })}>
                      Edit
                    </button>
                  )}
                  {(mine || status.me.role === 'editor') && (
                    <button type="button" className="btn small ghost danger" onClick={act(() => api.deleteComment(draft.id, c.id))}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <form className="platform-form" onSubmit={(e) => void submit(e)}>
        <textarea aria-label="New comment" placeholder="Add a comment…" value={body} maxLength={4000} rows={3} onChange={(e) => setBody(e.target.value)} />
        <div className="row gap-s">
          <select aria-label="Comment on widget" value={widgetId} onChange={(e) => setWidgetId(e.target.value)}>
            <option value="">Whole dashboard</option>
            {Object.keys(draft.widgets).map((id) => (
              <option key={id} value={id}>
                {widgetLabel(draft, id)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn primary small" disabled={!body.trim()}>
            Comment
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── schedules: email subscriptions + scheduled refresh ──

const localTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const parseEmails = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function ScheduleDialog({ api, draft, status, dirty, onClose }: { api: StudioApi; draft: DraftSpec; status: PlatformStatus; dirty: boolean; onClose: () => void }) {
  const load = useCallback(async () => ({ subs: await api.listSubscriptions(draft.id), refresh: (await api.listRefresh()).find((r) => r.dashboardId === draft.id) ?? null }), [api, draft.id]);
  const { data, error, setError, reload } = useLoad<{ subs: SubscriptionInfo[]; refresh: RefreshInfo | null }>(load);
  const [name, setName] = useState('Daily summary');
  const [recipients, setRecipients] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [time, setTime] = useState('08:00');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timezone, setTimezone] = useState(localTz);
  const [includeKpis, setIncludeKpis] = useState(true);
  const [widgets, setWidgets] = useState<string[]>([]);
  const run = (fn: () => Promise<unknown>) => void fn().then(reload, (err: unknown) => setError((err as Error).message));

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(() =>
      api.createSubscription({
        dashboardId: draft.id,
        name,
        recipients: parseEmails(recipients),
        schedule: { frequency, time, timezone, ...(frequency === 'weekly' ? { dayOfWeek } : {}), ...(frequency === 'monthly' ? { dayOfMonth } : {}) },
        widgets,
        includeKpis,
      }),
    );
  };

  return (
    <Modal title="Schedule" onClose={onClose} wide>
      {dirty && <p className="note small">Schedules use the saved version, not your unsaved changes.</p>}
      {!status.email && <p className="note small">Email is not configured on this server: subscriptions are recorded but not delivered until an admin sets SMTP_URL.</p>}
      {!status.scheduler && <p className="note small">The scheduler is off on this server (BI_SCHEDULER): nothing runs on schedule.</p>}
      {error && <p className="note small">{error}</p>}
      <h3 className="panel-label">Email subscriptions</h3>
      {data?.subs.length === 0 && <p className="muted small">None yet.</p>}
      {data && data.subs.length > 0 && (
        <ul className="platform-list" aria-label="Subscriptions">
          {data.subs.map((s) => (
            <li key={s.id}>
              <div className="grow">
                <strong>{s.name}</strong>
                <span className="muted small">
                  {s.schedule.frequency} at {s.schedule.time} {s.schedule.timezone} · to {s.recipients.join(', ')} · next {new Date(s.nextRunAt).toLocaleString()}
                  {s.lastRun ? ` · last: ${s.lastRun.status}${s.lastRun.message ? ` (${s.lastRun.message})` : ''}` : ''}
                </span>
              </div>
              <button type="button" className="btn small" onClick={() => run(() => api.runSubscription(s.id))}>
                Send now
              </button>
              <button type="button" className="btn small ghost danger" onClick={() => run(() => api.deleteSubscription(s.id))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="platform-form" onSubmit={create} aria-label="New subscription">
        <div className="platform-grid">
          <label className="field-label">
            Name
            <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field-label">
            Recipients
            <input value={recipients} placeholder="ana@example.com, team@example.com" onChange={(e) => setRecipients(e.target.value)} />
          </label>
          <label className="field-label">
            Frequency
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          {frequency === 'weekly' && (
            <label className="field-label">
              Day
              <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}
          {frequency === 'monthly' && (
            <label className="field-label">
              Day of month
              <input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} />
            </label>
          )}
          <label className="field-label">
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label className="field-label">
            Time zone
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </label>
        </div>
        <label className="row gap-s small">
          <input type="checkbox" checked={includeKpis} onChange={(e) => setIncludeKpis(e.target.checked)} /> Include KPI values in the email
        </label>
        <fieldset className="platform-checks">
          <legend className="small muted">Attach data as CSV</legend>
          {Object.keys(draft.widgets)
            .filter((id) => draft.widgets[id]?.query)
            .map((id) => (
              <label key={id} className="row gap-s small">
                <input type="checkbox" checked={widgets.includes(id)} onChange={(e) => setWidgets((w) => (e.target.checked ? [...w, id] : w.filter((x) => x !== id)))} />
                {widgetLabel(draft, id)}
              </label>
            ))}
        </fieldset>
        <button type="submit" className="btn primary small" disabled={!name.trim() || parseEmails(recipients).length === 0}>
          Create subscription
        </button>
      </form>

      <h3 className="panel-label">Scheduled refresh</h3>
      <p className="muted small">Re-runs this dashboard’s queries on a schedule so viewers get freshly cached results. (Data is still queried live; there are no stored extracts.)</p>
      <label className="field-label">
        Refresh every
        <select
          aria-label="Refresh every"
          value={data?.refresh?.intervalMinutes ?? 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            run(() => (v ? api.setRefresh(draft.id, v) : api.deleteRefresh(draft.id)));
          }}
        >
          <option value={0}>Off</option>
          <option value={15}>15 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={60}>hour</option>
          <option value={240}>4 hours</option>
          <option value={1440}>day</option>
        </select>
      </label>
      {data?.refresh?.lastRun && (
        <p className="muted small">
          Last refresh: {data.refresh.lastRun.status} ({data.refresh.lastRun.message}) at {new Date(data.refresh.lastRun.at).toLocaleString()}
        </p>
      )}
    </Modal>
  );
}

// ── alerts ──

const OPS: Array<[string, string]> = [
  ['gt', 'is above'],
  ['gte', 'is at least'],
  ['lt', 'is below'],
  ['lte', 'is at most'],
  ['eq', 'equals'],
  ['neq', 'is not'],
  ['change_pct', 'changes by at least (%)'],
];

function AlertsDialog({ api, draft, status, onClose }: { api: StudioApi; draft: DraftSpec; status: PlatformStatus; onClose: () => void }) {
  const load = useCallback(() => api.listAlerts(draft.id), [api, draft.id]);
  const { data, error, setError, reload } = useLoad<AlertInfo[]>(load);
  const queryWidgets = Object.keys(draft.widgets).filter((id) => draft.widgets[id]?.query);
  const [widgetId, setWidgetId] = useState(queryWidgets[0] ?? '');
  const queryId = draft.widgets[widgetId]?.query ?? '';
  const q = draft.queries[queryId];
  const columns = q ? outputColumns({ dimensions: (q.dimensions ?? []) as Dimension[], measures: (q.measures ?? []) as Measure[] }) : [];
  const numeric = columns.filter((c) => c.role === 'measure').map((c) => c.name);
  const [name, setName] = useState('');
  const [field, setField] = useState('');
  const [op, setOp] = useState('gt');
  const [threshold, setThreshold] = useState('0');
  const [reduce, setReduce] = useState('sum');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [recipients, setRecipients] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const effectiveField = field && numeric.includes(field) ? field : (numeric[0] ?? '');
  const run = (fn: () => Promise<unknown>) => void fn().then(reload, (err: unknown) => setError((err as Error).message));

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const res = await api.createAlert({
        dashboardId: draft.id,
        name: name || `${effectiveField} alert`,
        queryId,
        field: effectiveField,
        reduce,
        op,
        threshold: Number(threshold),
        intervalMinutes,
        recipients: parseEmails(recipients),
        ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
      });
      setSecret(res.webhookSecret ?? null);
    });
  };

  return (
    <Modal title="Data alerts" onClose={onClose} wide>
      {!status.email && <p className="note small">Email is not configured on this server; alerts can still call webhooks.</p>}
      {error && <p className="note small">{error}</p>}
      {secret && (
        <p className="note small" role="status">
          Webhook signing secret (shown once): <code>{secret}</code>. Verify <code>X-Sratchpad-Signature</code> = sha256 HMAC of “timestamp.body”.
        </p>
      )}
      {data?.length === 0 && <p className="muted small">No alerts yet.</p>}
      {data && data.length > 0 && (
        <ul className="platform-list" aria-label="Alerts">
          {data.map((a) => (
            <li key={a.id} data-state={a.state}>
              <div className="grow">
                <strong>{a.name}</strong> <span className={`badge state-${a.state}`}>{a.state}</span>
                <span className="muted small">
                  {a.reduce}({a.field}) {OPS.find(([k]) => k === a.op)?.[1] ?? a.op} {a.threshold} · every {a.intervalMinutes} min
                  {a.lastValue !== undefined ? ` · last value ${a.lastValue ?? '–'}` : ''}
                  {a.lastError ? ` · ${a.lastError}` : ''}
                </span>
              </div>
              <button type="button" className="btn small" onClick={() => run(() => api.testAlert(a.id))}>
                Check now
              </button>
              <button type="button" className="btn small ghost danger" onClick={() => run(() => api.deleteAlert(a.id))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="platform-form" onSubmit={create} aria-label="New alert">
        <div className="platform-grid">
          <label className="field-label">
            Name
            <input value={name} maxLength={100} placeholder="Revenue drop" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field-label">
            Widget
            <select value={widgetId} onChange={(e) => setWidgetId(e.target.value)}>
              {queryWidgets.map((id) => (
                <option key={id} value={id}>
                  {widgetLabel(draft, id)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Value
            <select value={reduce} onChange={(e) => setReduce(e.target.value)} aria-label="Reduce">
              {['sum', 'avg', 'min', 'max', 'first', 'last', 'count'].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            of
            <select value={effectiveField} onChange={(e) => setField(e.target.value)} aria-label="Field">
              {numeric.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Condition
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              {OPS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Threshold
            <input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </label>
          <label className="field-label">
            Check every
            <select value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
              {[15, 30, 60, 240, 1440].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : m === 60 ? 'hour' : m === 1440 ? 'day' : `${m / 60} hours`}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Email
            <input value={recipients} placeholder="ops@example.com" onChange={(e) => setRecipients(e.target.value)} />
          </label>
          <label className="field-label">
            Webhook (https)
            <input value={webhookUrl} placeholder="https://hooks.example.com/…" onChange={(e) => setWebhookUrl(e.target.value)} />
          </label>
        </div>
        <button type="submit" className="btn primary small" disabled={!queryId || !effectiveField || (!parseEmails(recipients).length && !webhookUrl.trim())}>
          Create alert
        </button>
        <p className="muted small">An alert notifies when it starts firing, not on every check while it stays firing.</p>
      </form>
    </Modal>
  );
}

// ── metric catalog ──

function MetricsDialog({ api, editor, onClose }: { api: StudioApi; editor: boolean; onClose: () => void }) {
  const load = useCallback(() => api.metricCatalog(), [api]);
  const { data, error, setError, reload } = useLoad<CatalogMetric[]>(load);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [definition, setDefinition] = useState('{\n  "field": "amount",\n  "agg": "sum"\n}');
  const run = (fn: () => Promise<unknown>) => void fn().then(reload, (err: unknown) => setError((err as Error).message));

  const save = (e: FormEvent) => {
    e.preventDefault();
    let def: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(definition);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      def = parsed as Record<string, unknown>;
    } catch {
      setError('The definition must be a JSON object.');
      return;
    }
    setError(null);
    run(() => api.putMetric(name, { ...def, ...(label ? { label } : {}), ...(description ? { description } : {}) }));
  };
  const edit = (m: CatalogMetric) => {
    const { name: n, label: l, description: d, ...rest } = m;
    setName(n);
    setLabel(l ?? '');
    setDescription(d ?? '');
    setDefinition(JSON.stringify(rest, null, 2));
  };

  return (
    <Modal title="Team metric catalog" onClose={onClose} wide>
      <p className="muted small">Named metrics defined once for the whole team; queries reference them by name. {editor ? '' : 'Only editors can change them.'}</p>
      {error && <p className="note small">{error}</p>}
      {data?.length === 0 && <p className="muted small">No metrics yet.</p>}
      {data && data.length > 0 && (
        <ul className="platform-list" aria-label="Metrics">
          {data.map((m) => (
            <li key={m.name}>
              <div className="grow">
                <strong>
                  <code>{m.name}</code> {m.label ? `· ${m.label}` : ''}
                </strong>
                {m.description && <span className="muted small">{m.description}</span>}
              </div>
              {editor && (
                <>
                  <button type="button" className="btn small ghost" onClick={() => edit(m)}>
                    Edit
                  </button>
                  <button type="button" className="btn small ghost danger" onClick={() => run(() => api.deleteMetric(m.name))}>
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editor && (
        <form className="platform-form" onSubmit={save} aria-label="Metric definition">
          <div className="platform-grid">
            <label className="field-label">
              Name
              <input value={name} placeholder="revenue" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field-label">
              Label
              <input value={label} placeholder="Revenue" onChange={(e) => setLabel(e.target.value)} />
            </label>
          </div>
          <label className="field-label">
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field-label">
            Definition (JSON)
            <textarea aria-label="Definition" value={definition} rows={5} onChange={(e) => setDefinition(e.target.value)} spellCheck={false} />
          </label>
          <button type="submit" className="btn primary small" disabled={!/^[a-z][a-z0-9_]{0,63}$/.test(name)}>
            Save metric
          </button>
        </form>
      )}
    </Modal>
  );
}
