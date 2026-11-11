import type { Cell, RenderableWidget } from '@yourorg/bi-spec';
import { createContext, useContext } from 'react';

/**
 * CONTRACT between chart components (workstream C) and the interaction engine (workstream B).
 * Charts call `useWidgetInteractions(widgetId)` and report clicks on marks; B's provider turns them
 * into cross-filters, drill-downs or drill-throughs according to the dashboard and widget config,
 * and tells charts which marks are selected so they can de-emphasize the rest.
 * Without a provider (or when nothing is configured) everything is a no-op.
 */

export interface MarkSelection {
  /** Result column the mark represents (e.g. the x/category field), as named by the query. */
  field: string;
  value: Cell;
}

export interface WidgetInteractions {
  /** Whether clicking marks does anything for this widget (charts show a pointer cursor if true). */
  interactive: boolean;
  /** Report a click on a mark (a bar, slice, point, row, map region…). */
  select(selection: MarkSelection, event?: { additive?: boolean }): void;
  /** Whether a mark is part of the active selection; undefined when nothing is selected. */
  isSelected(field: string, value: Cell): boolean | undefined;
}

const NOOP: WidgetInteractions = { interactive: false, select: () => {}, isSelected: () => undefined };

/** What a widget's header shows about interactions (drill breadcrumb, active filters). */
export interface WidgetInteractionState {
  /** Drill breadcrumb: the clicked values from the top level down; `up` goes back one level. */
  drill?: { path: Cell[]; levelLabel?: string; up(): void; reset(): void };
  /** This widget is the source of the active cross-filter. */
  filtering?: { field: string; values: Cell[]; clear(): void };
  /** This widget is filtered by another widget's selection. */
  filteredBy?: { field: string; values: Cell[]; clear(): void };
}

export interface InteractionEngine {
  forWidget(widgetId: string, widget: RenderableWidget): WidgetInteractions;
  /** Optional: header state for a widget (workstream B's provider implements it). */
  state?(widgetId: string): WidgetInteractionState;
}

export const InteractionContext = createContext<InteractionEngine | null>(null);
/** The id of the widget being rendered (provided by WidgetFrame). */
export const WidgetIdContext = createContext<{ id: string; widget: RenderableWidget } | null>(null);

/** For chart components: interactions of the widget currently rendering. */
export function useWidgetInteractions(): WidgetInteractions {
  const engine = useContext(InteractionContext);
  const current = useContext(WidgetIdContext);
  if (!engine || !current) return NOOP;
  return engine.forWidget(current.id, current.widget);
}
