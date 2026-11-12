import { AGGREGATIONS, FILTER_OPS, MAX_QUERY_LIMIT, TIME_GRAINS, type Aggregation, type Filter, type FilterOp, type Scalar, type TimeGrain } from '@yourorg/bi-spec';
import { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import { issuesAt, type LocatedIssue } from '../draft/issues';
import { addField, columnNames, compactQuery, EXTENSION_KEYS, type NormalQuery } from '../draft/query';
import type { FieldInfo } from '../draft/types';
import { isFieldDrag, readFieldDrag } from './dnd';
import { FieldTypeIcon } from './icons';
import { IssueText } from './IssueList';

export interface QueryEditorProps {
  queryId: string;
  query: NormalQuery;
  fields: FieldInfo[];
  issues: LocatedIssue[];
  onChange: (query: NormalQuery, coalesce?: string) => void;
}

const AGG_LABEL: Record<Aggregation, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  count: 'Count',
  count_distinct: 'Count distinct',
  median: 'Median',
  p25: '25th percentile',
  p75: '75th percentile',
  p90: '90th percentile',
  stddev: 'Std deviation',
};
const OP_LABEL: Record<FilterOp, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'in',
  not_in: 'not in',
  between: 'between',
  is_null: 'is empty',
  not_null: 'is not empty',
  contains: 'contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
};

type ExtKey = (typeof EXTENSION_KEYS)[number];
const ADVANCED_KEYS: ExtKey[] = ['windows', 'topN', 'joins', 'metrics'];

/**
 * Spec 1.3 table calcs, top-N, joins and catalog metrics as a small JSON editor (applied when it
 * parses as an object; validation shows problems inline like any other field).
 */
function AdvancedEditor({ query, onChange }: { query: NormalQuery; onChange: (q: NormalQuery) => void }) {
  const current = () => {
    const o: Record<string, unknown> = {};
    for (const k of ADVANCED_KEYS) if (query[k] !== undefined) o[k] = query[k];
    return Object.keys(o).length ? JSON.stringify(o, null, 2) : '';
  };
  const [text, setText] = useState(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(current());
  }, [JSON.stringify(ADVANCED_KEYS.map((k) => query[k]))]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="advanced-query">
      <textarea
        aria-label="Advanced query JSON"
        rows={6}
        spellCheck={false}
        value={text}
        placeholder={'{\n  "windows": [{ "as": "running", "type": "running_total", "measure": "revenue", "order": "order_date" }],\n  "topN": { "dimension": "region", "n": 5, "by": "revenue" }\n}'}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            const next = { ...query };
            for (const k of ADVANCED_KEYS) delete next[k];
            setError(null);
            onChange(next);
            return;
          }
          try {
            const parsed = JSON.parse(e.target.value) as Record<string, unknown>;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Use a JSON object.');
            const unknown = Object.keys(parsed).filter((k) => !ADVANCED_KEYS.includes(k as ExtKey));
            if (unknown.length) throw new Error(`Unknown key(s): ${unknown.join(', ')}. Use ${ADVANCED_KEYS.join(', ')}.`);
            const next = { ...query };
            for (const k of ADVANCED_KEYS) delete next[k];
            setError(null);
            onChange({ ...next, ...(parsed as Partial<NormalQuery>) });
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error && <p className="note small">{error}</p>}
      <p className="muted small">windows: running_total, percent_of_total, rank, moving_average, difference, percent_change · topN · joins · metrics (team catalog).</p>
    </div>
  );
}

const replaceAt = <T,>(list: T[], i: number, value: T) => list.map((x, n) => (n === i ? value : x));
const removeAt = <T,>(list: T[], i: number) => list.filter((_, n) => n !== i);

function fieldOptions(fields: FieldInfo[], current: string | undefined, extra: string[] = []) {
  const names = [...extra, ...fields.map((f) => f.name)];
  if (current && !names.includes(current)) names.unshift(current);
  return names.map((n) => (
    <option key={n} value={n}>
      {n === '*' ? '* (rows)' : n}
    </option>
  ));
}

/** A labelled list that also accepts fields dragged from the data panel. */
function DropSection({ title, onDropField, children, action }: { title: string; onDropField?: (f: FieldInfo) => void; children: ReactNode; action?: ReactNode }) {
  const [over, setOver] = useState(false);
  const drop = onDropField
    ? {
        onDragOver: (e: DragEvent) => {
          if (!isFieldDrag(e)) return;
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          setOver(false);
          const d = readFieldDrag(e);
          if (d) {
            e.preventDefault();
            onDropField(d.field);
          }
        },
      }
    : {};
  return (
    <section className="drop-section" data-over={over || undefined} {...drop}>
      <header>
        <h4>{title}</h4>
        {action}
      </header>
      {children}
    </section>
  );
}

function AddFieldSelect({ label, fields, onPick }: { label: string; fields: FieldInfo[]; onPick: (f: FieldInfo) => void }) {
  return (
    <select
      className="add-select"
      value=""
      aria-label={label}
      onChange={(e) => {
        const f = fields.find((x) => x.name === e.target.value);
        if (f) onPick(f);
      }}
    >
      <option value="">+ {label}</option>
      {fields.map((f) => (
        <option key={f.name} value={f.name}>
          {f.name}
        </option>
      ))}
    </select>
  );
}

function parseScalar(text: string, numeric: boolean): Scalar {
  const t = text.trim();
  if (numeric && t !== '' && !Number.isNaN(Number(t))) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  return t;
}

function filterValueText(f: Filter): string {
  if (f.value === undefined || f.value === null) return '';
  return Array.isArray(f.value) ? f.value.map((v) => String(v)).join(', ') : String(f.value);
}

function buildFilterValue(op: FilterOp, text: string, numeric: boolean): Filter['value'] {
  if (op === 'is_null' || op === 'not_null') return undefined;
  if (op === 'in' || op === 'not_in' || op === 'between') {
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseScalar(s, numeric));
  }
  return parseScalar(text, numeric);
}

function FilterRow({ filter, fields, onChange, onRemove, issues }: { filter: Filter; fields: FieldInfo[]; onChange: (f: Filter) => void; onRemove: () => void; issues: LocatedIssue[] }) {
  const numeric = fields.find((f) => f.name === filter.field)?.semanticType === 'numeric';
  const [text, setText] = useState(filterValueText(filter));
  // Follow outside changes (undo, JSON edits) without fighting the user's typing.
  useEffect(() => {
    if (filterValueText({ ...filter, value: buildFilterValue(filter.op, text, numeric) }) !== filterValueText(filter)) setText(filterValueText(filter));
  }, [filter]);
  const noValue = filter.op === 'is_null' || filter.op === 'not_null';
  const placeholder = filter.op === 'between' ? 'low, high' : filter.op === 'in' || filter.op === 'not_in' ? 'a, b, c' : 'value';
  return (
    <li>
      <div className="q-row">
        <select value={filter.field} onChange={(e) => onChange({ ...filter, field: e.target.value })} aria-label="Filter field">
          {fieldOptions(fields, filter.field)}
        </select>
        <select
          className="narrow"
          value={filter.op}
          onChange={(e) => {
            const op = e.target.value as FilterOp;
            const next: Filter = { field: filter.field, op };
            const value = buildFilterValue(op, text, numeric);
            if (value !== undefined) next.value = value;
            onChange(next);
          }}
          aria-label="Operator"
        >
          {FILTER_OPS.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op]}
            </option>
          ))}
        </select>
        {!noValue && (
          <input
            value={text}
            placeholder={placeholder}
            aria-label="Filter value"
            onChange={(e) => {
              setText(e.target.value);
              onChange({ field: filter.field, op: filter.op, value: buildFilterValue(filter.op, e.target.value, numeric) });
            }}
          />
        )}
        <button type="button" className="btn ghost icon tiny" onClick={onRemove} aria-label="Remove filter">
          ×
        </button>
      </div>
      <IssueText issues={issues} />
    </li>
  );
}

export function QueryEditor({ queryId, query, fields, issues, onChange }: QueryEditorProps) {
  const cols = columnNames(compactQuery(query));
  const isTime = (name: string) => fields.find((f) => f.name === name)?.kind === 'time';
  const add = (f: FieldInfo, as: 'dimension' | 'measure') => onChange(addField(query, f, as).query);
  const key = (path: string) => `q:${queryId}:${path}`;

  return (
    <div className="query-editor">
      <DropSection title="Dimensions" onDropField={(f) => add(f, 'dimension')} action={<AddFieldSelect label="Dimension" fields={fields} onPick={(f) => add(f, 'dimension')} />}>
        {query.dimensions.length === 0 && <p className="drop-hint">Drop a time or category field</p>}
        <ul>
          {query.dimensions.map((d, i) => {
            const temporal = Boolean(d.grain) || isTime(d.field);
            const f = fields.find((x) => x.name === d.field);
            return (
              <li key={i}>
                <div className="q-row">
                  {f && <FieldTypeIcon semanticType={f.semanticType} />}
                  <select
                    value={d.field}
                    onChange={(e) => {
                      const name = e.target.value;
                      const { as: _as, ...rest } = d;
                      onChange({ ...query, dimensions: replaceAt(query.dimensions, i, isTime(name) ? { ...rest, field: name, grain: d.grain ?? 'month' } : { field: name }) });
                    }}
                    aria-label="Dimension field"
                  >
                    {fieldOptions(fields, d.field)}
                  </select>
                  {!temporal && f?.semanticType === 'numeric' && (
                    <input
                      className="narrow"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="bin"
                      title="Bin width (histogram buckets)"
                      aria-label="Bin width"
                      value={d.bin?.width ?? ''}
                      onChange={(e) => {
                        const width = Number(e.target.value);
                        const { bin: _b, ...rest } = d;
                        onChange({ ...query, dimensions: replaceAt(query.dimensions, i, e.target.value && width > 0 ? { ...rest, bin: { width } } : rest) }, key(`d${i}bin`));
                      }}
                    />
                  )}
                  {temporal && (
                    <select
                      className="narrow"
                      value={d.grain ?? ''}
                      onChange={(e) => {
                        const grain = e.target.value as TimeGrain | '';
                        const { grain: _g, ...rest } = d;
                        onChange({ ...query, dimensions: replaceAt(query.dimensions, i, grain ? { ...rest, grain } : rest) });
                      }}
                      aria-label="Time grain"
                    >
                      <option value="">raw</option>
                      {TIME_GRAINS.map((g) => (
                        <option key={g} value={g}>
                          by {g}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="button" className="btn ghost icon tiny" onClick={() => onChange({ ...query, dimensions: removeAt(query.dimensions, i) })} aria-label={`Remove ${d.field}`}>
                    ×
                  </button>
                </div>
                <IssueText issues={issuesAt(issues, `query.dimensions.${i}`)} />
              </li>
            );
          })}
        </ul>
      </DropSection>

      <DropSection title="Measures" onDropField={(f) => add(f, 'measure')} action={<AddFieldSelect label="Measure" fields={fields} onPick={(f) => add(f, 'measure')} />}>
        {query.measures.length === 0 && <p className="drop-hint">Drop a numeric field to aggregate</p>}
        <ul>
          {query.measures.map((m, i) => (
            <li key={i}>
              <div className="q-row">
                <select
                  className="narrow"
                  value={m.agg}
                  onChange={(e) => {
                    const agg = e.target.value as Aggregation;
                    onChange({ ...query, measures: replaceAt(query.measures, i, { ...m, agg, field: m.field === '*' && agg !== 'count' ? (fields[0]?.name ?? m.field) : m.field }) });
                  }}
                  aria-label="Aggregation"
                >
                  {AGGREGATIONS.map((a) => (
                    <option key={a} value={a}>
                      {AGG_LABEL[a]}
                    </option>
                  ))}
                </select>
                <select value={m.field} onChange={(e) => onChange({ ...query, measures: replaceAt(query.measures, i, { ...m, field: e.target.value }) })} aria-label="Measure field">
                  {fieldOptions(fields, m.field, m.agg === 'count' ? ['*'] : [])}
                </select>
                <button type="button" className="btn ghost icon tiny" onClick={() => onChange({ ...query, measures: removeAt(query.measures, i) })} aria-label={`Remove ${m.field}`}>
                  ×
                </button>
              </div>
              <div className="q-row sub">
                <label className="inline-label">
                  as
                  <input
                    value={m.as ?? ''}
                    placeholder={m.field === '*' ? m.agg : `${m.agg}_${m.field}`}
                    onChange={(e) => {
                      const { as: _as, ...rest } = m;
                      onChange({ ...query, measures: replaceAt(query.measures, i, e.target.value ? { ...rest, as: e.target.value } : rest) }, key(`m${i}.as`));
                    }}
                    aria-label="Output column name"
                  />
                </label>
              </div>
              <IssueText issues={issuesAt(issues, `query.measures.${i}`)} />
            </li>
          ))}
        </ul>
      </DropSection>

      <DropSection
        title="Filters"
        onDropField={(f) => onChange({ ...query, filters: [...query.filters, { field: f.name, op: 'not_null' }] })}
        action={
          <button type="button" className="btn ghost small" onClick={() => fields[0] && onChange({ ...query, filters: [...query.filters, { field: fields[0].name, op: 'not_null' }] })}>
            + Filter
          </button>
        }
      >
        <ul>
          {query.filters.map((f, i) => (
            <FilterRow
              key={i}
              filter={f}
              fields={fields}
              issues={issuesAt(issues, `query.filters.${i}`)}
              onChange={(next) => onChange({ ...query, filters: replaceAt(query.filters, i, next) }, key(`f${i}`))}
              onRemove={() => onChange({ ...query, filters: removeAt(query.filters, i) })}
            />
          ))}
        </ul>
      </DropSection>

      <DropSection
        title="Calculations"
        action={
          <button type="button" className="btn ghost small" onClick={() => onChange({ ...query, calcs: [...(query.calcs ?? []), { as: `calc_${(query.calcs?.length ?? 0) + 1}`, expr: cols.measures[0] ?? 'count(*)' }] })}>
            + Calc
          </button>
        }
      >
        {!query.calcs?.length && <p className="drop-hint">Expressions over measures, e.g. revenue / orders or sum(profit) / sum(amount)</p>}
        <ul>
          {(query.calcs ?? []).map((c, i) => (
            <li key={i}>
              <div className="q-row">
                <input className="narrow" value={c.as} aria-label="Calc name" onChange={(e) => onChange({ ...query, calcs: replaceAt(query.calcs!, i, { ...c, as: e.target.value }) }, key(`c${i}as`))} />
                <input value={c.expr} aria-label="Calc expression" spellCheck={false} onChange={(e) => onChange({ ...query, calcs: replaceAt(query.calcs!, i, { ...c, expr: e.target.value }) }, key(`c${i}expr`))} />
                <button type="button" className="btn ghost icon tiny" onClick={() => onChange({ ...query, calcs: removeAt(query.calcs!, i) })} aria-label={`Remove ${c.as}`}>
                  ×
                </button>
              </div>
              <IssueText issues={issuesAt(issues, `query.calcs.${i}`)} />
            </li>
          ))}
        </ul>
        <details>
          <summary className="small">Table calcs, top N, joins, catalog metrics</summary>
          <AdvancedEditor query={query} onChange={(q) => onChange(q, key('advanced'))} />
          {ADVANCED_KEYS.map((k) => (
            <IssueText key={k} issues={issuesAt(issues, `query.${k}`)} />
          ))}
        </details>
      </DropSection>

      <DropSection
        title="Sort"
        action={
          <button type="button" className="btn ghost small" disabled={!cols.all.length} onClick={() => onChange({ ...query, orderBy: [...query.orderBy, { field: cols.all[0]!, dir: 'asc' }] })}>
            + Sort
          </button>
        }
      >
        <ul>
          {query.orderBy.map((o, i) => (
            <li key={i}>
              <div className="q-row">
                <select value={o.field} onChange={(e) => onChange({ ...query, orderBy: replaceAt(query.orderBy, i, { ...o, field: e.target.value }) })} aria-label="Sort column">
                  {[...new Set([o.field, ...cols.all])].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select className="narrow" value={o.dir} onChange={(e) => onChange({ ...query, orderBy: replaceAt(query.orderBy, i, { ...o, dir: e.target.value as 'asc' | 'desc' }) })} aria-label="Direction">
                  <option value="asc">ascending</option>
                  <option value="desc">descending</option>
                </select>
                <button type="button" className="btn ghost icon tiny" onClick={() => onChange({ ...query, orderBy: removeAt(query.orderBy, i) })} aria-label="Remove sort">
                  ×
                </button>
              </div>
              <IssueText issues={issuesAt(issues, `query.orderBy.${i}`)} />
            </li>
          ))}
        </ul>
        <label className="inline-label">
          Row limit
          <input
            type="number"
            min={1}
            max={MAX_QUERY_LIMIT}
            value={query.limit ?? ''}
            placeholder="1000"
            onChange={(e) => {
              const { limit: _l, ...rest } = query;
              onChange(e.target.value ? { ...rest, limit: Number(e.target.value) } : rest, key('limit'));
            }}
          />
        </label>
        <IssueText issues={issuesAt(issues, 'query.limit')} />
      </DropSection>
    </div>
  );
}
