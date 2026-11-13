import { useState } from 'react';
import { SPEC_VERSION, type QueryResult } from '@yourorg/bi-spec';
import { issuesAt, type LocatedIssue } from '../draft/issues';
import { columnNames, compactQuery, normalizeQuery, type NormalQuery } from '../draft/query';
import type { DraftSpec, FieldInfo, WidgetDraft } from '../draft/types';
import { widgetTypeInfo, widgetTypes, type FieldSlot, type OptionControl } from '../draft/widgetTypes';
import type { Dispatch } from '../hooks/useDraftHistory';
import { IssueText } from './IssueList';
import { QueryEditor } from './QueryEditor';
import { DrillEditor } from './InteractivityEditors';
import { ConditionalFormatsEditor, ReferenceLinesEditor, RulesEditor } from './VizEditors';

export interface WidgetInspectorProps {
  draft: DraftSpec;
  widgetId: string;
  issues: LocatedIssue[];
  fields: FieldInfo[];
  dispatch: Dispatch;
  onRemove: () => void;
  /** Runs one query of a draft spec (custom SQL "Run and detect columns"). */
  runDraftQuery?: (spec: unknown, queryId: string) => Promise<QueryResult>;
}

type TableColumn = { field: string; label?: string; format?: string; align?: string };

function SlotEditor({ slot, widget, columns, onChange, issues }: { slot: FieldSlot; widget: WidgetDraft; columns: string[]; onChange: (value: unknown) => void; issues: LocatedIssue[] }) {
  const value = (slot.container === 'encoding' ? widget.encoding : widget.options)?.[slot.key];
  const label = slot.key === 'x' ? 'X axis' : slot.key === 'y' ? 'Y axis (series)' : slot.key === 'field' ? 'Value' : slot.key.charAt(0).toUpperCase() + slot.key.slice(1);

  if (slot.columns) {
    const list = Array.isArray(value) ? (value as TableColumn[]) : null;
    return (
      <div className="slot">
        <div className="slot-head">
          <span className="field-label">{label}</span>
          <label className="check">
            <input type="checkbox" checked={!list} onChange={(e) => onChange(e.target.checked ? undefined : columns.map((field) => ({ field })))} />
            All result columns
          </label>
        </div>
        {list && (
          <ul className="col-list">
            {columns.map((c) => {
              const idx = list.findIndex((x) => x.field === c);
              const entry = idx >= 0 ? list[idx]! : null;
              return (
                <li key={c}>
                  <label className="check">
                    <input type="checkbox" checked={Boolean(entry)} onChange={(e) => onChange(e.target.checked ? [...list, { field: c }] : list.filter((x) => x.field !== c))} />
                    {c}
                  </label>
                  {entry && (
                    <input
                      className="col-label"
                      value={entry.label ?? ''}
                      placeholder="Label"
                      onChange={(e) => {
                        const { label: _l, ...rest } = entry;
                        onChange(list.map((x, i) => (i === idx ? (e.target.value ? { ...rest, label: e.target.value } : rest) : x)));
                      }}
                      aria-label={`Label for ${c}`}
                    />
                  )}
                </li>
              );
            })}
            {list
              .filter((x) => !columns.includes(x.field))
              .map((x) => (
                <li key={x.field} className="stale">
                  <span>{x.field}</span>
                  <button type="button" className="btn ghost tiny" onClick={() => onChange(list.filter((y) => y !== x))}>
                    remove
                  </button>
                </li>
              ))}
          </ul>
        )}
        <IssueText issues={issuesAt(issues, `${slot.container}.${slot.key}`)} />
      </div>
    );
  }

  if (slot.multiple) {
    const selected = Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : [];
    const set = (next: string[]) => onChange(next.length === 0 ? undefined : next.length === 1 ? next[0] : next);
    return (
      <div className="slot">
        <span className="field-label">{label}</span>
        <div className="chips">
          {[...new Set([...selected, ...columns])].map((c) => (
            <label key={c} className="chip" data-on={selected.includes(c) || undefined} data-stale={!columns.includes(c) || undefined}>
              <input type="checkbox" checked={selected.includes(c)} onChange={(e) => set(e.target.checked ? [...selected, c] : selected.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
        </div>
        <IssueText issues={issuesAt(issues, `${slot.container}.${slot.key}`)} />
      </div>
    );
  }

  const current = typeof value === 'string' ? value : '';
  return (
    <div className="slot">
      <label className="field-label">
        {label}
        <select value={current} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{slot.required ? 'Choose a column…' : '(none)'}</option>
          {[...new Set([...(current ? [current] : []), ...columns])].map((c) => (
            <option key={c} value={c}>
              {c}
              {columns.includes(c) ? '' : ' (missing)'}
            </option>
          ))}
        </select>
      </label>
      <IssueText issues={issuesAt(issues, `${slot.container}.${slot.key}`)} />
    </div>
  );
}

/** Spec 1.3 option lists with their own structured editors. */
const STRUCTURED: Record<string, (p: { value: unknown; onChange: (v: unknown) => void; columns: string[] }) => JSX.Element> = {
  referenceLines: ReferenceLinesEditor,
  conditionalFormats: ConditionalFormatsEditor,
  thresholds: RulesEditor,
};

function OptionEditor({
  control,
  value,
  onChange,
  issues,
  columns = [],
}: {
  control: OptionControl;
  value: unknown;
  onChange: (v: unknown, coalesce?: boolean) => void;
  issues: LocatedIssue[];
  columns?: string[];
}) {
  const label = control.key.charAt(0).toUpperCase() + control.key.replace(/([a-z])([A-Z])/g, '$1 $2').slice(1).toLowerCase();
  const Structured = STRUCTURED[control.key];
  if (Structured) {
    return (
      <div className="slot">
        <span className="field-label">{label}</span>
        <Structured value={value} onChange={(v) => onChange(v)} columns={columns} />
        <IssueText issues={issuesAt(issues, `options.${control.key}`)} />
      </div>
    );
  }
  let input;
  switch (control.kind) {
    case 'text':
      input = <input value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined, true)} />;
      break;
    case 'number':
      input = (
        <input
          type="number"
          min={control.min}
          max={control.max}
          placeholder={control.defaultValue !== undefined ? String(control.defaultValue) : ''}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value), true)}
        />
      );
      break;
    case 'boolean':
      return (
        <div className="slot">
          <label className="check">
            <input type="checkbox" checked={typeof value === 'boolean' ? value : (control.defaultValue ?? false)} onChange={(e) => onChange(e.target.checked)} />
            {label}
          </label>
          <IssueText issues={issuesAt(issues, `options.${control.key}`)} />
        </div>
      );
    case 'enum':
      input = (
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{control.defaultValue ? `default (${control.defaultValue})` : 'auto'}</option>
          {control.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
      break;
    case 'enumObject': {
      const obj = (value && typeof value === 'object' ? value : {}) as Record<string, string>;
      return (
        <div className="slot">
          <span className="field-label">{label}</span>
          <div className="row gap-s">
            {control.fields.map((f) => (
              <label key={f.key} className="inline-label">
                {f.key}
                <select
                  value={obj[f.key] ?? ''}
                  onChange={(e) => {
                    const next = { ...obj };
                    if (e.target.value) next[f.key] = e.target.value;
                    else delete next[f.key];
                    onChange(Object.keys(next).length ? next : undefined);
                  }}
                >
                  <option value="">auto</option>
                  {f.values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <IssueText issues={issuesAt(issues, `options.${control.key}`)} />
        </div>
      );
    }
    case 'json':
      return (
        <div className="slot">
          <span className="field-label">{label}</span>
          <p className="muted small">Edit “{control.key}” in the JSON view.</p>
          <IssueText issues={issuesAt(issues, `options.${control.key}`)} />
        </div>
      );
  }
  return (
    <div className="slot">
      <label className="field-label">
        {label}
        {input}
      </label>
      <IssueText issues={issuesAt(issues, `options.${control.key}`)} />
    </div>
  );
}

const QUERY_FIELDS = /^query\.(dimensions|measures|filters|orderBy|limit|sql|columns|fields|calcs|detail|windows|topN|joins|metrics)(\.|$)/;
const under = (local: string, path: string) => local === path || local.startsWith(`${path}.`);

export function WidgetInspector({ draft, widgetId, issues, fields, dispatch, onRemove, runDraftQuery }: WidgetInspectorProps) {
  const widget = draft.widgets[widgetId]!;
  const info = widgetTypeInfo(widget.type);
  const queryId = widget.query;
  const rawQuery = queryId ? draft.queries[queryId] : undefined;
  const query = normalizeQuery(rawQuery);
  const columns = columnNames(rawQuery).all;
  const sharedWith = Object.entries(draft.widgets).filter(([id, w]) => id !== widgetId && w.query === queryId && queryId);
  const needsQuery = info?.needsQuery ?? true;
  const [tabRaw, setTab] = useState<'data' | 'style'>('data');
  const tab = needsQuery ? tabRaw : 'style';
  // Each issue shows next to its field; the rest are listed at the top. Tabs count their errors.
  const onData = (i: LocatedIssue) => QUERY_FIELDS.test(i.local) || (info?.slots.some((s) => under(i.local, `${s.container}.${s.key}`)) ?? false);
  const onStyle = (i: LocatedIssue) => info?.options.some((o) => under(i.local, `options.${o.key}`)) ?? false;
  const general = issues.filter((i) => !onData(i) && !onStyle(i));
  const count = (pred: (i: LocatedIssue) => boolean) => {
    const n = issues.filter((i) => i.severity === 'error' && pred(i)).length;
    return n ? <span className="tab-badge">{n}</span> : null;
  };

  const setQuery = (q: NormalQuery, coalesce?: string) => queryId && dispatch({ type: 'updateQuery', id: queryId, query: compactQuery(q) }, coalesce);
  const setField = (container: 'encoding' | 'options', key: string, value: unknown, coalesce?: boolean) =>
    dispatch({ type: 'setWidgetField', id: widgetId, container, key, value }, coalesce ? `w:${widgetId}:${container}.${key}` : undefined);

  return (
    <div className="inspector-body">
      <div className="inspector-head">
        <select value={widget.type} onChange={(e) => dispatch({ type: 'setWidgetType', id: widgetId, widgetType: e.target.value, fields })} aria-label="Widget type" className="type-select">
          {!info && <option value={widget.type}>{widget.type} (unknown)</option>}
          {widgetTypes().map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <code className="muted">{widgetId}</code>
        <button type="button" className="btn ghost small danger" onClick={onRemove}>
          Delete
        </button>
      </div>

      <div className="tabs" role="tablist">
        {needsQuery && (
          <button type="button" role="tab" aria-selected={tab === 'data'} onClick={() => setTab('data')}>
            Data {count(onData)}
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === 'style'} onClick={() => setTab('style')}>
          Display {count(onStyle)}
        </button>
      </div>

      {general.length > 0 && <IssueText issues={general} />}

      {tab === 'data' && (
        <>
          {!queryId || !rawQuery ? (
            <p className="note small">This widget has no valid query. Fix it in the JSON view.</p>
          ) : (
            <>
              <div className="query-head">
                <label className="inline-label">
                  Source
                  <select value={query.source} onChange={(e) => setQuery({ ...query, source: e.target.value })}>
                    {!draft.dataSources[query.source] && <option value={query.source}>{query.source || '(none)'}</option>}
                    {Object.entries(draft.dataSources).map(([id, ds]) => (
                      <option key={id} value={id}>
                        {id} · {ds.type}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="muted small">
                  query <code>{queryId}</code>
                </span>
              </div>
              {sharedWith.length > 0 && (
                <p className="note small">
                  Shared with {sharedWith.map(([id]) => id).join(', ')}: edits change {sharedWith.length > 1 ? 'them' : 'it'} too.{' '}
                  <button type="button" className="link" onClick={() => dispatch({ type: 'forkQuery', widgetId })}>
                    Give this widget its own query
                  </button>
                </p>
              )}
              <QueryEditor
                queryId={queryId}
                query={query}
                fields={fields}
                issues={issues}
                onChange={setQuery}
                onRun={
                  runDraftQuery &&
                  ((q) => {
                    // Just this query, without declared columns (so every column comes back) or filters:
                    // the rest of the draft may not be valid yet while columns are being declared.
                    const { columns: _c, filters: _f, ...rest } = compactQuery({ ...q, filters: [] });
                    const spec = { specVersion: SPEC_VERSION, id: draft.id, title: draft.title || 'Draft', dataSources: draft.dataSources, queries: { [queryId]: { ...rest, limit: 200 } }, widgets: {}, layout: [], params: {} };
                    return runDraftQuery(spec, queryId);
                  })
                }
              />
            </>
          )}
          {info && info.slots.length > 0 && (
            <section className="encoding">
              <h4>Show</h4>
              {info.slots.map((slot) => (
                <SlotEditor key={`${slot.container}.${slot.key}`} slot={slot} widget={widget} columns={columns} issues={issues} onChange={(v) => setField(slot.container, slot.key, v)} />
              ))}
            </section>
          )}
          {info?.needsQuery && <DrillEditor draft={draft} widgetId={widgetId} dispatch={dispatch} fields={fields} />}
        </>
      )}

      {tab === 'style' && info && (
        <section className="options">
          {info.options.map((control) => (
            <OptionEditor
              key={control.key}
              control={control}
              value={widget.options?.[control.key]}
              issues={issues}
              columns={columns}
              onChange={(v, coalesce) => setField('options', control.key, v, coalesce)}
            />
          ))}
        </section>
      )}
    </div>
  );
}
