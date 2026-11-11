import { DATE_PRESETS, type DateRangeValue } from '@yourorg/bi-spec';
import type { DraftSpec } from '../draft/types';

export const PRESET_LABEL: Record<string, string> = {
  last_7d: 'Last 7 days',
  last_30d: 'Last 30 days',
  last_90d: 'Last 90 days',
  last_365d: 'Last 12 months',
  mtd: 'Month to date',
  qtd: 'Quarter to date',
  ytd: 'Year to date',
  all: 'All time',
};

const today = () => new Date().toISOString().slice(0, 10);

/** Picks a date-range value: a preset, or a custom from/to. */
export function DateRangeInput({ value, onChange, label }: { value: unknown; onChange: (v: DateRangeValue) => void; label: string }) {
  const custom = typeof value === 'object' && value !== null ? (value as { from?: string; to?: string }) : null;
  return (
    <span className="daterange">
      <select
        aria-label={label}
        value={custom ? 'custom' : typeof value === 'string' ? value : 'all'}
        onChange={(e) => onChange(e.target.value === 'custom' ? { from: `${new Date().getUTCFullYear()}-01-01`, to: today() } : (e.target.value as DateRangeValue))}
      >
        {DATE_PRESETS.map((p) => (
          <option key={p} value={p}>
            {PRESET_LABEL[p] ?? p}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <>
          <input type="date" aria-label={`${label} from`} value={custom.from ?? ''} onChange={(e) => e.target.value && onChange({ from: e.target.value, to: custom.to ?? e.target.value })} />
          <span className="muted">–</span>
          <input type="date" aria-label={`${label} to`} value={custom.to ?? ''} onChange={(e) => e.target.value && onChange({ from: custom.from ?? e.target.value, to: e.target.value })} />
        </>
      )}
    </span>
  );
}

/** Preview input for a 1.3 param (multi-select with a fixed list, range, search, measure switch). */
function ExtraInput({ name, p, value, onChange }: { name: string; p: DraftSpec['params'][string]; value: unknown; onChange: (v: unknown) => void }) {
  const label = p.label ?? name;
  if (p.type === 'multiselect') {
    if (!p.options?.length) return <span className="muted small">{label}: choices load in the viewer</span>;
    const selected = Array.isArray(value) ? value : [];
    return (
      <select multiple aria-label={label} size={2} value={selected.map((v) => String(p.options!.indexOf(v)))} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => p.options![Number(o.value)]))}>
        {p.options.map((o, i) => (
          <option key={i} value={i}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  }
  if (p.type === 'range') {
    const [lo, hi] = Array.isArray(value) ? (value as [unknown, unknown]) : [null, null];
    const type = p.kind === 'date' ? 'date' : 'number';
    const parse = (v: string) => (v === '' ? null : type === 'date' ? v : Number(v));
    const set = (i: 0 | 1, v: string) => {
      const next: [unknown, unknown] = [lo, hi];
      next[i] = parse(v);
      onChange(next[0] === null && next[1] === null ? null : next);
    };
    return (
      <span className="daterange">
        <input type={type} aria-label={`${label} from`} value={lo == null ? '' : String(lo)} onChange={(e) => set(0, e.target.value)} />
        <span className="muted">–</span>
        <input type={type} aria-label={`${label} to`} value={hi == null ? '' : String(hi)} onChange={(e) => set(1, e.target.value)} />
      </span>
    );
  }
  if (p.type === 'search') return <input type="search" aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  if (p.type === 'measure') {
    const opts = (p.options ?? []) as unknown as Array<{ value: string; label?: string }>;
    return (
      <select aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
    );
  }
  return null;
}

/** Top-bar preview controls: try param values without changing the saved defaults. */
export function ParamControls({ draft, values, onChange }: { draft: DraftSpec; values: Record<string, unknown>; onChange: (name: string, value: unknown) => void }) {
  const params = Object.entries(draft.params).filter(([, p]) => ['daterange', 'multiselect', 'range', 'search', 'measure'].includes(p.type));
  if (!params.length) return null;
  return (
    <div className="param-controls" aria-label="Preview params">
      {params.map(([name, p]) => (
        <label key={name} className="inline-label" title={`Preview value for "${name}" (the saved default doesn't change)`}>
          {p.label ?? name}
          {p.type === 'daterange' ? (
            <DateRangeInput label={p.label ?? name} value={values[name] ?? p.default ?? 'all'} onChange={(v) => onChange(name, v)} />
          ) : (
            <ExtraInput name={name} p={p} value={values[name] ?? p.default} onChange={(v) => onChange(name, v)} />
          )}
        </label>
      ))}
    </div>
  );
}
