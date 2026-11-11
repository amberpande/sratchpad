import { stableStringify, validateDashboard, type Issue, type ValidDashboard } from '@yourorg/bi-spec';
import { bindTarget, boundQueries } from './params';
import type { DraftSpec, ParamDraft } from './types';

/**
 * What the canvas can draw right now. Each widget is checked on its own (its query, source and
 * bound params), so one broken widget never blanks the rest of the canvas. The renderable widgets
 * are merged into one valid spec: that is what live preview sends to the backend.
 */

export interface Renderable {
  /** A valid spec with only the widgets that can render; null when none can. */
  spec: DraftSpec | null;
  dashboard: ValidDashboard | null;
  /** Ids of renderable widgets. */
  ok: Set<string>;
  /** Why a widget cannot render (its own issues). */
  blocked: Map<string, Issue[]>;
}

function paramsFor(draft: DraftSpec, queryIds: Set<string>): Record<string, ParamDraft> {
  const params: Record<string, ParamDraft> = {};
  for (const [pid, p] of Object.entries(draft.params)) {
    const bound = boundQueries(p).filter((q) => queryIds.has(q));
    if (bound.length) params[pid] = { ...p, bind: bound.map(bindTarget) };
  }
  return params;
}

/** The smallest document that contains one widget and everything it depends on. */
export function widgetSubSpec(draft: DraftSpec, widgetIds: string[]): DraftSpec {
  const widgets: DraftSpec['widgets'] = {};
  const queries: DraftSpec['queries'] = {};
  const dataSources: DraftSpec['dataSources'] = {};
  for (const wid of widgetIds) {
    const w = draft.widgets[wid];
    if (!w) continue;
    widgets[wid] = w;
    const q = w.query ? draft.queries[w.query] : undefined;
    if (w.query && q) {
      queries[w.query] = q;
      const ds = typeof q.source === 'string' ? draft.dataSources[q.source] : undefined;
      if (ds) dataSources[q.source] = ds;
    }
  }
  const ids = new Set(widgetIds);
  return {
    ...draft,
    dataSources,
    queries,
    widgets,
    layout: draft.layout.filter((it) => ids.has(it.i)),
    params: paramsFor(draft, new Set(Object.keys(queries))),
  };
}

export function buildRenderable(draft: DraftSpec): Renderable {
  const ok = new Set<string>();
  const blocked = new Map<string, Issue[]>();
  const placed = draft.layout.map((it) => it.i).filter((id) => typeof id === 'string' && draft.widgets[id]);
  for (const wid of new Set(placed)) {
    const result = validateDashboard(widgetSubSpec(draft, [wid]), { allowNewerMinor: false });
    if (result.ok) ok.add(wid);
    else blocked.set(wid, result.errors);
  }
  if (ok.size === 0) return { spec: null, dashboard: null, ok, blocked };
  const spec = widgetSubSpec(draft, [...ok]);
  const result = validateDashboard(spec, { allowNewerMinor: false });
  if (!result.ok) {
    // Widgets can be fine alone yet clash together (e.g. duplicate layout entries); show them as blocked.
    for (const wid of ok) blocked.set(wid, result.errors);
    return { spec: null, dashboard: null, ok: new Set(), blocked };
  }
  return { spec, dashboard: result.dashboard, ok, blocked };
}

/** A one-widget dashboard for one canvas cell: the renderer draws it exactly as a host app would. */
export function singleWidgetDashboard(dashboard: ValidDashboard, widgetId: string, h: number): ValidDashboard {
  return { ...dashboard, widgets: { [widgetId]: dashboard.widgets[widgetId]! }, layout: [{ i: widgetId, x: 0, y: 0, w: 12, h }] };
}

/** Stable key of everything a query's result depends on (query body, its source, bound params). */
export function queryFingerprint(spec: unknown, queryId: string): string {
  const s = (spec ?? {}) as Partial<DraftSpec>;
  const query = s.queries?.[queryId];
  const source = query && typeof query.source === 'string' ? s.dataSources?.[query.source] : undefined;
  const params = Object.entries(s.params ?? {})
    .filter(([, p]) => boundQueries(p).includes(queryId))
    .map(([pid, p]) => [pid, { ...p, bind: undefined }]);
  return stableStringify({ query, source, params });
}
