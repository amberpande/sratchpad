import type { Annotation, Cell, ConditionalFormat, QueryResult, ReferenceBand, ReferenceLine as RefLineSpec, ThresholdRule } from '@yourorg/bi-spec';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { ReferenceArea, ReferenceDot, ReferenceLine } from 'recharts';
import { useWidgetInteractions } from '../interactions';

/**
 * Shared pieces for spec 1.3 visuals and formatting. Everything here works on results that are
 * already aggregated: it reshapes, scales and colors, it never groups raw rows.
 */

// ── size ─────────────────────────────────────────────────────────────────────

/** The element's content size (0×0 until measured). Custom SVG widgets lay out from this. */
export function useSize<T extends HTMLElement>(): [RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize({ width: r.width, height: r.height });
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

// ── colors ───────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Interpolates two hex colors (t in 0..1). Inputs are validated hex from the spec. */
export function lerpColor(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * Math.min(1, Math.max(0, t))));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A sequential color for t in 0..1. With author colors: interpolated hex. Without: the first series
 * color at rising opacity, which follows the theme (light and dark) automatically.
 */
export function scaleFill(t: number, colors?: { from: string; to: string }): { fill: string; fillOpacity: number } {
  if (colors) return { fill: lerpColor(colors.from, colors.to, t), fillOpacity: 1 };
  return { fill: 'var(--bi-series-1)', fillOpacity: 0.12 + 0.88 * Math.min(1, Math.max(0, t)) };
}

export function extent(values: Cell[]): [number, number] | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)];
}

export const norm = (v: number, [lo, hi]: [number, number]) => (hi === lo ? 1 : (v - lo) / (hi - lo));

// ── thresholds & conditional formats ─────────────────────────────────────────

export function matchRule(value: Cell | undefined, rules: ThresholdRule[] | undefined): ThresholdRule | undefined {
  if (typeof value !== 'number' || !rules) return undefined;
  return rules.find((r) => {
    if (r.op === 'between') {
      const [lo, hi] = r.value as number[];
      return value >= lo! && value <= hi!;
    }
    const n = r.value as number;
    switch (r.op) {
      case 'gt':
        return value > n;
      case 'gte':
        return value >= n;
      case 'lt':
        return value < n;
      case 'lte':
        return value <= n;
      case 'eq':
        return value === n;
      case 'neq':
        return value !== n;
    }
    return false;
  });
}

/**
 * Cell colors for a conditional format, given the column's value range over the displayed rows.
 * Returned as CSS custom properties (`--bi-cell-fg` / `--bi-cell-bg`, consumed by viz.css), never as
 * raw CSS: the spec's styling invariant. Values are validated hex.
 */
export function conditionalStyle(cf: ConditionalFormat, value: Cell | undefined, range: [number, number] | null): CSSProperties | undefined {
  if (cf.rules) {
    const rule = matchRule(value, cf.rules);
    return rule ? cellVars(rule.color, rule.background) : undefined;
  }
  if (cf.scale && typeof value === 'number' && range) {
    const t = norm(value, range);
    const bg = cf.scale.mid ? (t < 0.5 ? lerpColor(cf.scale.from, cf.scale.mid, t * 2) : lerpColor(cf.scale.mid, cf.scale.to, (t - 0.5) * 2)) : lerpColor(cf.scale.from, cf.scale.to, t);
    return cellVars(luminance(bg) < 0.4 ? '#ffffff' : '#111111', bg);
  }
  return undefined;
}

export function cellVars(fg?: string, bg?: string): CSSProperties | undefined {
  if (!fg && !bg) return undefined;
  return { ...(fg ? { '--bi-cell-fg': fg } : {}), ...(bg ? { '--bi-cell-bg': bg } : {}) } as CSSProperties;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ── interactions ─────────────────────────────────────────────────────────────

/**
 * Click handling for marks of one field: reports selections to the interaction engine and says how
 * to draw each mark (dimmed when another value is selected). No-op without an engine.
 */
export function useMarks(field: string | undefined) {
  const it = useWidgetInteractions();
  return {
    interactive: it.interactive && Boolean(field),
    onSelect: (value: Cell, event?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
      if (field && it.interactive) it.select({ field, value }, { additive: Boolean(event?.shiftKey || event?.metaKey || event?.ctrlKey) });
    },
    /** Opacity multiplier: 1 normally, dimmed when a selection excludes this value. */
    opacity: (value: Cell) => (field && it.isSelected(field, value) === false ? 0.3 : 1),
    selected: (value: Cell) => Boolean(field && it.isSelected(field, value)),
    cursor: it.interactive && field ? 'pointer' : undefined,
  };
}

// ── small multiples ──────────────────────────────────────────────────────────

export const MAX_FACETS = 12;

/** Splits a result by a facet column, in first-seen order. Rows are partitioned, never combined. */
export function facetResults(result: QueryResult, facet: string): { panels: Array<{ value: Cell; result: QueryResult }>; hidden: number } {
  const groups = new Map<string, { value: Cell; rows: QueryResult['rows'] }>();
  for (const row of result.rows) {
    const value = row[facet] ?? null;
    const key = JSON.stringify(value);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { value, rows: [] }));
    g.rows.push(row);
  }
  const all = [...groups.values()];
  return {
    panels: all.slice(0, MAX_FACETS).map((g) => ({ value: g.value, result: { ...result, rows: g.rows } })),
    hidden: Math.max(0, all.length - MAX_FACETS),
  };
}

/** Rounds away from zero to 1, 2, 2.5 or 5 × a power of ten, so axis ticks land on round numbers. */
export function niceBound(v: number): number {
  if (v === 0) return 0;
  const sign = Math.sign(v);
  const a = Math.abs(v);
  const p = 10 ** Math.floor(Math.log10(a));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * p >= a)!;
  return sign * step * p;
}

/** A shared value-axis domain across panels, so small multiples compare at a glance. */
export function sharedDomain(result: QueryResult, columns: string[]): [number, number] | undefined {
  const values = result.rows.flatMap((r) => columns.map((c) => r[c] ?? null));
  const e = extent(values);
  if (!e) return undefined;
  return [niceBound(Math.min(0, e[0])), niceBound(Math.max(0, e[1]))];
}

export function Facets({ result, facet, label, render }: { result: QueryResult; facet: string; label: (v: Cell) => string; render: (panel: QueryResult) => ReactNode }) {
  const { panels, hidden } = useMemo(() => facetResults(result, facet), [result, facet]);
  const cols = panels.length <= 2 ? panels.length : panels.length <= 4 ? 2 : panels.length <= 9 ? 3 : 4;
  return (
    <div className="bi-facets" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}>
      {panels.map((p, i) => (
        <figure key={i} className="bi-facet">
          <figcaption>{label(p.value)}</figcaption>
          <div className="bi-facet-plot">{render(p.result)}</div>
        </figure>
      ))}
      {hidden > 0 && <p className="bi-facet-note">{hidden} more panel(s) not shown.</p>}
    </div>
  );
}

// ── reference lines, bands, annotations (Recharts) ───────────────────────────

const refColor = (c?: string) => c ?? 'var(--bi-text-2)';

/**
 * Recharts children for 1.3 references. A line with `field` sits at that column's value in the first
 * row (e.g. a target measure); `axis: "x"` lines/bands use x values as they appear in the data.
 */
export function referenceChildren(
  opts: { referenceLines?: RefLineSpec[]; referenceBands?: ReferenceBand[]; annotations?: Annotation[] },
  firstRow: Record<string, Cell> | undefined,
  { horizontal = false, yAxisId }: { horizontal?: boolean; yAxisId?: string } = {},
): ReactNode[] {
  const out: ReactNode[] = [];
  // On horizontal bars the value axis is x: swap so authors keep thinking "y = value".
  const valueAxis = horizontal ? 'x' : 'y';
  const categoryAxis = horizontal ? 'y' : 'x';
  const axisProps = yAxisId ? { yAxisId } : {};
  (opts.referenceBands ?? []).forEach((b, i) => {
    const onValue = b.axis === 'y';
    const a = onValue ? valueAxis : categoryAxis;
    out.push(
      <ReferenceArea
        key={`band${i}`}
        {...(a === 'y' ? { y1: b.from, y2: b.to } : { x1: b.from, x2: b.to })}
        {...axisProps}
        fill={refColor(b.color)}
        fillOpacity={0.12}
        stroke="none"
        ifOverflow="extendDomain"
        label={b.label ? { value: b.label, position: 'insideTopLeft', className: 'bi-ref-label' } : undefined}
      />,
    );
  });
  (opts.referenceLines ?? []).forEach((l, i) => {
    const value = l.field !== undefined ? firstRow?.[l.field] : l.value;
    if (value === undefined || value === null || typeof value === 'boolean') return;
    const a = l.axis === 'y' ? valueAxis : categoryAxis;
    out.push(
      <ReferenceLine
        key={`line${i}`}
        {...(a === 'y' ? { y: value } : { x: value })}
        {...axisProps}
        stroke={refColor(l.color)}
        strokeWidth={1.5}
        strokeDasharray={l.dashed === false ? undefined : '4 3'}
        ifOverflow="extendDomain"
        label={l.label ? { value: l.label, position: a === 'y' ? 'insideTopLeft' : 'insideTop', className: 'bi-ref-label' } : undefined}
      />,
    );
  });
  (opts.annotations ?? []).forEach((n, i) => {
    out.push(
      n.y !== undefined ? (
        <ReferenceDot key={`note${i}`} {...(horizontal ? { y: n.x, x: n.y } : { x: n.x, y: n.y })} {...axisProps} r={4} fill="var(--bi-text)" stroke="var(--bi-surface)" ifOverflow="extendDomain" label={{ value: n.text, position: 'top', className: 'bi-ref-label' }} />
      ) : (
        <ReferenceLine key={`note${i}`} {...(horizontal ? { y: n.x } : { x: n.x })} {...axisProps} stroke="var(--bi-text-3)" strokeDasharray="2 3" label={{ value: n.text, position: 'insideTop', className: 'bi-ref-label' }} />
      ),
    );
  });
  return out;
}

/** Rows of the original result keyed by their x value (for tooltip extra fields). */
export function rowsByX(result: QueryResult, x: string): Map<string, Record<string, Cell>> {
  const m = new Map<string, Record<string, Cell>>();
  for (const r of result.rows) {
    const k = JSON.stringify(r[x] ?? null);
    if (!m.has(k)) m.set(k, r);
  }
  return m;
}
