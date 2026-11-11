/**
 * Structured editors for spec 1.3 option lists the generic inspector can't express well:
 * reference lines, conditional formats and KPI thresholds. Values go through the same option
 * setter as every control, so validation reports problems inline as usual.
 */

import type { CSSProperties } from 'react';

// Layout inline: these editors live inside the inspector and own no stylesheet.
const ROW: CSSProperties = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' };
const LIST: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' };
const CARD: CSSProperties = { ...LIST, padding: 6, border: '1px solid var(--s-border)', borderRadius: 6, alignSelf: 'stretch' };

type Rule = { op: string; value: number | number[]; color?: string; background?: string };
const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between'] as const;
const OP_LABEL: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠', between: 'between' };
const num = (s: string) => (s === '' || Number.isNaN(Number(s)) ? 0 : Number(s));

function RuleRow({ rule, onChange, onRemove }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void }) {
  const between = rule.op === 'between';
  const [lo, hi] = Array.isArray(rule.value) ? rule.value : [rule.value, rule.value];
  return (
    <div style={ROW}>
      <select aria-label="Condition" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value, value: e.target.value === 'between' ? [lo ?? 0, hi ?? 0] : (lo ?? 0) })}>
        {OPS.map((o) => (
          <option key={o} value={o}>
            {OP_LABEL[o]}
          </option>
        ))}
      </select>
      <input aria-label="Value" type="number" value={lo ?? 0} onChange={(e) => onChange({ ...rule, value: between ? [num(e.target.value), hi ?? 0] : num(e.target.value) })} />
      {between && <input aria-label="Upper value" type="number" value={hi ?? 0} onChange={(e) => onChange({ ...rule, value: [lo ?? 0, num(e.target.value)] })} />}
      <input aria-label="Text color" type="color" value={rule.color ?? '#000000'} onChange={(e) => onChange({ ...rule, color: e.target.value })} title="Text color" />
      <input aria-label="Background" type="color" value={rule.background ?? '#ffffff'} onChange={(e) => onChange({ ...rule, background: e.target.value })} title="Background" />
      <button type="button" className="btn tiny ghost" aria-label="Remove rule" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

export function RulesEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const rules = (Array.isArray(value) ? value : []) as Rule[];
  const set = (next: Rule[]) => onChange(next.length ? next : undefined);
  return (
    <div style={LIST}>
      {rules.map((r, i) => (
        <RuleRow key={i} rule={r} onChange={(nr) => set(rules.map((x, j) => (j === i ? nr : x)))} onRemove={() => set(rules.filter((_, j) => j !== i))} />
      ))}
      <button type="button" className="btn small" onClick={() => set([...rules, { op: 'gt', value: 0, color: '#d03b3b' }])}>
        Add rule
      </button>
    </div>
  );
}

type CF = { field: string; rules?: Rule[]; scale?: { from: string; to: string; mid?: string } };

export function ConditionalFormatsEditor({ value, onChange, columns }: { value: unknown; onChange: (v: unknown) => void; columns: string[] }) {
  const list = (Array.isArray(value) ? value : []) as CF[];
  const set = (next: CF[]) => onChange(next.length ? next : undefined);
  const update = (i: number, cf: CF) => set(list.map((x, j) => (j === i ? cf : x)));
  return (
    <div style={LIST}>
      {list.map((cf, i) => (
        <div key={i} style={CARD}>
          <div style={ROW}>
            <select aria-label="Column" value={cf.field} onChange={(e) => update(i, { ...cf, field: e.target.value })}>
              {[...new Set([cf.field, ...columns])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select aria-label="Format kind" value={cf.scale ? 'scale' : 'rules'} onChange={(e) => update(i, e.target.value === 'scale' ? { field: cf.field, scale: { from: '#ffffff', to: '#2a78d6' } } : { field: cf.field, rules: [{ op: 'gt', value: 0, color: '#d03b3b' }] })}>
              <option value="rules">Rules</option>
              <option value="scale">Color scale</option>
            </select>
            <button type="button" className="btn tiny ghost" aria-label="Remove format" onClick={() => set(list.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
          {cf.scale ? (
            <div style={ROW}>
              <label className="inline-label">
                from <input type="color" value={cf.scale.from} onChange={(e) => update(i, { ...cf, scale: { ...cf.scale!, from: e.target.value } })} />
              </label>
              <label className="inline-label">
                to <input type="color" value={cf.scale.to} onChange={(e) => update(i, { ...cf, scale: { ...cf.scale!, to: e.target.value } })} />
              </label>
            </div>
          ) : (
            <RulesEditor value={cf.rules} onChange={(rules) => update(i, { field: cf.field, rules: (rules as Rule[] | undefined) ?? [{ op: 'gt', value: 0, color: '#d03b3b' }] })} />
          )}
        </div>
      ))}
      <button type="button" className="btn small" disabled={!columns.length} onClick={() => set([...list, { field: columns[0]!, scale: { from: '#ffffff', to: '#2a78d6' } }])}>
        Add conditional format
      </button>
    </div>
  );
}

type RefLine = { axis?: 'x' | 'y'; value?: number | string; field?: string; label?: string; color?: string; dashed?: boolean };

export function ReferenceLinesEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const list = (Array.isArray(value) ? value : []) as RefLine[];
  const set = (next: RefLine[]) => onChange(next.length ? next : undefined);
  const update = (i: number, r: RefLine) => set(list.map((x, j) => (j === i ? r : x)));
  return (
    <div style={LIST}>
      {list.map((r, i) => (
        <div key={i} style={ROW}>
          <select aria-label="Axis" value={r.axis ?? 'y'} onChange={(e) => update(i, { ...r, axis: e.target.value as 'x' | 'y' })}>
            <option value="y">y =</option>
            <option value="x">x =</option>
          </select>
          <input
            aria-label="Line value"
            value={r.value ?? ''}
            onChange={(e) => update(i, { ...r, value: (r.axis ?? 'y') === 'y' ? num(e.target.value) : e.target.value })}
            style={{ width: 80 }}
          />
          <input aria-label="Line label" placeholder="Label" value={r.label ?? ''} onChange={(e) => update(i, { ...r, label: e.target.value || undefined })} />
          <input aria-label="Line color" type="color" value={r.color ?? '#52514e'} onChange={(e) => update(i, { ...r, color: e.target.value })} />
          <button type="button" className="btn tiny ghost" aria-label="Remove line" onClick={() => set(list.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn small" onClick={() => set([...list, { value: 0, label: 'Target' }])}>
        Add reference line
      </button>
    </div>
  );
}
