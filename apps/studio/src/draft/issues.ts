import type { Issue, ValidationResult } from '@yourorg/bi-spec';
import type { DraftSpec } from './types';

/**
 * Maps validateDashboard issues (dotted paths into the document) onto what the author sees:
 * a widget on the canvas, a field in the inspector, a param, or the dashboard itself.
 *
 * Widget-scoped issues get a `local` path relative to that widget:
 *   widgets.w.encoding.y.1          → "encoding.y.1"
 *   queries.q.measures.0.field      → "query.measures.0.field"   (for every widget on query q)
 *   layout.3.w                      → "layout.w"
 *   dataSources.ds.type             → "source.type"              (for every widget whose query reads ds)
 */

export type Severity = 'error' | 'warning';

export interface LocatedIssue extends Issue {
  severity: Severity;
  scope: 'widget' | 'param' | 'dashboard';
  widgetIds: string[];
  paramId?: string;
  queryId?: string;
  local: string;
}

export interface IssueIndex {
  errors: LocatedIssue[];
  warnings: LocatedIssue[];
  byWidget: Map<string, LocatedIssue[]>;
  byParam: Map<string, LocatedIssue[]>;
  dashboard: LocatedIssue[];
}

function widgetsOnQuery(draft: DraftSpec, queryId: string): string[] {
  return Object.entries(draft.widgets)
    .filter(([, w]) => w.query === queryId)
    .map(([id]) => id);
}

export function locateIssue(issue: Issue, severity: Severity, draft: DraftSpec): LocatedIssue {
  const parts = issue.path ? issue.path.split('.') : [];
  const [section, key, ...rest] = parts;
  const base = { ...issue, severity };
  const tail = rest.join('.');
  switch (section) {
    case 'widgets':
      if (key) return { ...base, scope: 'widget', widgetIds: [key], local: tail };
      break;
    case 'queries':
      if (key) {
        const widgetIds = widgetsOnQuery(draft, key);
        return { ...base, scope: widgetIds.length ? 'widget' : 'dashboard', widgetIds, queryId: key, local: tail ? `query.${tail}` : 'query' };
      }
      break;
    case 'layout': {
      const index = Number(key);
      const item = Number.isInteger(index) ? draft.layout[index] : undefined;
      if (item && typeof item.i === 'string' && draft.widgets[item.i]) return { ...base, scope: 'widget', widgetIds: [item.i], local: tail ? `layout.${tail}` : 'layout' };
      break;
    }
    case 'dataSources':
      if (key) {
        const queryIds = Object.entries(draft.queries)
          .filter(([, q]) => q.source === key)
          .map(([id]) => id);
        const widgetIds = queryIds.flatMap((q) => widgetsOnQuery(draft, q));
        if (widgetIds.length) return { ...base, scope: 'widget', widgetIds, local: tail ? `source.${tail}` : 'source' };
      }
      break;
    case 'params':
      if (key) return { ...base, scope: 'param', widgetIds: [], paramId: key, local: tail };
      break;
  }
  return { ...base, scope: 'dashboard', widgetIds: [], local: issue.path };
}

export function indexIssues(result: ValidationResult, draft: DraftSpec): IssueIndex {
  const errors = (result.ok ? [] : result.errors).map((i) => locateIssue(i, 'error', draft));
  const warnings = result.warnings.map((i) => locateIssue(i, 'warning', draft));
  const byWidget = new Map<string, LocatedIssue[]>();
  const byParam = new Map<string, LocatedIssue[]>();
  const dashboard: LocatedIssue[] = [];
  for (const issue of [...errors, ...warnings]) {
    if (issue.scope === 'widget') for (const id of issue.widgetIds) byWidget.set(id, [...(byWidget.get(id) ?? []), issue]);
    else if (issue.scope === 'param') byParam.set(issue.paramId!, [...(byParam.get(issue.paramId!) ?? []), issue]);
    else dashboard.push(issue);
  }
  return { errors, warnings, byWidget, byParam, dashboard };
}

/** Issues at a local path or anywhere under it, e.g. issuesAt(list, "query.measures.0"). */
export function issuesAt(list: LocatedIssue[] | undefined, local: string): LocatedIssue[] {
  return (list ?? []).filter((i) => i.local === local || i.local.startsWith(`${local}.`));
}

export const hasErrors = (list: LocatedIssue[] | undefined) => (list ?? []).some((i) => i.severity === 'error');
