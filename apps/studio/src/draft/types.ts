import type { DashboardTheme, DataSource, LayoutItem, QueryInput, WidgetStyle } from '@yourorg/bi-spec';

/**
 * The editable draft: a dashboard document as an author writes it. It is the spec itself
 * (no shadow model), so what the canvas edits is exactly what is validated, previewed and saved.
 * Widgets and params stay loosely typed because the widget catalog grows (WIDGET_TYPES) and the
 * raw JSON view can put anything here; validateDashboard is the judge.
 */
export interface WidgetDraft {
  type: string;
  query?: string;
  encoding?: Record<string, unknown>;
  options?: Record<string, unknown>;
  /** Spec 1.2. */
  style?: WidgetStyle;
}

export interface ParamDraft {
  type: string;
  label?: string;
  field?: string;
  default?: unknown;
  bind?: string[];
  options?: unknown[];
  [key: string]: unknown;
}

export interface DraftSpec {
  specVersion: string;
  id: string;
  title: string;
  description?: string;
  dataSources: Record<string, DataSource>;
  queries: Record<string, QueryInput>;
  widgets: Record<string, WidgetDraft>;
  layout: LayoutItem[];
  params: Record<string, ParamDraft>;
  /** Spec 1.2. */
  theme?: DashboardTheme;
}

export type FieldKind = 'time' | 'measure' | 'dimension';

/** A source column as the field panel and query builder see it. */
export interface FieldInfo {
  name: string;
  kind: FieldKind;
  semanticType: string;
  /** Column usable only as a key/ignored by the profiler. */
  secondary?: boolean;
  format?: string;
}
