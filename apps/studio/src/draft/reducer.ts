import { compareSpecVersions, parseSpecVersion, queryExtensionSince, SPEC_VERSION, type DataSource, type LayoutItem, type QueryInput, type Recommendation } from '@yourorg/bi-spec';
import { uniqueId } from './ids';
import { compactLayout, findSpot } from './layout';
import { bindTarget, boundQueries } from './params';
import { addField, autoEncode, autoTitle, compactQuery, normalizeQuery, pruneOrderBy, starterQuery, type EncodeHint } from './query';
import type { DraftSpec, FieldInfo, ParamDraft, WidgetDraft } from './types';
import { defaultSize, requiredOptionDefaults, widgetTypeInfo } from './widgetTypes';

/**
 * Pure draft-state reducer. Every action returns a new spec document; ids it generates match the
 * spec's id pattern. Selection and other UI state live outside, so this stays easy to test.
 */

export type DraftAction =
  | { type: 'replace'; draft: DraftSpec }
  | { type: 'setMeta'; title?: string; description?: string }
  | {
      type: 'addWidget';
      widgetType: string;
      /** Id for the new widget (use nextWidgetId so the caller can select it). */
      id: string;
      source?: { source: DataSource; name?: string };
      fields?: FieldInfo[];
      at?: { x: number; y: number };
      /** Seed the query from this field (dropping a field on empty canvas). */
      seedField?: FieldInfo;
    }
  | { type: 'removeWidget'; id: string }
  | { type: 'duplicateWidget'; id: string; newId: string }
  | { type: 'setLayout'; layout: LayoutItem[] }
  | { type: 'compactLayout' }
  | { type: 'setWidgetType'; id: string; widgetType: string; fields?: FieldInfo[] }
  | { type: 'setWidgetField'; id: string; container: 'encoding' | 'options'; key: string; value: unknown }
  | { type: 'updateQuery'; id: string; query: QueryInput }
  | { type: 'applyField'; widgetId: string; field: FieldInfo; as?: 'dimension' | 'measure' }
  | { type: 'forkQuery'; widgetId: string }
  | { type: 'setParam'; id: string; param: ParamDraft }
  | { type: 'removeParam'; id: string }
  | { type: 'addCandidate'; candidate: Recommendation; id: string };

const omit = <T extends Record<string, unknown>>(record: T, key: string): T => {
  const { [key]: _drop, ...rest } = record;
  return rest as T;
};

export function nextWidgetId(draft: DraftSpec, widgetType: string): string {
  return uniqueId(`w_${widgetType}`, Object.keys(draft.widgets));
}

function nextQueryId(draft: DraftSpec, widgetId: string): string {
  return uniqueId(`q_${widgetId.replace(/^w_/, '')}`, Object.keys(draft.queries));
}

/** Finds or adds a dataSources entry for a source; returns its id. */
export function ensureSource(draft: DraftSpec, source: DataSource, name?: string): { draft: DraftSpec; id: string } {
  const existing = Object.entries(draft.dataSources).find(([, ds]) => ds.type === source.type && ds.ref === source.ref);
  if (existing) return { draft, id: existing[0] };
  const base = name ?? source.ref.split('.').pop() ?? source.ref;
  const id = uniqueId(base.replace(/\.(csv|xlsx)$/i, ''), Object.keys(draft.dataSources));
  return { draft: { ...draft, dataSources: { ...draft.dataSources, [id]: { type: source.type, ref: source.ref } } }, id };
}

/** Raises specVersion when a widget type needs a newer minor (never past what this build writes). */
function raiseSpecVersion(draft: DraftSpec, since: string): DraftSpec {
  const need = parseSpecVersion(since);
  const have = parseSpecVersion(draft.specVersion);
  const max = parseSpecVersion(SPEC_VERSION)!;
  if (!need || !have || compareSpecVersions(need, have) <= 0 || compareSpecVersions(need, max) > 0) return draft;
  return { ...draft, specVersion: since };
}

/** Re-points every widget on a query at real columns and drops dangling sort entries and param binds. */
function afterQueryChange(draft: DraftSpec, queryId: string, hint: EncodeHint = {}, onlyWidget?: string): DraftSpec {
  const query = draft.queries[queryId];
  if (!query) return draft;
  const pruned = compactQuery(pruneOrderBy(normalizeQuery(query)));
  const widgets = { ...draft.widgets };
  for (const [wid, w] of Object.entries(widgets)) {
    if (w.query === queryId) widgets[wid] = autoEncode(w, pruned, wid === onlyWidget || !onlyWidget ? hint : {});
  }
  const params = { ...draft.params };
  const hasTime = normalizeQuery(pruned).dimensions.some((d) => d.grain);
  for (const [pid, p] of Object.entries(params)) {
    if (p.type === 'daterange' && !p.field && !hasTime && boundQueries(p).includes(queryId)) {
      params[pid] = { ...p, bind: (p.bind ?? []).filter((t) => t !== bindTarget(queryId)) };
    }
  }
  return { ...draft, queries: { ...draft.queries, [queryId]: pruned }, widgets, params };
}

/** New queries with a time dimension join existing date-range params on the same column. */
function autoBind(draft: DraftSpec, queryId: string): DraftSpec {
  const q = normalizeQuery(draft.queries[queryId]);
  const timeFields = q.dimensions.filter((d) => d.grain).map((d) => d.field);
  if (!timeFields.length) return draft;
  let params = draft.params;
  for (const [pid, p] of Object.entries(draft.params)) {
    if (p.type !== 'daterange' || boundQueries(p).includes(queryId)) continue;
    if (!p.field || timeFields.includes(p.field)) params = { ...params, [pid]: { ...p, bind: [...(p.bind ?? []), bindTarget(queryId)] } };
  }
  return params === draft.params ? draft : { ...draft, params };
}

function placeWidget(draft: DraftSpec, id: string, widgetType: string, at?: { x: number; y: number }): LayoutItem[] {
  const { w, h } = defaultSize(widgetType);
  const spot = at ? { x: Math.max(0, Math.min(at.x, 12 - w)), y: Math.max(0, at.y) } : findSpot(draft.layout, w, h);
  return [...draft.layout, { i: id, x: spot.x, y: spot.y, w, h }];
}

export function draftReducer(draft: DraftSpec, action: DraftAction): DraftSpec {
  switch (action.type) {
    case 'replace':
      return action.draft;

    case 'setMeta': {
      const next = { ...draft };
      if (action.title !== undefined) next.title = action.title;
      if (action.description !== undefined) {
        if (action.description) next.description = action.description;
        else delete next.description;
      }
      return next;
    }

    case 'addWidget': {
      const info = widgetTypeInfo(action.widgetType);
      if (!info || draft.widgets[action.id]) return draft;
      let next = raiseSpecVersion(draft, info.since);
      if (!info.needsQuery) {
        const widget: WidgetDraft = { type: action.widgetType, options: requiredOptionDefaults(info) };
        return { ...next, widgets: { ...next.widgets, [action.id]: widget }, layout: placeWidget(next, action.id, action.widgetType, action.at) };
      }
      let sourceId = Object.keys(next.dataSources)[0] ?? '';
      if (action.source) ({ draft: next, id: sourceId } = ensureSource(next, action.source.source, action.source.name));
      const queryId = nextQueryId(next, action.id);
      const fields = action.fields ?? [];
      const starter = starterQuery(action.widgetType, sourceId, fields);
      let query = starter;
      if (action.seedField) {
        // Build around the dropped field; borrow the starter's other half (measure or dimension).
        const seed = action.seedField;
        query = addField({ ...starter, dimensions: [], measures: [], orderBy: [] }, seed).query;
        if (seed.kind === 'measure') {
          const dim = starter.dimensions[0];
          const dimField = dim && fields.find((f) => f.name === dim.field);
          if (dimField) query = addField(query, dimField, 'dimension').query;
        } else {
          query = { ...query, measures: starter.measures };
        }
      }
      const compact = compactQuery(query);
      let widget: WidgetDraft = {
        type: action.widgetType,
        query: queryId,
        ...(info.slots.some((s) => s.container === 'encoding') ? { encoding: {} } : {}),
        options: requiredOptionDefaults(info),
      };
      widget = autoEncode(widget, compact);
      // Widgets with a "label" (KPIs) name their number there; the rest get a title.
      const title = autoTitle(compact);
      const hasOption = (key: string) => info.options.some((o) => o.key === key);
      if (title && hasOption('label')) widget = { ...widget, options: { ...widget.options, label: title } };
      else if (title && hasOption('title')) widget = { ...widget, options: { ...widget.options, title } };
      next = {
        ...next,
        queries: { ...next.queries, [queryId]: compact },
        widgets: { ...next.widgets, [action.id]: widget },
        layout: placeWidget(next, action.id, action.widgetType, action.at),
      };
      return autoBind(next, queryId);
    }

    case 'removeWidget': {
      const widget = draft.widgets[action.id];
      if (!widget) return draft;
      let next: DraftSpec = { ...draft, widgets: omit(draft.widgets, action.id), layout: draft.layout.filter((it) => it.i !== action.id) };
      const qid = widget.query;
      // Drop the query too when nothing else reads it, and unbind params from it.
      if (qid && !Object.values(next.widgets).some((w) => w.query === qid)) {
        next = { ...next, queries: omit(next.queries, qid) };
        const params = { ...next.params };
        for (const [pid, p] of Object.entries(params)) {
          if (boundQueries(p).includes(qid)) params[pid] = { ...p, bind: (p.bind ?? []).filter((t) => t !== bindTarget(qid)) };
        }
        next = { ...next, params };
      }
      return next;
    }

    case 'duplicateWidget': {
      const widget = draft.widgets[action.id];
      const item = draft.layout.find((it) => it.i === action.id);
      if (!widget || draft.widgets[action.newId]) return draft;
      const size = item ?? { ...defaultSize(widget.type) };
      const spot = findSpot(draft.layout, size.w, size.h);
      return {
        ...draft,
        widgets: { ...draft.widgets, [action.newId]: structuredClone(widget) },
        layout: [...draft.layout, { i: action.newId, x: spot.x, y: spot.y, w: size.w, h: size.h }],
      };
    }

    case 'setLayout': {
      const known = new Set(draft.layout.map((it) => it.i));
      const byId = new Map(action.layout.map((it) => [it.i, it]));
      // Only positions change here; never add or drop entries through a layout callback.
      const layout = draft.layout.map((it) => {
        const n = byId.get(it.i);
        // Keep other fields (e.g. the 1.3 `tab`); only the position changes.
        return n && known.has(n.i) ? { ...it, x: n.x, y: n.y, w: n.w, h: n.h } : it;
      });
      return { ...draft, layout };
    }

    case 'compactLayout':
      return { ...draft, layout: compactLayout(draft.layout) };

    case 'setWidgetType': {
      const widget = draft.widgets[action.id];
      const info = widgetTypeInfo(action.widgetType);
      if (!widget || !info || widget.type === action.widgetType) return draft;
      const title = widget.options?.title;
      let next = raiseSpecVersion(draft, info.since);
      let queryId = info.needsQuery ? widget.query : undefined;
      // Coming from a static widget: give it a starter query on the first source.
      if (info.needsQuery && (!queryId || !next.queries[queryId])) {
        queryId = nextQueryId(next, action.id);
        const sourceId = Object.keys(next.dataSources)[0] ?? '';
        next = { ...next, queries: { ...next.queries, [queryId]: compactQuery(starterQuery(action.widgetType, sourceId, action.fields ?? [])) } };
      }
      let replaced: WidgetDraft = {
        type: action.widgetType,
        ...(queryId ? { query: queryId } : {}),
        ...(info.slots.some((s) => s.container === 'encoding') ? { encoding: {} } : {}),
        options: { ...requiredOptionDefaults(info), ...(typeof title === 'string' && info.options.some((o) => o.key === 'title') ? { title } : {}) },
      };
      replaced = autoEncode(replaced, queryId ? next.queries[queryId] : undefined);
      return { ...next, widgets: { ...next.widgets, [action.id]: replaced } };
    }

    case 'setWidgetField': {
      const widget = draft.widgets[action.id];
      if (!widget) return draft;
      const container = { ...(widget[action.container] ?? {}) };
      const empty = action.value === undefined || action.value === '' || (Array.isArray(action.value) && action.value.length === 0);
      if (empty) delete container[action.key];
      else container[action.key] = action.value;
      const since = widgetTypeInfo(widget.type)?.fieldsSince[`${action.container}.${action.key}`];
      const next = { ...draft, widgets: { ...draft.widgets, [action.id]: { ...widget, [action.container]: container } } };
      return since && !empty ? raiseSpecVersion(next, since) : next;
    }

    case 'updateQuery': {
      if (!draft.queries[action.id]) return draft;
      const next = afterQueryChange({ ...draft, queries: { ...draft.queries, [action.id]: action.query } }, action.id);
      // Newer query features (1.3 calcs, 1.4 custom SQL) raise specVersion so the draft stays valid.
      const since = queryExtensionSince(action.query);
      return since ? raiseSpecVersion(next, since) : next;
    }

    case 'applyField': {
      const widget = draft.widgets[action.widgetId];
      if (!widget?.query || !draft.queries[widget.query]) return draft;
      const qid = widget.query;
      const { query, added } = addField(normalizeQuery(draft.queries[qid]), action.field, action.as);
      const next = afterQueryChange({ ...draft, queries: { ...draft.queries, [qid]: compactQuery(query) } }, qid, { added }, action.widgetId);
      return autoBind(next, qid);
    }

    case 'forkQuery': {
      const widget = draft.widgets[action.widgetId];
      if (!widget?.query || !draft.queries[widget.query]) return draft;
      const qid = nextQueryId(draft, action.widgetId);
      const params = { ...draft.params };
      for (const [pid, p] of Object.entries(params)) {
        if (boundQueries(p).includes(widget.query)) params[pid] = { ...p, bind: [...(p.bind ?? []), bindTarget(qid)] };
      }
      return {
        ...draft,
        queries: { ...draft.queries, [qid]: structuredClone(draft.queries[widget.query]!) },
        widgets: { ...draft.widgets, [action.widgetId]: { ...widget, query: qid } },
        params,
      };
    }

    case 'setParam':
      return { ...draft, params: { ...draft.params, [action.id]: action.param } };

    case 'removeParam':
      return { ...draft, params: omit(draft.params, action.id) };

    case 'addCandidate': {
      const { candidate } = action;
      if (draft.widgets[action.id]) return draft;
      let next = draft;
      let sourceKey = candidate.query.source;
      if (!next.dataSources[sourceKey]) {
        const first = Object.keys(next.dataSources)[0];
        if (first) sourceKey = first;
      }
      const qid = uniqueId(typeof candidate.widget.query === 'string' ? candidate.widget.query : `q_${action.id}`, Object.keys(next.queries));
      const info = widgetTypeInfo(candidate.widget.type);
      if (info) next = raiseSpecVersion(next, info.since);
      next = {
        ...next,
        queries: { ...next.queries, [qid]: { ...candidate.query, source: sourceKey } },
        widgets: { ...next.widgets, [action.id]: { ...(candidate.widget as WidgetDraft), query: qid } },
        layout: placeWidget(next, action.id, candidate.widget.type),
      };
      return autoBind(next, qid);
    }
  }
}
