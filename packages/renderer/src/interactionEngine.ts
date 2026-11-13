import { crossFilterFields, type Cell, type RenderableWidget, type RuntimeFilter, type TimeGrain, type ValidDashboard } from '@yourorg/bi-spec';
import { useCallback, useMemo, useState } from 'react';
import type { QueryRuntime } from './data/client';
import type { InteractionEngine, MarkSelection, WidgetInteractionState, WidgetInteractions } from './interactions';

/**
 * Workstream B: the dashboard's interaction state and the engine charts talk to.
 *
 *   click a mark → drill one level down (if the widget declares `drill` and isn't at the bottom)
 *               → else open another dashboard (if it declares `drillThrough`, via onNavigate)
 *               → else cross-filter the other widgets (if the dashboard enables it).
 *
 * The engine only produces request *variants* (QueryRuntime) that the server re-validates against
 * the same declared config, so nothing here can make the server run an undeclared query.
 */

interface Selection {
  widgetId: string;
  /** Source column the selection filters (the clicked result column mapped back to its dimension). */
  field: string;
  /** Result column the chart reported (for highlighting). */
  column: string;
  grain?: TimeGrain;
  values: Cell[];
  /** A brushed time range: values = [from, to] (bucket starts, inclusive). */
  range?: boolean;
}

export interface NavigateRequest {
  dashboardId: string;
  params: Record<string, unknown>;
}

type W = RenderableWidget & {
  drill?: { levels: Array<{ field: string; grain?: TimeGrain; label?: string }>; dimension?: number };
  drillThrough?: { dashboardId: string; params?: Record<string, string> };
  interactions?: { crossFilter?: boolean };
};

const scalarValue = (v: Cell) => v !== null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');

export function useInteractionEngine(dashboard: ValidDashboard, onNavigate?: (req: NavigateRequest) => void) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [drills, setDrills] = useState<Record<string, { level: number; path: Cell[] }>>({});
  const crossFilter = Boolean(dashboard.interactions?.crossFilter);

  /** Maps a clicked result column of a widget to the source dimension (field + grain) it shows. */
  const dimensionOf = useCallback(
    (widgetId: string, column: string): { field: string; grain?: TimeGrain } | undefined => {
      const w = dashboard.widgets[widgetId] as W | undefined;
      if (!w || w.type === '__unsupported__' || !w.query) return undefined;
      const q = dashboard.queries[w.query];
      if (!q) return undefined;
      const idx = q.dimensions.findIndex((d) => (d.as ?? d.field) === column);
      if (idx < 0) return undefined;
      const drilled = drills[widgetId];
      if (idx === (w.drill?.dimension ?? 0) && drilled && w.drill) {
        const lvl = w.drill.levels[drilled.level]!;
        return { field: lvl.field, grain: lvl.grain };
      }
      const d = q.dimensions[idx]!;
      return { field: d.field, grain: d.grain };
    },
    [dashboard, drills],
  );

  const engine = useMemo<InteractionEngine>(() => {
    const widgetCrossFilters = (w: W) => crossFilter && w.interactions?.crossFilter !== false;
    return {
      forWidget(widgetId, widget): WidgetInteractions {
        const w = widget as W;
        const drill = w.drill;
        const atBottom = !drill || (drills[widgetId]?.level ?? 0) >= drill.levels.length - 1;
        const interactive = widget.type !== '__unsupported__' && (Boolean(drill) || Boolean(w.drillThrough) || widgetCrossFilters(w));
        return {
          interactive,
          select(sel: MarkSelection, event) {
            if (!interactive) return;
            if (drill && !atBottom) {
              if (!scalarValue(sel.value) && sel.value !== null) return;
              // Only clicks on the drilled dimension's marks drill (1.4: e.g. the series line, not the x axis).
              if (drill.dimension !== undefined) {
                const q = w.query ? dashboard.queries[w.query] : undefined;
                const d = q?.dimensions[drill.dimension];
                if (!d || sel.field !== (d.as ?? d.field)) return;
              }
              setDrills((d) => {
                const cur = d[widgetId] ?? { level: 0, path: [] };
                return { ...d, [widgetId]: { level: cur.level + 1, path: [...cur.path, sel.value] } };
              });
              return;
            }
            if (w.drillThrough && onNavigate) {
              const params: Record<string, unknown> = {};
              for (const [target, column] of Object.entries(w.drillThrough.params ?? {})) if (column === sel.field) params[target] = sel.value;
              onNavigate({ dashboardId: w.drillThrough.dashboardId, params });
              return;
            }
            if (!widgetCrossFilters(w) || !scalarValue(sel.value)) return;
            const dim = dimensionOf(widgetId, sel.field);
            if (!dim) return;
            setSelection((cur) => {
              const same = cur && cur.widgetId === widgetId && cur.column === sel.field;
              if (same && event?.additive && !dim.grain) {
                const values = cur.values.includes(sel.value) ? cur.values.filter((v) => v !== sel.value) : [...cur.values, sel.value];
                return values.length ? { ...cur, values } : null;
              }
              if (same && cur.values.length === 1 && cur.values[0] === sel.value) return null; // click again: clear
              return { widgetId, field: dim.field, column: sel.field, grain: dim.grain, values: [sel.value] };
            });
          },
          isSelected(field, value) {
            if (!selection || selection.widgetId !== widgetId || selection.column !== field) return undefined;
            if (selection.range) return typeof value === 'string' && value >= String(selection.values[0]) && value <= String(selection.values[1]);
            return selection.values.includes(value);
          },
          selectRange({ field, from, to }) {
            if (!widgetCrossFilters(w) || typeof from !== 'string' || typeof to !== 'string') return;
            const dim = dimensionOf(widgetId, field);
            if (!dim?.grain) return;
            const [a, b] = from <= to ? [from, to] : [to, from];
            setSelection({ widgetId, field: dim.field, column: field, grain: dim.grain, values: [a, b], range: a !== b });
          },
        };
      },
      state(widgetId): WidgetInteractionState {
        const out: WidgetInteractionState = {};
        const w = dashboard.widgets[widgetId] as W | undefined;
        const d = drills[widgetId];
        if (w?.drill && d && d.level > 0) {
          out.drill = {
            path: d.path,
            levelLabel: w.drill.levels[d.level]?.label ?? w.drill.levels[d.level]?.field,
            up: () => setDrills((all) => ({ ...all, [widgetId]: { level: d.level - 1, path: d.path.slice(0, -1) } })),
            reset: () => setDrills((all) => ({ ...all, [widgetId]: { level: 0, path: [] } })),
          };
        }
        if (selection) {
          const clear = () => setSelection(null);
          if (selection.widgetId === widgetId) out.filtering = { field: selection.field, values: selection.values, clear };
          else if (w && runtimeFor(widgetId)?.filters?.length) out.filteredBy = { field: selection.field, values: selection.values, clear };
        }
        return out;
      },
    };
    // runtimeFor is defined below and only reads the same state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, drills, selection, crossFilter, onNavigate, dimensionOf]);

  /** The request variant a widget's query needs right now (undefined = the plain saved query). */
  function runtimeFor(widgetId: string): QueryRuntime | undefined {
    const w = dashboard.widgets[widgetId] as W | undefined;
    if (!w || w.type === '__unsupported__' || !w.query) return undefined;
    const runtime: QueryRuntime = {};
    const d = drills[widgetId];
    if (w.drill && d && d.level > 0) runtime.drill = { widget: widgetId, level: d.level, path: d.path };
    if (selection && crossFilter && selection.widgetId !== widgetId && w.interactions?.crossFilter !== false) {
      const allowed = crossFilterFields(dashboard, w.query).get(selection.field);
      if (allowed && (!selection.grain || allowed.has(selection.grain))) {
        const values = selection.values.filter(scalarValue) as Array<string | number | boolean>;
        const filter: RuntimeFilter = selection.range
          ? { field: selection.field, op: 'between', grain: selection.grain, values: values.slice(0, 2) }
          : selection.grain
            ? { field: selection.field, op: 'eq', grain: selection.grain, values: values.slice(0, 1) }
            : { field: selection.field, op: 'in', values };
        if (values.length) runtime.filters = [filter];
      }
    }
    return runtime.drill || runtime.filters ? runtime : undefined;
  }

  return { engine, runtimeFor, selection };
}
