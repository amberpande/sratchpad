import type { DataSource, LayoutItem, Param, Query } from './schema';
import type { DashboardTheme } from './style';
import type { DashboardExtensionFields } from './dashboard-ext';
import type { RenderableWidget } from './widgets';

/** A dashboard that passed validation, with defaults applied and widgets typed. */
export interface ValidDashboard extends DashboardExtensionFields {
  specVersion: string;
  id: string;
  title: string;
  description?: string;
  dataSources: Record<string, DataSource>;
  queries: Record<string, Query>;
  widgets: Record<string, RenderableWidget>;
  layout: LayoutItem[];
  params: Record<string, Param>;
  /** Since 1.2. */
  theme?: DashboardTheme;
}

export interface Issue {
  /** Dotted path into the document, e.g. "widgets.w_line.encoding.y". */
  path: string;
  code: string;
  message: string;
}
