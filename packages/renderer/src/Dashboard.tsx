import { validateDashboard, type StoredDashboard, type ValidationResult } from '@yourorg/bi-spec';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BIContext, Root, type Theme } from './context';
import { BIRequestError, createHttpDataClient, type DataClient } from './data/client';
import { DashboardView } from './DashboardView';
import { ROW_HEIGHT, GAP } from './layout/Grid';
import { Message } from './widgets/Message';

export interface DashboardProps {
  id: string;
  /** Bearer token, or a function returning a fresh one. */
  token?: string | (() => string | Promise<string>);
  /** Values for the dashboard's params, e.g. { dateRange: 'last_30d' }. */
  params?: Record<string, unknown>;
  /** Pin a stored version. Default: latest. */
  version?: number;
  apiUrl?: string;
  client?: DataClient;
  fetch?: typeof fetch;
  locale?: string;
  currency?: string;
  theme?: Theme;
  showHeader?: boolean;
  className?: string;
  onError?: (error: Error) => void;
  onLoad?: (dashboard: StoredDashboard) => void;
  /**
   * Drill-through (spec 1.3): a widget asks to open another dashboard with these param values.
   * The host decides (route to a page rendering <Dashboard id={dashboardId} params={params} />).
   * Share tokens are confined to one dashboard, so viewer links can't follow drill-throughs.
   */
  onNavigate?: (request: { dashboardId: string; params: Record<string, unknown> }) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; stored: StoredDashboard; validation: ValidationResult };

function describeError(error: Error): { title: string; detail?: string } {
  if (error instanceof BIRequestError) {
    if (error.status === 404) return { title: 'Dashboard not found', detail: error.message };
    if (error.status === 401 || error.status === 403) return { title: 'Not authorized to view this dashboard', detail: error.message };
  }
  return { title: 'Couldn’t load this dashboard', detail: error.message };
}

function LoadingGrid() {
  return (
    <div className="bi-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: GAP }} aria-busy="true" aria-label="Loading dashboard">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bi-skeleton" style={{ height: ROW_HEIGHT * 2 + GAP }} />
      ))}
    </div>
  );
}

/**
 * The drop-in component. A host app installs the SDK, renders
 *   <Dashboard id="dash_9f2a" token={authToken} params={{ dateRange: 'last_30d' }} />
 * and a dashboard appears. It fetches the JSON, gates on specVersion, and renders.
 */
export function Dashboard(props: DashboardProps) {
  const ctx = useContext(BIContext);
  const { id, version } = props;
  const apiUrl = props.apiUrl ?? ctx.apiUrl ?? '/bi-api';
  // Read the transport through a ref: an inline `fetch={...}` prop is a new function every render,
  // and rebuilding the client on identity changes would reload the dashboard in a loop.
  const fetchRef = useRef(props.fetch ?? ctx.fetch);
  fetchRef.current = props.fetch ?? ctx.fetch;
  const hasFetch = fetchRef.current !== undefined;
  // The token may change (refresh) without rebuilding the client or dropping its cache.
  const tokenRef = useRef(props.token);
  tokenRef.current = props.token;
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;
  const onLoadRef = useRef(props.onLoad);
  onLoadRef.current = props.onLoad;

  const client = useMemo<DataClient>(
    () =>
      props.client ??
      ctx.client ??
      createHttpDataClient({
        apiUrl,
        fetch: hasFetch ? (...args) => fetchRef.current!(...args) : undefined,
        token: async () => {
          const t = tokenRef.current;
          const value = typeof t === 'function' ? await t() : t;
          if (!value) throw new BIRequestError(401, 'missing_token', 'No auth token was provided to <Dashboard>.');
          return value;
        },
      }),
    [props.client, ctx.client, apiUrl, hasFetch],
  );

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    client.getDashboard(id, version).then(
      (stored) => {
        if (cancelled) return;
        const validation = validateDashboard(stored.spec);
        setState({ status: 'ready', stored, validation });
        if (validation.ok) onLoadRef.current?.(stored);
        else onErrorRef.current?.(new Error(validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')));
      },
      (error: unknown) => {
        if (cancelled) return;
        const err = error instanceof Error ? error : new Error(String(error));
        setState({ status: 'error', error: err });
        onErrorRef.current?.(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, id, version]);

  const theme = props.theme ?? ctx.theme;
  if (state.status === 'loading') {
    return (
      <Root theme={theme} className={props.className}>
        <LoadingGrid />
      </Root>
    );
  }
  if (state.status === 'error') {
    return (
      <Root theme={theme} className={props.className}>
        <Message tone="error" {...describeError(state.error)} />
      </Root>
    );
  }
  const { validation, stored } = state;
  if (!validation.ok) {
    const first = validation.errors[0];
    return (
      <Root theme={theme} className={props.className}>
        <Message
          tone="error"
          title="This dashboard can’t be displayed"
          detail={first?.code === 'unsupported_version' ? first.message : `${validation.errors.length} problem(s), first: ${first?.path}: ${first?.message}`}
        />
      </Root>
    );
  }
  return (
    <DashboardView
      dashboard={validation.dashboard}
      version={stored.version}
      client={client}
      params={props.params}
      compatibility={validation.compatibility}
      locale={props.locale ?? ctx.locale}
      currency={props.currency ?? ctx.currency}
      theme={theme}
      showHeader={props.showHeader}
      onNavigate={props.onNavigate}
      className={props.className}
    />
  );
}
