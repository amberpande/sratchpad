import { stableStringify, validateDashboard, type DataSource, type Issue, type Recommendation, type RecommendationResponse, type SourceSummary } from '@yourorg/bi-spec';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PreviewDataClient, type PreviewMode, type SavedRef } from '../api/previewClient';
import { ApiError, isRouteMissing, type StudioApi } from '../api/studioApi';
import { fieldsFromDraft, mergeFields, SAMPLE_ORDERS, sourceKey } from '../draft/fields';
import { indexIssues, type LocatedIssue } from '../draft/issues';
import { coerceDraft } from '../draft/json';
import { nextWidgetId } from '../draft/reducer';
import { buildRenderable } from '../draft/renderable';
import type { DraftSpec, FieldInfo, FieldKind } from '../draft/types';
import { widgetTypeInfo, widgetTypes } from '../draft/widgetTypes';
import { useDraftHistory } from '../hooks/useDraftHistory';
import { useProfiles } from '../hooks/useProfiles';
import { useSources } from '../hooks/useSources';
import { Canvas } from './Canvas';
import { DashboardInspector } from './DashboardInspector';
import { DataPanel, type AsyncStatus } from './DataPanel';
import type { FieldDrag } from './dnd';
import { AssistantPanel } from './AssistantPanel';
import { PanelBoundary } from './PanelBoundary';
import { HistoryPanel } from './HistoryPanel';
import { ShareDialog } from './ShareDialog';
import { PlatformActions } from './platform/PlatformActions';
import { JsonView } from './JsonView';
import { TopBar } from './TopBar';
import { WidgetInspector } from './WidgetInspector';

export interface StudioProps {
  api: StudioApi;
  draft: DraftSpec;
  /** The stored version the draft was loaded from (null for a new dashboard). */
  saved: SavedRef | null;
  /** Latest stored version (0 = not saved yet): what Save sends as expectedVersion. */
  latestVersion: number;
  onExit: () => void;
}

type Notice = { tone: 'info' | 'error' | 'success'; text: string; actions?: Array<{ label: string; run: () => void }> } | null;

/** The widget type a field dropped on empty canvas starts as. */
function typeForField(kind: FieldKind): string {
  const types = widgetTypes().map((t) => t.type);
  const prefer = kind === 'time' ? 'line-chart' : kind === 'measure' ? 'kpi' : 'bar-chart';
  if (types.includes(prefer)) return prefer;
  return types.find((t) => widgetTypeInfo(t)?.slots.some((s) => s.role === 'dimension')) ?? types[0]!;
}

function summaryFor(ds: DataSource, id: string, sources: SourceSummary[]): SourceSummary {
  return sources.find((s) => sourceKey(s.source) === sourceKey(ds)) ?? { source: ds, name: id };
}

export function Studio({ api, draft: initialDraft, saved: initialSaved, latestVersion, onExit }: StudioProps) {
  const { draft, dispatch, undo, redo, reset, canUndo, canRedo } = useDraftHistory(initialDraft);
  const [saved, setSaved] = useState<SavedRef | null>(initialSaved);
  const [baseVersion, setBaseVersion] = useState(latestVersion);
  const [selectedRaw, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'canvas' | 'json'>('canvas');
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [rightTab, setRightTab] = useState<'inspector' | 'assistant'>('inspector');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('unknown');
  const [upload, setUpload] = useState<AsyncStatus>({ status: 'idle' });
  const [suggest, setSuggest] = useState<AsyncStatus>({ status: 'idle' });
  const [suggestions, setSuggestions] = useState<RecommendationResponse | null>(null);
  const sources = useSources(api);
  const profiles = useProfiles(api);
  const [active, setActive] = useState<SourceSummary | null>(null);

  const selected = selectedRaw && draft.widgets[selectedRaw] ? selectedRaw : null;

  // ── validation, issues, what can render ──
  const validation = useMemo(() => validateDashboard(draft, { allowNewerMinor: false }), [draft]);
  const issues = useMemo(() => indexIssues(validation, draft), [validation, draft]);
  const renderable = useMemo(() => buildRenderable(draft), [draft]);
  const dirty = useMemo(() => !saved || stableStringify(draft) !== stableStringify(saved.spec), [draft, saved]);

  // ── data sources & fields ──
  useEffect(() => {
    if (active) return;
    const first = Object.entries(draft.dataSources)[0];
    if (first) setActive(summaryFor(first[1], first[0], sources.sources));
    else if (sources.status !== 'loading') setActive(sources.sources[0] ?? SAMPLE_ORDERS);
  }, [active, draft.dataSources, sources.sources, sources.status]);

  useEffect(() => {
    if (active) profiles.ensure(active.source);
    for (const ds of Object.values(draft.dataSources)) if (ds && typeof ds.type === 'string' && typeof ds.ref === 'string') profiles.ensure(ds);
  }, [active, draft.dataSources, profiles]);

  const fieldsFor = useCallback(
    (source: DataSource | undefined): FieldInfo[] => {
      if (!source) return [];
      const state = profiles.get(source);
      const base = state && state.status !== 'loading' ? state.fields : [];
      const dsId = Object.entries(draft.dataSources).find(([, ds]) => ds.type === source.type && ds.ref === source.ref)?.[0];
      return dsId ? mergeFields(base, fieldsFromDraft(draft, dsId)) : base;
    },
    [profiles, draft],
  );
  const fieldsBySourceId = useMemo(() => Object.fromEntries(Object.entries(draft.dataSources).map(([id, ds]) => [id, fieldsFor(ds)])), [draft.dataSources, fieldsFor]);
  const activeFields = useMemo(() => fieldsFor(active?.source), [active, fieldsFor]);

  // ── live preview ──
  const preview = useMemo(() => new PreviewDataClient({ apiUrl: api.apiUrl, token: api.token, fetch: api.fetchImpl, onModeChange: setPreviewMode }), [api]);
  const dataKey = renderable.spec ? stableStringify({ d: renderable.spec.dataSources, q: renderable.spec.queries, p: renderable.spec.params }) : '';
  // A new client per data-relevant snapshot; moving or restyling widgets keeps the same one.
  const client = useMemo(() => preview.forDraft(renderable.spec, saved), [preview, dataKey, saved]);

  // ── save / load ──
  const loadVersion = useCallback(
    async (version: number | undefined, latest?: number) => {
      try {
        const stored = await api.getDashboard(draft.id, version);
        const coerced = coerceDraft(stored.spec);
        if (!coerced.ok) throw new Error(coerced.message);
        reset(coerced.draft);
        setSaved({ id: stored.id, version: stored.version, spec: stored.spec });
        setBaseVersion(latest ?? stored.version);
        setNotice(
          latest && stored.version !== latest
            ? { tone: 'info', text: `Viewing v${stored.version} (latest is v${latest}). Saving creates v${latest + 1} from this version.` }
            : { tone: 'success', text: `Loaded v${stored.version}.` },
        );
      } catch (error) {
        setNotice({ tone: 'error', text: `Couldn’t load: ${(error as Error).message}` });
      }
    },
    [api, draft.id, reset],
  );

  const save = useCallback(
    async (expected: number = baseVersion) => {
      if (!validation.ok || saving) return;
      setSaving(true);
      try {
        const result = await api.saveDashboard(draft.id, draft, expected);
        setSaved({ id: result.id, version: result.version, spec: result.spec ?? draft });
        setBaseVersion(result.version);
        const warns = result.warnings?.length ? ` with ${result.warnings.length} warning(s)` : '';
        setNotice({ tone: 'success', text: `Saved v${result.version}${warns}.` });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const current = (error.details as { currentVersion?: number } | undefined)?.currentVersion;
          setNotice({
            tone: 'error',
            text:
              expected === 0
                ? `A dashboard with id "${draft.id}" already exists${current ? ` (v${current})` : ''}.`
                : `Someone saved v${current ?? '?'} while you were editing v${expected}. Your changes are still here.`,
            actions: [
              { label: 'Reload latest (discard mine)', run: () => void loadVersion(undefined) },
              ...(current ? [{ label: `Save mine as v${current + 1}`, run: () => void save(current) }] : []),
            ],
          });
        } else if (error instanceof ApiError && error.status === 422) {
          const errs = (error.details as { errors?: Issue[] } | undefined)?.errors ?? [];
          setNotice({ tone: 'error', text: `The server rejected the spec: ${errs.map((e) => `${e.path}: ${e.message}`).join('; ') || error.message}` });
        } else setNotice({ tone: 'error', text: `Save failed: ${(error as Error).message}` });
      } finally {
        setSaving(false);
      }
    },
    [api, baseVersion, draft, loadVersion, saving, validation.ok],
  );

  // ── canvas actions ──
  const addWidget = useCallback(
    (type: string, extra: { at?: { x: number; y: number }; seed?: FieldDrag } = {}) => {
      const source = extra.seed?.source ?? active?.source ?? SAMPLE_ORDERS.source;
      // dataSources ids come from the ref ("orders"), or the file name for opaque upload refs.
      const summary = sources.sources.find((s) => sourceKey(s.source) === sourceKey(source));
      const name = source.type === 'file' ? summary?.name : undefined;
      const id = nextWidgetId(draft, type);
      dispatch({
        type: 'addWidget',
        widgetType: type,
        id,
        source: { source, name },
        fields: fieldsFor(source),
        at: extra.at,
        seedField: extra.seed?.field,
      });
      setSelected(id);
    },
    [active, draft, dispatch, fieldsFor, sources.sources],
  );

  const sameSource = (widgetId: string, source: DataSource): boolean => {
    const qid = draft.widgets[widgetId]?.query;
    const q = qid ? draft.queries[qid] : undefined;
    const ds = q ? draft.dataSources[q.source] : undefined;
    return !ds || (ds.type === source.type && ds.ref === source.ref);
  };

  const applyField = (widgetId: string, drag: FieldDrag) => {
    if (!sameSource(widgetId, drag.source)) {
      setNotice({ tone: 'error', text: `“${drag.field.name}” belongs to another source than widget ${widgetId}. Drop it on empty canvas to start a new widget.` });
      return;
    }
    dispatch({ type: 'applyField', widgetId, field: drag.field });
    setSelected(widgetId);
  };

  const removeWidget = useCallback((id: string) => dispatch({ type: 'removeWidget', id }), [dispatch]);

  // ── sources: upload & suggestions ──
  const onUpload = async (file: File) => {
    setUpload({ status: 'busy' });
    try {
      const res = await api.uploadFile(file);
      sources.add(res.summary);
      profiles.put(res.profile);
      setActive(res.summary);
      setUpload({ status: 'idle' });
      setNotice({ tone: 'success', text: `Uploaded ${res.summary.name}: ${res.profile.rowCount.toLocaleString()} rows, ${res.profile.columns.length} columns.` });
    } catch (error) {
      setUpload(
        isRouteMissing(error)
          ? { status: 'unsupported', message: 'This backend doesn’t accept uploads yet (Phase 2: POST /v1/sources/files).' }
          : { status: 'error', message: `Upload failed: ${(error as Error).message}` },
      );
    }
  };

  const onSuggest = async () => {
    if (!active) return;
    if (Object.keys(draft.widgets).length && !window.confirm('Replace the canvas with a suggested dashboard? You can undo this.')) return;
    setSuggest({ status: 'busy' });
    try {
      const res = await api.recommend(active.source);
      const coerced = coerceDraft(res.dashboard);
      if (!coerced.ok) throw new Error(`The suggestion isn’t a usable dashboard: ${coerced.message}`);
      const keepTitle = Object.keys(draft.widgets).length > 0 || !coerced.draft.title;
      dispatch({ type: 'replace', draft: { ...coerced.draft, id: draft.id, title: keepTitle ? draft.title : coerced.draft.title } });
      setSuggestions(res);
      setSelected(null);
      setSuggest({ status: 'idle' });
    } catch (error) {
      setSuggest(
        isRouteMissing(error)
          ? { status: 'unsupported', message: 'Suggestions aren’t available on this backend yet (Phase 4: POST /v1/recommendations).' }
          : { status: 'error', message: `Couldn’t get suggestions: ${(error as Error).message}` },
      );
    }
  };

  const onAddCandidate = (c: Recommendation) => {
    const id = nextWidgetId(draft, c.widget.type);
    dispatch({ type: 'addCandidate', candidate: c, id });
    setSelected(id);
  };

  const onSelectIssue = (i: LocatedIssue) => {
    setView('canvas');
    setSelected(i.widgetIds[0] ?? null);
  };

  // ── keyboard & unload guard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.closest('input, textarea, select, [contenteditable]') !== null;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (!typing && selected && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        removeWidget(selected);
      } else if (!typing && e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, undo, redo, selected, removeWidget]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const status = saving ? 'Saving…' : !saved ? 'New · not saved' : dirty ? `Unsaved changes (from v${saved.version})` : `Saved · v${saved.version}`;
  const selectedWidget = selected ? draft.widgets[selected] : undefined;
  const selectedQuery = selectedWidget?.query ? draft.queries[selectedWidget.query] : undefined;
  // A static widget has no source; if it turns into a chart it starts on the active source's fields.
  const selectedFields = selectedQuery ? (fieldsBySourceId[selectedQuery.source] ?? []) : activeFields;
  const targetLabel = selected && sameSource(selected, active?.source ?? SAMPLE_ORDERS.source) ? selected : undefined;

  return (
    <div className="studio">
      <TopBar
        draft={draft}
        dispatch={dispatch}
        issues={issues}
        status={status}
        dirty={dirty}
        saving={saving}
        view={view}
        onView={setView}
        onSave={() => void save()}
        onBack={() => {
          if (!dirty || window.confirm('Leave without saving? Unsaved changes will be lost.')) onExit();
        }}
        onHistory={() => setShowHistory(true)}
        onShare={() => setShowShare(true)}
        extraActions={<PlatformActions api={api} draft={draft} savedVersion={baseVersion} dirty={dirty} />}
        canHistory={baseVersion > 0}
        undo={{ canUndo, canRedo, undo, redo }}
        paramValues={paramValues}
        onParam={(name, value) => setParamValues((v) => ({ ...v, [name]: value }))}
        onSelectIssue={onSelectIssue}
      />

      {(notice || previewMode === 'unsupported') && (
        <div className="banners">
          {previewMode === 'unsupported' && (
            <div className="banner" data-tone="info" role="status">
              Live preview isn’t available on this backend (POST /v1/preview/data). Widgets unchanged since the last save show saved data; save to preview your changes.
            </div>
          )}
          {notice && (
            <div className="banner" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>
              <span>{notice.text}</span>
              {notice.actions?.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setNotice(null);
                    a.run();
                  }}
                >
                  {a.label}
                </button>
              ))}
              <button type="button" className="btn ghost icon tiny" onClick={() => setNotice(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
        </div>
      )}

      <div className="workspace">
        <DataPanel
          sources={sources.sources}
          sourcesStatus={sources.status}
          active={active}
          onSelectSource={setActive}
          onUpload={(f) => void onUpload(f)}
          upload={upload}
          profile={profiles.get(active?.source)}
          fields={activeFields}
          targetLabel={targetLabel}
          onAddField={(field) => selected && active && applyField(selected, { field, source: active.source })}
          suggest={suggest}
          onSuggest={() => void onSuggest()}
          suggestions={suggestions}
          onAddCandidate={onAddCandidate}
          onCloseSuggestions={() => setSuggestions(null)}
        />

        <main className="center">
          {view === 'canvas' ? (
            <Canvas
              draft={draft}
              renderable={renderable}
              issues={issues.byWidget}
              client={client}
              params={paramValues}
              selected={selected}
              onSelect={setSelected}
              onLayout={(layout) => dispatch({ type: 'setLayout', layout })}
              onAddWidget={(type) => addWidget(type)}
              onRemove={removeWidget}
              onDuplicate={(id) => {
                const newId = nextWidgetId(draft, draft.widgets[id]!.type);
                dispatch({ type: 'duplicateWidget', id, newId });
                setSelected(newId);
              }}
              onTidy={() => dispatch({ type: 'compactLayout' })}
              onFieldDropOnWidget={applyField}
              onFieldDropOnCanvas={(drag, at) => addWidget(typeForField(drag.field.kind), { at, seed: drag })}
            />
          ) : (
            <JsonView draft={draft} dispatch={dispatch} issues={issues} />
          )}
        </main>

        <aside className="panel inspector" aria-label={rightTab === 'assistant' ? 'Assistant' : 'Inspector'}>
          <div className="segmented panel-tabs" role="tablist" aria-label="Right panel">
            <button type="button" role="tab" aria-selected={rightTab === 'inspector'} aria-pressed={rightTab === 'inspector'} onClick={() => setRightTab('inspector')}>
              Inspector
            </button>
            <button type="button" role="tab" aria-selected={rightTab === 'assistant'} aria-pressed={rightTab === 'assistant'} onClick={() => setRightTab('assistant')}>
              Assistant
            </button>
          </div>
          {/* The chat stays mounted while hidden, so switching tabs keeps the conversation. */}
          <div hidden={rightTab !== 'assistant'} className="assistant-wrap">
            <PanelBoundary name="assistant">
              <AssistantPanel api={api} draft={draft} selected={selected} onApply={(next) => dispatch({ type: 'replace', draft: next })} onUndo={undo} />
            </PanelBoundary>
          </div>
          <div hidden={rightTab !== 'inspector'}>
          <PanelBoundary key={selected ?? 'dashboard'} name="inspector">
          <h2 className="panel-title">{selected ? 'Widget' : 'Dashboard'}</h2>
          {selected ? (
            <WidgetInspector
              key={selected}
              draft={draft}
              widgetId={selected}
              issues={issues.byWidget.get(selected) ?? []}
              fields={selectedFields}
              dispatch={dispatch}
              onRemove={() => removeWidget(selected)}
              runDraftQuery={(spec, queryId) => api.runDraftQuery(spec, queryId)}
            />
          ) : (
            <DashboardInspector draft={draft} issues={issues} dispatch={dispatch} savedVersion={saved?.version ?? 0} fieldsBySourceId={fieldsBySourceId} />
          )}
          </PanelBoundary>
          </div>
        </aside>
      </div>

      {showShare && <ShareDialog api={api} dashboardId={draft.id} savedVersion={baseVersion} dirty={dirty} onClose={() => setShowShare(false)} />}
      {showHistory && (
        <HistoryPanel
          api={api}
          id={draft.id}
          current={saved?.version ?? null}
          onClose={() => setShowHistory(false)}
          onOpen={(version, latest) => {
            if (dirty && !window.confirm('Open this version? Unsaved changes will be lost (you can’t undo this).')) return;
            setShowHistory(false);
            void loadVersion(version, latest);
          }}
        />
      )}
    </div>
  );
}
