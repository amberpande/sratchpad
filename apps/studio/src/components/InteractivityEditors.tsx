import { compareSpecVersions, parseSpecVersion, type DashboardTab, type MobileLayoutItem } from '@yourorg/bi-spec';
import { uniqueId } from '../draft/ids';
import type { IssueIndex } from '../draft/issues';
import { boundQueries } from '../draft/params';
import { normalizeQuery } from '../draft/query';
import type { DraftSpec, FieldInfo, ParamDraft } from '../draft/types';
import type { Dispatch } from '../hooks/useDraftHistory';
import { IssueText } from './IssueList';

/**
 * Workstream B: Studio editors for spec 1.3 interactivity: cross-filtering, tabs, the new param types
 * (multi-select, range, search, measure switch) and per-widget drill-down / drill-through
 * (DrillEditor, mounted in the widget inspector). Edits go through the reducer's `replace` action and
 * raise specVersion to 1.3 when needed.
 */

type Draft13 = DraftSpec & { interactions?: { crossFilter?: boolean }; tabs?: DashboardTab[]; mobileLayout?: MobileLayoutItem[] };
type Layout13 = DraftSpec['layout'][number] & { tab?: string };
type WidgetDraft13 = DraftSpec['widgets'][string] & {
  drill?: { levels: Array<{ field: string; grain?: string; label?: string }> };
  drillThrough?: { dashboardId: string; params?: Record<string, string>; label?: string };
  interactions?: { crossFilter?: boolean };
};

const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const AGGS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] as const;

/** Applies a change as one undo step and raises specVersion to 1.3 (never lowers it). */
function commit(draft: DraftSpec, dispatch: Dispatch, next: Draft13, coalesce?: string) {
  const have = parseSpecVersion(next.specVersion);
  const need = parseSpecVersion('1.3')!;
  const specVersion = !have || compareSpecVersions(have, need) < 0 ? '1.3' : next.specVersion;
  void draft;
  dispatch({ type: 'replace', draft: { ...next, specVersion } as DraftSpec }, coalesce);
}

export function InteractionsSection({ draft, dispatch }: { draft: DraftSpec; dispatch: Dispatch }) {
  const d = draft as Draft13;
  return (
    <section>
      <h4>Interactions</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(d.interactions?.crossFilter)}
          onChange={(e) => {
            const { interactions: _old, ...rest } = d;
            commit(draft, dispatch, e.target.checked ? { ...rest, interactions: { crossFilter: true } } : (rest as Draft13));
          }}
        />
        Click a chart to filter the others
      </label>
      <p className="muted small">Viewers click a bar, slice or point; widgets on the same data filter to it. Opt a widget out, or give it drill-down, in its inspector.</p>
    </section>
  );
}

export function TabsSection({ draft, dispatch, issues }: { draft: DraftSpec; dispatch: Dispatch; issues: IssueIndex }) {
  const d = draft as Draft13;
  const tabs = d.tabs ?? [];
  const setTabs = (next: DashboardTab[], layout = draft.layout as Layout13[]) => {
    const { tabs: _t, ...rest } = d;
    const cleaned = next.length ? layout : layout.map(({ tab: _tab, ...it }) => it);
    commit(draft, dispatch, next.length ? { ...rest, tabs: next, layout: cleaned } : ({ ...rest, layout: cleaned } as Draft13));
  };
  const addTab = () => {
    const id = uniqueId('tab', tabs.map((t) => t.id));
    setTabs(tabs.length ? [...tabs, { id, title: `Tab ${tabs.length + 1}` }] : [{ id: 'overview', title: 'Overview' }, { id, title: 'Tab 2' }]);
  };
  const tabIssues = issues.dashboard.filter((i) => i.local.startsWith('tabs') || i.local.startsWith('layout'));
  return (
    <section>
      <header className="row between">
        <h4>Tabs</h4>
        <button type="button" className="btn small" onClick={addTab}>
          + Tab
        </button>
      </header>
      {!tabs.length && <p className="muted small">Split a long dashboard into pages. Only the open tab’s widgets load.</p>}
      {tabs.length > 0 && (
        <ul className="param-list">
          {tabs.map((t, i) => (
            <li key={t.id} className="param">
              <header>
                <input aria-label={`Tab ${i + 1} title`} value={t.title} maxLength={80} onChange={(e) => setTabs(tabs.map((x) => (x.id === t.id ? { ...x, title: e.target.value || x.title } : x)))} />
                <button
                  type="button"
                  className="btn ghost tiny"
                  onClick={() =>
                    setTabs(
                      tabs.filter((x) => x.id !== t.id),
                      (draft.layout as Layout13[]).map((it) => (it.tab === t.id ? (({ tab: _x, ...r }) => r)(it) : it)),
                    )
                  }
                >
                  Remove
                </button>
              </header>
            </li>
          ))}
        </ul>
      )}
      {tabs.length > 0 && (
        <>
          <div className="field-label">Widgets</div>
          <ul className="bind-list">
            {(draft.layout as Layout13[]).map((it) => (
              <li key={it.i}>
                <label className="field-label">
                  <code>{it.i}</code>
                  <select
                    aria-label={`Tab of ${it.i}`}
                    value={it.tab ?? tabs[0]!.id}
                    onChange={(e) => setTabs(tabs, (draft.layout as Layout13[]).map((x) => (x.i === it.i ? { ...x, tab: e.target.value } : x)))}
                  >
                    {tabs.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <IssueText issues={tabIssues} />
    </section>
  );
}

/** Buttons that add the 1.3 param types. */
export function AddParamButtons({ draft, dispatch, fields }: { draft: DraftSpec; dispatch: Dispatch; fields: FieldInfo[] }) {
  const firstQuery = Object.keys(draft.queries)[0];
  const dims = fields.filter((f) => f.kind === 'dimension');
  const measures = fields.filter((f) => f.kind === 'measure');
  const add = (base: string, param: ParamDraft) => {
    const id = uniqueId(base, Object.keys(draft.params));
    commit(draft, dispatch, { ...draft, params: { ...draft.params, [id]: param } });
  };
  const filters = firstQuery ? [`${firstQuery}.filters`] : [];
  const firstMeasure = firstQuery ? normalizeQuery(draft.queries[firstQuery]).measures[0] : undefined;
  return (
    <div className="row gap-s wrap">
      <button type="button" className="btn small" disabled={!firstQuery} onClick={() => add('multi', { type: 'multiselect', label: 'Pick values', field: dims[0]?.name ?? '', default: [], bind: filters })}>
        + Multi-select
      </button>
      <button type="button" className="btn small" disabled={!firstQuery} onClick={() => add('range', { type: 'range', label: 'Range', field: measures[0]?.name ?? '', kind: 'number', default: null, bind: filters })}>
        + Range
      </button>
      <button type="button" className="btn small" disabled={!firstQuery} onClick={() => add('search', { type: 'search', label: 'Search', field: dims[0]?.name ?? '', match: 'contains', default: '', bind: filters })}>
        + Search
      </button>
      <button
        type="button"
        className="btn small"
        disabled={!firstMeasure}
        onClick={() => {
          const as = firstMeasure!.as ?? `${firstMeasure!.agg}_${firstMeasure!.field}`;
          add('metric', {
            type: 'measure',
            label: 'Metric',
            as,
            options: [
              { value: 'current', label: as, field: firstMeasure!.field, agg: firstMeasure!.agg },
              { value: 'records', label: 'Records', field: '*', agg: 'count' },
            ],
            default: 'current',
            bind: [`${firstQuery}.measures`],
          });
        }}
      >
        + Measure switch
      </button>
    </div>
  );
}

/** Editor for one multiselect / range / search / measure param. */
export function ExtraParamEditor({ id, param, draft, dispatch, fields, issues }: { id: string; param: ParamDraft; draft: DraftSpec; dispatch: Dispatch; fields: FieldInfo[]; issues: IssueIndex }) {
  const local = issues.byParam.get(id) ?? [];
  const set = (next: ParamDraft, coalesce?: string) => commit(draft, dispatch, { ...draft, params: { ...draft.params, [id]: next } }, coalesce);
  const suffix = param.type === 'measure' ? '.measures' : '.filters';
  const bound = new Set(boundQueries(param));
  const fieldNames = [...new Set([...(typeof param.field === 'string' && param.field ? [param.field] : []), ...fields.map((f) => f.name)])];
  const p = param as ParamDraft & Record<string, unknown>;
  return (
    <li className="param">
      <header>
        <strong>{id}</strong>
        <span className="muted small">{param.type === 'measure' ? 'measure switch' : param.type}</span>
        <button type="button" className="btn ghost tiny" onClick={() => dispatch({ type: 'removeParam', id })}>
          Remove
        </button>
      </header>
      <label className="field-label">
        Label
        <input value={param.label ?? ''} onChange={(e) => set({ ...param, label: e.target.value || undefined }, `p:${id}:label`)} />
      </label>
      {param.type !== 'measure' && (
        <label className="field-label">
          Field
          <select value={param.field ?? ''} onChange={(e) => set({ ...param, field: e.target.value })}>
            {fieldNames.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      )}
      {param.type === 'multiselect' && (
        <>
          <label className="field-label">
            Choices from query (cascading)
            <select
              value={(p.optionsQuery as { query?: string } | undefined)?.query ?? ''}
              onChange={(e) => {
                const { optionsQuery: _o, options: _x, ...rest } = p;
                set(e.target.value ? ({ ...rest, optionsQuery: { query: e.target.value, field: param.field ?? '' } } as ParamDraft) : (rest as ParamDraft));
              }}
            >
              <option value="">Fixed list</option>
              {Object.keys(draft.queries).map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </label>
          {!p.optionsQuery && (
            <label className="field-label">
              Choices (comma-separated)
              <input
                value={(param.options ?? []).join(', ')}
                onChange={(e) => {
                  const options = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                  set({ ...param, options: options.length ? options : undefined, default: [] }, `p:${id}:options`);
                }}
              />
            </label>
          )}
        </>
      )}
      {param.type === 'range' && (
        <label className="field-label">
          Kind
          <select value={(p.kind as string) ?? 'number'} onChange={(e) => set({ ...param, kind: e.target.value, default: null })}>
            <option value="number">Numbers</option>
            <option value="date">Dates</option>
          </select>
        </label>
      )}
      {param.type === 'search' && (
        <label className="field-label">
          Match
          <select value={(p.match as string) ?? 'contains'} onChange={(e) => set({ ...param, match: e.target.value })}>
            <option value="contains">Contains</option>
            <option value="starts_with">Starts with</option>
            <option value="ends_with">Ends with</option>
          </select>
        </label>
      )}
      {param.type === 'measure' && (
        <MeasureOptions param={p} onChange={(next) => set(next as ParamDraft)} fields={fields} />
      )}
      <div className="field-label">{param.type === 'measure' ? 'Switches the measure in' : 'Filters these queries'}</div>
      <ul className="bind-list">
        {Object.keys(draft.queries).map((qid) => (
          <li key={qid}>
            <label className="check">
              <input
                type="checkbox"
                checked={bound.has(qid)}
                onChange={(e) => set({ ...param, bind: e.target.checked ? [...(param.bind ?? []), `${qid}${suffix}`] : (param.bind ?? []).filter((t) => t !== `${qid}${suffix}`) })}
              />
              <code>{qid}</code>
            </label>
          </li>
        ))}
      </ul>
      <IssueText issues={local} />
    </li>
  );
}

function MeasureOptions({ param, onChange, fields }: { param: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void; fields: FieldInfo[] }) {
  const options = (param.options as Array<{ value: string; label?: string; field: string; agg: string }>) ?? [];
  const setOpt = (i: number, patch: Partial<(typeof options)[number]>) => onChange({ ...param, options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <div className="field-label">
      Alternatives for <code>{String(param.as)}</code>
      {options.map((o, i) => (
        <div key={i} className="row gap-s">
          <input aria-label={`Option ${i + 1} label`} value={o.label ?? ''} placeholder="Label" onChange={(e) => setOpt(i, { label: e.target.value || undefined })} />
          <select aria-label={`Option ${i + 1} field`} value={o.field} onChange={(e) => setOpt(i, { field: e.target.value })}>
            {[...new Set(['*', o.field, ...fields.filter((f) => f.kind === 'measure').map((f) => f.name)])].map((f) => (
              <option key={f} value={f}>
                {f === '*' ? 'rows' : f}
              </option>
            ))}
          </select>
          <select aria-label={`Option ${i + 1} aggregation`} value={o.agg} onChange={(e) => setOpt(i, { agg: e.target.value })}>
            {AGGS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input type="radio" aria-label={`Default option ${i + 1}`} checked={param.default === o.value} onChange={() => onChange({ ...param, default: o.value })} />
        </div>
      ))}
      <button
        type="button"
        className="btn small ghost"
        onClick={() => onChange({ ...param, options: [...options, { value: uniqueId('opt', options.map((o) => o.value)), field: '*', agg: 'count' }] })}
        disabled={options.length >= 12}
      >
        + Alternative
      </button>
    </div>
  );
}

/**
 * Per-widget drill-down, drill-through and cross-filter opt-out. Mount in the widget inspector:
 *   <DrillEditor draft={draft} widgetId={id} dispatch={dispatch} fields={fields} />
 */
export function DrillEditor({ draft, widgetId, dispatch, fields }: { draft: DraftSpec; widgetId: string; dispatch: Dispatch; fields: FieldInfo[] }) {
  const w = draft.widgets[widgetId] as WidgetDraft13 | undefined;
  if (!w?.query) return null;
  const q = draft.queries[w.query] ? normalizeQuery(draft.queries[w.query]) : undefined;
  const first = q?.dimensions[0];
  const setWidget = (next: WidgetDraft13) => commit(draft, dispatch, { ...draft, widgets: { ...draft.widgets, [widgetId]: next } });
  const without = <K extends keyof WidgetDraft13>(key: K): WidgetDraft13 => {
    const { [key]: _drop, ...rest } = w;
    return rest as WidgetDraft13;
  };
  const levels = w.drill?.levels ?? [];
  const dims = fields.filter((f) => f.kind !== 'measure');
  const crossFilterOn = Boolean((draft as Draft13).interactions?.crossFilter);
  return (
    <section className="drill-editor" aria-label="Interactions">
      <h4>Interactions</h4>
      {crossFilterOn && (
        <label className="check">
          <input
            type="checkbox"
            checked={w.interactions?.crossFilter !== false}
            onChange={(e) => setWidget(e.target.checked ? without('interactions') : { ...w, interactions: { crossFilter: false } })}
          />
          Takes part in cross-filtering
        </label>
      )}
      <div className="field-label">Drill-down</div>
      {!first ? (
        <p className="muted small">Needs a query with a dimension.</p>
      ) : levels.length === 0 ? (
        <button
          type="button"
          className="btn small"
          onClick={() => setWidget({ ...w, drill: { levels: [{ field: first.field, ...(first.grain ? { grain: first.grain } : {}) }, { field: first.grain ? first.field : dims.find((f) => f.name !== first.field)?.name ?? first.field, ...(first.grain ? { grain: first.grain === 'year' ? 'month' : 'day' } : {}) }] } })}
        >
          + Add drill-down
        </button>
      ) : (
        <>
          <ol className="bind-list">
            {levels.map((l, i) => (
              <li key={i} className="row gap-s">
                {i === 0 ? (
                  <span className="muted small">
                    {l.field}
                    {l.grain ? ` (${l.grain})` : ''} · top level
                  </span>
                ) : (
                  <>
                    <select
                      aria-label={`Drill level ${i + 1} field`}
                      value={l.field}
                      onChange={(e) => setWidget({ ...w, drill: { levels: levels.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) } })}
                    >
                      {[...new Set([l.field, ...dims.map((f) => f.name)])].map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`Drill level ${i + 1} grain`}
                      value={l.grain ?? ''}
                      onChange={(e) => setWidget({ ...w, drill: { levels: levels.map((x, j) => (j === i ? { field: x.field, ...(e.target.value ? { grain: e.target.value } : {}), ...(x.label ? { label: x.label } : {}) } : x)) } })}
                    >
                      <option value="">no grain</option>
                      {GRAINS.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn ghost tiny"
                      onClick={() => {
                        const next = levels.filter((_, j) => j !== i);
                        setWidget(next.length >= 2 ? { ...w, drill: { levels: next } } : without('drill'));
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
          <button type="button" className="btn small ghost" disabled={levels.length >= 6} onClick={() => setWidget({ ...w, drill: { levels: [...levels, { field: dims[0]?.name ?? first.field }] } })}>
            + Level
          </button>
        </>
      )}
      <div className="field-label">Drill-through</div>
      <label className="field-label">
        Open dashboard (id)
        <input
          value={w.drillThrough?.dashboardId ?? ''}
          placeholder="e.g. dash_detail"
          onChange={(e) => setWidget(e.target.value ? { ...w, drillThrough: { ...(w.drillThrough ?? {}), dashboardId: e.target.value } } : without('drillThrough'))}
        />
      </label>
      {w.drillThrough && first && (
        <label className="field-label">
          …passing the clicked {first.as ?? first.field} as param
          <input
            value={Object.keys(w.drillThrough.params ?? {})[0] ?? ''}
            placeholder="target param name"
            onChange={(e) => setWidget({ ...w, drillThrough: { ...w.drillThrough!, params: e.target.value ? { [e.target.value]: first.as ?? first.field } : undefined } })}
          />
        </label>
      )}
      <p className="muted small">Drill-through needs the host app to handle navigation (onNavigate); viewer links stay on one dashboard.</p>
    </section>
  );
}
