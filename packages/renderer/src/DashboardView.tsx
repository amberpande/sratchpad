import { effectiveParamValues, layoutItemTab, paramsForQuery, stableStringify, widgetQueryId, type Compatibility, type ValidDashboard } from '@yourorg/bi-spec';
import { requestKey, type QueryRuntime } from './data/client';
import { InteractionContext } from './interactions';
import { useInteractionEngine, type NavigateRequest } from './interactionEngine';
import { useEffect, useMemo, useState } from 'react';
import { Root, type Theme } from './context';
import type { DataClient } from './data/client';
import { DashboardAsOfContext, Freshness, oldestAsOf } from './Freshness';
import { Grid } from './layout/Grid';
import { themeVars } from './theme';
import { DashboardToolbar } from './export/WidgetMenu';
import { WidgetFrame, type QueryState } from './widgets/WidgetFrame';

export interface DashboardViewProps {
  dashboard: ValidDashboard;
  /** The stored version the spec came from; data requests are pinned to it. */
  version: number;
  client: DataClient;
  params?: Record<string, unknown>;
  compatibility?: Compatibility;
  locale?: string;
  currency?: string;
  theme?: Theme;
  showHeader?: boolean;
  className?: string;
  /** Drill-through: a widget asks to open another dashboard (the host decides how). */
  onNavigate?: (request: NavigateRequest) => void;
}

const LOADING: QueryState = { status: 'loading' };

/** Renders an already-validated dashboard. <Dashboard> fetches and validates, then renders this. */
export function DashboardView({
  dashboard,
  version,
  client,
  params,
  compatibility,
  locale = 'en-US',
  currency = 'USD',
  theme,
  showHeader = true,
  className,
  onNavigate,
}: DashboardViewProps) {
  // Hosts often pass params inline ({{ dateRange }}), so key effects on the value, not identity.
  const paramsKey = stableStringify(params ?? {});
  const values = useMemo(
    () =>
      effectiveParamValues(dashboard, JSON.parse(paramsKey) as Record<string, unknown>, (name, message) =>
        console.warn(`[bi-renderer] ignoring param "${name}": ${message}`),
      ),
    [dashboard, paramsKey],
  );

  // Tabs (1.3): only the active tab's widgets are placed, and only their queries run.
  const tabs = dashboard.tabs;
  const [activeTab, setActiveTab] = useState<string | undefined>(tabs?.[0]?.id);
  const currentTab = tabs?.some((t) => t.id === activeTab) ? activeTab : tabs?.[0]?.id;
  const visibleLayout = useMemo(
    () => (tabs?.length ? dashboard.layout.filter((it) => layoutItemTab(it, tabs) === currentTab) : dashboard.layout),
    [dashboard.layout, tabs, currentTab],
  );

  const { engine, runtimeFor } = useInteractionEngine(dashboard, onNavigate);

  // One request per distinct (query, variant): widgets sharing a query and variant share a result.
  const requests = useMemo(() => {
    const byKey = new Map<string, { queryId: string; runtime?: QueryRuntime }>();
    const keyOf: Record<string, string> = {};
    for (const item of visibleLayout) {
      const widget = dashboard.widgets[item.i];
      const id = widget && widget.type !== '__unsupported__' ? widgetQueryId(widget) : undefined;
      if (!id) continue;
      const runtime = runtimeFor(item.i);
      const key = requestKey(id, runtime);
      keyOf[item.i] = key;
      if (!byKey.has(key)) byKey.set(key, { queryId: id, runtime });
    }
    return { list: [...byKey.entries()].map(([key, r]) => ({ key, ...r })), keyOf };
    // runtimeFor reads the engine state, which `engine` changes with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, visibleLayout, engine]);
  const requestsKey = stableStringify(requests.list);
  const queryIds = useMemo(() => requests.list.map((r) => r.key), [requestsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [states, setStates] = useState<Record<string, QueryState>>({});

  useEffect(() => {
    // Aborted when params change or the dashboard unmounts: the client drops requests nobody
    // waits for any more, while unchanged queries are re-subscribed and keep their in-flight fetch.
    const controller = new AbortController();
    const { signal } = controller;
    // All requests issued in this loop share one tick, so the client sends them as one batch.
    // Previous results stay on screen until new ones arrive (no flash on param changes).
    for (const { key: queryId, queryId: savedId, runtime } of requests.list) {
      client
        .fetchQuery({
          dashboardId: dashboard.id,
          version,
          queryId: savedId,
          params: values,
          cacheParams: paramsForQuery(dashboard, savedId, values),
          ...(runtime ? { runtime } : {}),
          signal,
        })
        .then(
          (result) =>
            !signal.aborted &&
            setStates((s) => {
              const prev = s[queryId];
              // Same cached result object: keep the state identity so memoized widgets skip rendering.
              if (prev?.status === 'ready' && prev.result === result) return s;
              return { ...s, [queryId]: { status: 'ready', result } };
            }),
          (error: unknown) =>
            !signal.aborted &&
            setStates((s) => ({ ...s, [queryId]: { status: 'error', error: error instanceof Error ? error : new Error(String(error)) } })),
        );
    }
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, dashboard, version, values, requestsKey]);

  const format = useMemo(() => ({ locale, currency }), [locale, currency]);
  const dashboardAsOf = useMemo(
    () => oldestAsOf(queryIds.map((id) => { const s = states[id]; return s?.status === 'ready' ? s.result.asOf : undefined; })),
    [queryIds, states],
  );
  const anyCached = queryIds.some((id) => { const s = states[id]; return s?.status === 'ready' && s.result.cached; });

  const styled = useMemo(() => themeVars(dashboard.theme), [dashboard.theme]);
  return (
    <Root theme={dashboard.theme?.mode ?? theme} className={className} style={styled.style} attrs={styled.attrs}>
      {showHeader && (
        <header className="bi-header">
          <div>
            <h2 className="bi-title">{dashboard.title}</h2>
            {dashboard.description && <p className="bi-desc">{dashboard.description}</p>}
          </div>
          <Freshness asOf={dashboardAsOf} cached={anyCached} />
          <DashboardToolbar dashboardId={dashboard.id} title={dashboard.title} version={version} />
        </header>
      )}
      {compatibility?.level === 'degraded' && (
        <div className="bi-banner" role="status">
          {compatibility.message}
        </div>
      )}
      {tabs?.length ? (
        <div className="bi-tabs" role="tablist" aria-label="Dashboard pages">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="bi-tab" aria-selected={t.id === currentTab} onClick={() => setActiveTab(t.id)}>
              {t.title}
            </button>
          ))}
        </div>
      ) : null}
      <InteractionContext.Provider value={engine}>
      <DashboardAsOfContext.Provider value={showHeader ? dashboardAsOf : undefined}>
      <Grid items={visibleLayout} gap={dashboard.theme?.density === 'compact' ? 10 : undefined} mobile={dashboard.mobileLayout}>
        {(item) => {
          const widget = dashboard.widgets[item.i]!;
          const key = requests.keyOf[item.i];
          const state = key ? (states[key] ?? LOADING) : LOADING;
          return <WidgetFrame widgetId={item.i} widget={widget} state={state} format={format} />;
        }}
      </Grid>
      </DashboardAsOfContext.Provider>
      </InteractionContext.Provider>
    </Root>
  );
}
