import type { Cell, RenderableWidget } from '@yourorg/bi-spec';
import { useContext } from 'react';
import { InteractionContext } from './interactions';

/**
 * OWNER: workstream B. Rendered in each widget's header: the drill breadcrumb (with "up"), and a chip
 * when this widget drives or receives a cross-filter (click × to clear). Null when there is nothing.
 */
const show = (v: Cell) => (v === null ? '(empty)' : String(v));

export function InteractionBadge({ widgetId }: { widgetId: string; widget: RenderableWidget }) {
  const engine = useContext(InteractionContext);
  const state = engine?.state?.(widgetId);
  if (!state || (!state.drill && !state.filtering && !state.filteredBy)) return null;
  const chip = state.filtering ?? state.filteredBy;
  return (
    <span className="bi-interact">
      {state.drill && (
        <span className="bi-crumb" aria-label="Drill-down">
          <button type="button" className="bi-chip-btn" onClick={state.drill.reset} title="Back to the top level">
            All
          </button>
          {state.drill.path.map((v, i) => (
            <span key={i}>› {show(v)}</span>
          ))}
          <button type="button" className="bi-chip-btn" onClick={state.drill.up} aria-label="Up one level" title="Up one level">
            ↑
          </button>
        </span>
      )}
      {chip && (
        <span className="bi-chip" data-source={state.filtering ? '' : undefined} title={`${state.filtering ? 'Filtering by' : 'Filtered by'} ${chip.field}`}>
          {chip.field}: {chip.values.map(show).join(', ')}
          <button type="button" className="bi-chip-btn" onClick={chip.clear} aria-label="Clear filter">
            ×
          </button>
        </span>
      )}
    </span>
  );
}

/** OWNER: workstream B. CSS for interaction UI (tabs, breadcrumbs, filter chips). */
export const INTERACTION_CSS = `
.bi-tabs{display:flex;gap:4px;border-bottom:1px solid var(--bi-border);margin:0 0 12px;overflow-x:auto}
.bi-tab{font:inherit;font-size:13px;color:var(--bi-text-2);background:transparent;border:0;border-bottom:2px solid transparent;padding:6px 10px;cursor:pointer;white-space:nowrap}
.bi-tab[aria-selected="true"]{color:var(--bi-text);border-bottom-color:var(--bi-accent,var(--bi-series-1));font-weight:600}
.bi-interact{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto;font-size:11px;color:var(--bi-text-2)}
.bi-crumb{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bi-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--bi-border);border-radius:999px;padding:0 4px 0 8px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
.bi-chip[data-source]{border-color:var(--bi-accent,var(--bi-series-1))}
.bi-chip-btn{font:inherit;font-size:11px;line-height:16px;color:var(--bi-text-2);background:transparent;border:0;border-radius:4px;padding:0 4px;cursor:pointer}
.bi-chip-btn:hover{background:var(--bi-hover)}
`;
