import type { Cell, QueryResult, RenderableWidget } from '@yourorg/bi-spec';
import { useState, type KeyboardEvent } from 'react';
import { formatValue } from '../format';
import { useWidgetInteractions } from '../interactions';
import type { FormatContext } from '../format';

/** The result column a chart's marks select by (its x axis, category or label), when it has one. */
export function selectableField(widget: RenderableWidget): string | undefined {
  const e = (widget as { encoding?: Record<string, unknown> }).encoding ?? {};
  for (const k of ['x', 'category', 'label', 'region', 'row', 'stage', 'source']) if (typeof e[k] === 'string') return e[k] as string;
  return undefined;
}

/**
 * Keyboard selection of chart marks (1.4, D-091): when a chart's clicks do something (cross-filter,
 * drill, drill-through), its values are also a keyboard toolbar: Tab to it, ←/→ to move, Enter or
 * Space to select (Shift adds to the selection). Hidden until it has focus, so the chart looks the same.
 */
export function KeyboardMarks({ widget, result, format, title }: { widget: RenderableWidget; result: QueryResult; format: FormatContext; title?: string }) {
  const it = useWidgetInteractions();
  const field = selectableField(widget);
  const [focus, setFocus] = useState(0);
  if (!it.interactive || !field) return null;
  const values: Cell[] = [];
  const seen = new Set<string>();
  for (const r of result.rows) {
    const v = r[field] ?? null;
    const k = JSON.stringify(v);
    if (!seen.has(k)) seen.add(k), values.push(v);
    if (values.length >= 60) break;
  }
  if (!values.length) return null;
  const col = result.columns.find((c) => c.name === field);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setFocus((f) => Math.min(values.length - 1, f + 1));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setFocus((f) => Math.max(0, f - 1));
    else if (e.key === 'Home') setFocus(0);
    else if (e.key === 'End') setFocus(values.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') it.select({ field, value: values[focus] ?? null }, { additive: e.shiftKey });
    else return;
    e.preventDefault();
  };
  const current = values[focus] ?? null;
  return (
    <div className="bi-kbd-marks" role="toolbar" tabIndex={0} aria-label={`${title ?? 'Chart'}: choose a value with the arrow keys, Enter to select`} onKeyDown={onKey}>
      <span aria-live="polite">
        {formatValue(current, undefined, col, format)}
        {it.isSelected(field, current) ? ' (selected)' : ''} · {focus + 1}/{values.length}
      </span>
    </div>
  );
}
