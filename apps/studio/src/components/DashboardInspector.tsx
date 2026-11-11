import { issuesAt, type IssueIndex } from '../draft/issues';
import { uniqueId } from '../draft/ids';
import { bindableQueries, bindTarget, boundQueries, suggestDateField } from '../draft/params';
import { normalizeQuery } from '../draft/query';
import type { DraftSpec, FieldInfo, ParamDraft } from '../draft/types';
import type { Dispatch } from '../hooks/useDraftHistory';
import { EmbedSnippet } from './EmbedSnippet';
import { IssueText } from './IssueList';
import { DateRangeInput } from './ParamControls';
import { AddParamButtons, ExtraParamEditor, InteractionsSection, TabsSection } from './InteractivityEditors';

const EXTRA_TYPES = new Set(['multiselect', 'range', 'search', 'measure']);

export interface DashboardInspectorProps {
  draft: DraftSpec;
  issues: IssueIndex;
  dispatch: Dispatch;
  savedVersion: number;
  /** Known fields per dataSources id, for date columns and bindable queries. */
  fieldsBySourceId: Record<string, FieldInfo[] | undefined>;
}

function ParamEditor({ id, param, draft, dispatch, fieldsBySourceId, issues }: { id: string; param: ParamDraft; draft: DraftSpec; dispatch: Dispatch; fieldsBySourceId: Record<string, FieldInfo[] | undefined>; issues: IssueIndex }) {
  const local = issues.byParam.get(id) ?? [];
  const set = (next: ParamDraft, coalesce?: string) => dispatch({ type: 'setParam', id, param: next }, coalesce);
  if (EXTRA_TYPES.has(param.type)) {
    return <ExtraParamEditor id={id} param={param} draft={draft} dispatch={dispatch} fields={Object.values(fieldsBySourceId).flatMap((f) => f ?? [])} issues={issues} />;
  }
  if (param.type !== 'daterange') {
    return (
      <li className="param">
        <header>
          <strong>{param.label ?? id}</strong> <span className="muted small">{param.type}</span>
          <button type="button" className="btn ghost tiny" onClick={() => dispatch({ type: 'removeParam', id })}>
            Remove
          </button>
        </header>
        <p className="muted small">Edit “{param.type}” params in the JSON view.</p>
        <IssueText issues={local} />
      </li>
    );
  }
  const timeFields = [...new Set(Object.values(fieldsBySourceId).flatMap((fs) => (fs ?? []).filter((f) => f.kind === 'time').map((f) => f.name)))];
  const bound = new Set(boundQueries(param));
  const bindable = new Set(bindableQueries(draft, param.field, fieldsBySourceId));
  return (
    <li className="param">
      <header>
        <strong>{id}</strong>
        <span className="muted small">date range</span>
        <button type="button" className="btn ghost tiny" onClick={() => dispatch({ type: 'removeParam', id })}>
          Remove
        </button>
      </header>
      <label className="field-label">
        Label
        <input value={param.label ?? ''} onChange={(e) => set({ ...param, label: e.target.value || undefined }, `p:${id}:label`)} />
      </label>
      <label className="field-label">
        Date column
        <select value={param.field ?? ''} onChange={(e) => set({ ...param, field: e.target.value || undefined })}>
          <option value="">Each query’s time dimension</option>
          {[...new Set([...(param.field ? [param.field] : []), ...timeFields])].map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <IssueText issues={issuesAt(local, 'field')} />
      <div className="field-label">
        Default
        <DateRangeInput label="Default range" value={param.default ?? 'all'} onChange={(v) => set({ ...param, default: v })} />
      </div>
      <IssueText issues={issuesAt(local, 'default')} />
      <div className="field-label">Filters these queries</div>
      <ul className="bind-list">
        {Object.keys(draft.queries).map((qid) => {
          const users = Object.entries(draft.widgets)
            .filter(([, w]) => w.query === qid)
            .map(([wid]) => wid);
          const hasTime = normalizeQuery(draft.queries[qid]).dimensions.some((d) => d.grain);
          return (
            <li key={qid}>
              <label className="check" data-dim={!bindable.has(qid) || undefined}>
                <input
                  type="checkbox"
                  checked={bound.has(qid)}
                  onChange={(e) => set({ ...param, bind: e.target.checked ? [...(param.bind ?? []), bindTarget(qid)] : (param.bind ?? []).filter((t) => t !== bindTarget(qid)) })}
                />
                <code>{qid}</code>
                <span className="muted small">
                  {users.join(', ') || 'unused'}
                  {hasTime ? ' · has time' : ''}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <IssueText issues={issuesAt(local, 'bind')} />
      <IssueText issues={local.filter((i) => !['field', 'default', 'bind'].some((p) => i.local === p || i.local.startsWith(`${p}.`)))} />
    </li>
  );
}

export function DashboardInspector({ draft, issues, dispatch, savedVersion, fieldsBySourceId }: DashboardInspectorProps) {
  const allFields = Object.values(fieldsBySourceId).flatMap((f) => f ?? []);
  const addDateParam = () => {
    const field = suggestDateField(draft, allFields);
    const bind = bindableQueries(draft, field, fieldsBySourceId).map(bindTarget);
    const id = uniqueId('dateRange', Object.keys(draft.params));
    dispatch({ type: 'setParam', id, param: { type: 'daterange', label: 'Date range', ...(field ? { field } : {}), default: 'last_365d', bind } });
  };
  return (
    <div className="inspector-body">
      <section>
        <h4>Dashboard</h4>
        <label className="field-label">
          Title
          <input value={draft.title ?? ''} onChange={(e) => dispatch({ type: 'setMeta', title: e.target.value }, 'meta:title')} />
        </label>
        <IssueText issues={issuesAt(issues.dashboard, 'title')} />
        <label className="field-label">
          Description
          <textarea rows={2} value={draft.description ?? ''} onChange={(e) => dispatch({ type: 'setMeta', description: e.target.value }, 'meta:desc')} />
        </label>
        <p className="muted small">
          id <code>{draft.id}</code> · spec {draft.specVersion}
        </p>
        <IssueText issues={issues.dashboard.filter((i) => i.local !== 'title')} />
      </section>

      <section>
        <header className="row between">
          <h4>Params</h4>
          <button type="button" className="btn small" onClick={addDateParam} disabled={Object.keys(draft.queries).length === 0}>
            + Date range
          </button>
        </header>
        <AddParamButtons draft={draft} dispatch={dispatch} fields={allFields} />
        {Object.keys(draft.params).length === 0 && <p className="muted small">A date-range param lets one picker re-filter every widget that has a time field.</p>}
        <ul className="param-list">
          {Object.entries(draft.params).map(([id, p]) => (
            <ParamEditor key={id} id={id} param={p} draft={draft} dispatch={dispatch} fieldsBySourceId={fieldsBySourceId} issues={issues} />
          ))}
        </ul>
      </section>

      <InteractionsSection draft={draft} dispatch={dispatch} />
      <TabsSection draft={draft} dispatch={dispatch} issues={issues} />

      <section>
        <h4>Embed</h4>
        <EmbedSnippet draft={draft} savedVersion={savedVersion} />
      </section>
    </div>
  );
}
