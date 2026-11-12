import { Dashboard } from '@yourorg/bi-renderer';
import { DATE_PRESETS, type ShareIntrospection, type StoredDashboard } from '@yourorg/bi-spec';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The hosted, read-only viewer for business users. A share link looks like
 *   https://<viewer>/#token=bis_…
 * The token sits in the URL fragment, which browsers never send to servers, proxies or logs. The page
 * asks the API what the token grants (GET /v1/share), then renders that one dashboard with controls
 * for its params. Nothing here can edit anything: the token itself is read-only.
 */

export const PRESET_LABEL: Record<string, string> = {
  last_7d: 'Last 7 days',
  last_30d: 'Last 30 days',
  last_90d: 'Last 90 days',
  last_365d: 'Last 12 months',
  mtd: 'Month to date',
  qtd: 'Quarter to date',
  ytd: 'Year to date',
  all: 'All time',
};

export function readToken(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('token');
  return token && /^bis_[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

type ParamDef = {
  type: string;
  label?: string;
  default?: unknown;
  options?: unknown[];
  /** multiselect (1.3): choices from a saved query's column. */
  optionsQuery?: { query: string; field: string };
  /** range (1.3) */
  kind?: 'number' | 'date';
  min?: number | string;
  max?: number | string;
  step?: number;
};

/** What a param control needs to read options from the dashboard's own saved queries. */
interface OptionsSource {
  apiUrl: string;
  token: string;
  dashboardId: string;
  version?: number;
  fetch: typeof fetch;
  values: Record<string, unknown>;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; title: string; detail: string }
  | { status: 'ready'; info: ShareIntrospection };

export interface ViewerProps {
  hash: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

/** Module-level, so it is the same function on every render. */
const globalFetch: typeof fetch = (...a) => globalThis.fetch(...a);

export function Viewer({ hash, apiUrl = '/bi-api', fetch: fetchProp }: ViewerProps) {
  const token = useMemo(() => readToken(hash), [hash]);
  // <Dashboard> rebuilds its data client (and reloads) when `fetch` changes identity, so hand it one
  // stable function that always calls the latest transport. An inline `fetch` prop must not loop.
  const fetchRef = useRef(fetchProp ?? globalFetch);
  fetchRef.current = fetchProp ?? globalFetch;
  const fetchImpl = useMemo<typeof fetch>(() => (...a) => fetchRef.current(...a), []);
  const [state, setState] = useState<State>(
    token ? { status: 'loading' } : { status: 'error', title: 'This link is incomplete', detail: 'Ask the person who shared the dashboard to send the full link again.' },
  );
  const [paramDefs, setParamDefs] = useState<Record<string, ParamDef>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchImpl(`${apiUrl}/v1/share`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setState({ status: 'error', title: 'This link no longer works', detail: 'It may have expired or been revoked. Ask the dashboard owner for a new link.' });
        } else if (!res.ok) {
          setState({ status: 'error', title: 'Couldn’t open this dashboard', detail: `The server answered ${res.status}. Try again in a moment.` });
        } else {
          const info = (await res.json()) as ShareIntrospection;
          setState({ status: 'ready', info });
          document.title = info.dashboard.title;
        }
      })
      .catch(() => !cancelled && setState({ status: 'error', title: 'Couldn’t reach the dashboard server', detail: 'Check your connection and reload the page.' }));
    return () => {
      cancelled = true;
    };
  }, [token, apiUrl, fetchImpl]);

  if (state.status === 'loading') return <main className="viewer viewer-center" aria-busy="true">Loading…</main>;
  if (state.status === 'error') {
    return (
      <main className="viewer viewer-center">
        <div className="viewer-message" role="alert">
          <h1>{state.title}</h1>
          <p>{state.detail}</p>
        </div>
      </main>
    );
  }

  const { share, dashboard } = state.info;
  const onLoad = (stored: StoredDashboard) => {
    const params = ((stored.spec as { params?: Record<string, ParamDef> }).params ?? {}) as Record<string, ParamDef>;
    setParamDefs(params);
  };

  return (
    <main className="viewer">
      <header className="viewer-bar">
        <div className="viewer-heading">
          <h1>{dashboard.title}</h1>
          <span className="viewer-meta">
            Read-only{share.version ? ` · version ${share.version}` : ''}
            {share.expiresAt ? ` · link expires ${new Date(share.expiresAt).toLocaleDateString()}` : ''}
          </span>
        </div>
        <div className="viewer-controls">
          {Object.entries(paramDefs).map(([name, p]) => (
            <ParamControl
              key={name}
              name={name}
              def={p}
              value={values[name] ?? p.default}
              onChange={(v) => setValues((s) => ({ ...s, [name]: v }))}
              source={{ apiUrl, token: token!, dashboardId: share.dashboardId, version: share.version, fetch: fetchImpl, values }}
            />
          ))}
          <button type="button" className="viewer-print" onClick={() => window.print()} title="Print, or save as PDF from the print dialog">
            Print / PDF
          </button>
        </div>
      </header>
      <Dashboard
        id={share.dashboardId}
        version={share.version}
        token={token!}
        apiUrl={apiUrl}
        fetch={fetchImpl}
        params={values}
        theme="auto"
        showHeader={false}
        onLoad={onLoad}
      />
    </main>
  );
}

/**
 * Choices of a multiselect with `optionsQuery`: the distinct values of a column of one of the
 * dashboard's saved queries, fetched with the current param values (so a param bound to that query
 * cascades: pick a region, the country list narrows). Uses the same data route as the widgets.
 */
function useQueryOptions(def: ParamDef, source: OptionsSource | undefined): unknown[] | undefined {
  const [options, setOptions] = useState<unknown[]>();
  const valuesKey = JSON.stringify(source?.values ?? {});
  useEffect(() => {
    if (!def.optionsQuery || !source) return;
    let cancelled = false;
    const { query, field } = def.optionsQuery;
    source
      .fetch(`${source.apiUrl}/v1/dashboards/${encodeURIComponent(source.dashboardId)}/data`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${source.token}`, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ queries: [query], params: source.values, ...(source.version ? { version: source.version } : {}) }),
      })
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        if (cancelled) return;
        const line = text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { id: string; ok: boolean; result?: { rows: Array<Record<string, unknown>> } })
          .find((l) => l.id === query);
        const values = line?.ok ? [...new Set(line.result!.rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined))] : [];
        setOptions(values.slice(0, 500));
      })
      .catch(() => !cancelled && setOptions([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.optionsQuery?.query, def.optionsQuery?.field, source?.dashboardId, valuesKey]);
  return def.optionsQuery ? options : def.options;
}

function SearchControl({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  // Debounced: each keystroke doesn't re-run every widget's query.
  useEffect(() => {
    if (text === value) return;
    const t = setTimeout(() => onChange(text), 300);
    return () => clearTimeout(t);
  }, [text, value, onChange]);
  return (
    <label className="viewer-control">
      <span>{label}</span>
      <input type="search" aria-label={label} value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="Search…" />
    </label>
  );
}

function ParamControl({ name, def, value, onChange, source }: { name: string; def: ParamDef; value: unknown; onChange: (v: unknown) => void; source?: OptionsSource }) {
  const label = def.label ?? name;
  const queryOptions = useQueryOptions(def, def.type === 'multiselect' ? source : undefined);
  if (def.type === 'multiselect') {
    const opts = queryOptions ?? [];
    const selected = Array.isArray(value) ? value : [];
    return (
      <label className="viewer-control">
        <span>{label}</span>
        <select
          multiple
          aria-label={label}
          size={Math.min(5, Math.max(2, opts.length))}
          value={selected.map((v) => String(opts.indexOf(v)))}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => opts[Number(o.value)]))}
        >
          {opts.map((o, i) => (
            <option key={i} value={i}>
              {String(o)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === 'range') {
    const [lo, hi] = Array.isArray(value) ? (value as [unknown, unknown]) : [null, null];
    const isDate = def.kind === 'date';
    const parse = (v: string) => (v === '' ? null : isDate ? v : Number(v));
    const set = (i: 0 | 1, v: string) => {
      const next: [unknown, unknown] = [lo, hi];
      next[i] = parse(v);
      onChange(next[0] === null && next[1] === null ? null : next);
    };
    return (
      <fieldset className="viewer-control viewer-range">
        <legend>{label}</legend>
        <input type={isDate ? 'date' : 'number'} aria-label={`${label} from`} value={lo === null || lo === undefined ? '' : String(lo)} min={def.min as never} max={def.max as never} step={def.step} onChange={(e) => set(0, e.target.value)} />
        <span aria-hidden="true">–</span>
        <input type={isDate ? 'date' : 'number'} aria-label={`${label} to`} value={hi === null || hi === undefined ? '' : String(hi)} min={def.min as never} max={def.max as never} step={def.step} onChange={(e) => set(1, e.target.value)} />
      </fieldset>
    );
  }
  if (def.type === 'search') return <SearchControl label={label} value={typeof value === 'string' ? value : ''} onChange={onChange} />;
  if (def.type === 'measure') {
    const opts = (def.options ?? []) as Array<{ value: string; label?: string }>;
    return (
      <label className="viewer-control">
        <span>{label}</span>
        <select aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label ?? o.value}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === 'daterange') {
    // Custom from/to ranges set by the author are kept as-is; viewers pick from the presets.
    const current = typeof value === 'string' ? value : 'custom';
    return (
      <label className="viewer-control">
        <span>{label}</span>
        <select aria-label={label} value={current} onChange={(e) => onChange(e.target.value)}>
          {current === 'custom' && <option value="custom">Custom range</option>}
          {DATE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABEL[p] ?? p}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === 'select' && Array.isArray(def.options) && def.options.length) {
    const index = def.options.findIndex((o) => o === value);
    return (
      <label className="viewer-control">
        <span>{label}</span>
        <select aria-label={label} value={index < 0 ? '' : String(index)} onChange={(e) => onChange(e.target.value === '' ? null : def.options![Number(e.target.value)])}>
          <option value="">All</option>
          {def.options.map((o, i) => (
            <option key={i} value={i}>
              {String(o)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return null;
}
