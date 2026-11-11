import {
  GRID_COLUMNS,
  requiredSpecVersion,
  validateDashboard,
  type DashboardInput,
  type DataSource,
  type LayoutItem,
  type QueryInput,
} from '@yourorg/bi-spec';
import { SOURCE_ID, type Candidate } from './candidates';

/**
 * Lays the chosen candidates out as a starter dashboard: KPIs across the top, the main trend full
 * width, comparisons two per row, tables full width. Adds a date-range control bound to every query
 * when the source has a time column. The result always validates; anything that would not is dropped.
 */

export const MAX_WIDGETS = 8;
const MAX_KPIS = 4;

export interface AssembleInput {
  source: DataSource;
  /** Display name of the source (file name, table name). */
  sourceName: string;
  /** Ranked best first. */
  candidates: Candidate[];
  title?: string;
  description?: string;
  /** Time column for the dashboard's date-range control. */
  timeField?: string;
  id?: string;
}

const FULL_WIDTH = new Set(['line-chart', 'area-chart', 'table', 'pivot']);
const HEIGHT: Record<string, number> = { kpi: 2, 'line-chart': 5, 'area-chart': 5, 'bar-chart': 5, pie: 5, scatter: 5, table: 6, pivot: 6 };

/** Picks up to MAX_WIDGETS candidates in rank order, at most one per subject and MAX_KPIS KPIs. */
export function selectCandidates(ranked: Candidate[], max = MAX_WIDGETS): Candidate[] {
  const chosen: Candidate[] = [];
  const subjects = new Set<string>();
  let kpis = 0;
  for (const c of ranked) {
    if (chosen.length >= max) break;
    if (subjects.has(c.subject)) continue;
    if (c.widget.type === 'kpi' && kpis >= MAX_KPIS) continue;
    chosen.push(c);
    subjects.add(c.subject);
    if (c.widget.type === 'kpi') kpis++;
  }
  return chosen;
}

function layout(chosen: Candidate[]): LayoutItem[] {
  const items: LayoutItem[] = [];
  const kpis = chosen.filter((c) => c.widget.type === 'kpi');
  const rest = chosen.filter((c) => c.widget.type !== 'kpi');
  let y = 0;
  if (kpis.length) {
    const w = Math.floor(GRID_COLUMNS / kpis.length);
    kpis.forEach((c, i) => items.push({ i: widgetId(c), x: i * w, y, w, h: HEIGHT.kpi! }));
    y += HEIGHT.kpi!;
  }
  // The top-ranked chart leads full width; half-width charts then pair up in rank order (a lone one
  // stretches); the remaining full-width charts follow.
  const [lead, ...others] = rest;
  const place = (c: Candidate, x: number, w: number, h: number) => items.push({ i: widgetId(c), x, y, w, h });
  if (lead) {
    const h = HEIGHT[lead.widget.type] ?? 5;
    place(lead, 0, GRID_COLUMNS, h);
    y += h;
  }
  const halves = others.filter((c) => !FULL_WIDTH.has(c.widget.type));
  for (let i = 0; i < halves.length; i += 2) {
    const a = halves[i]!;
    const b = halves[i + 1];
    const h = Math.max(HEIGHT[a.widget.type] ?? 5, b ? (HEIGHT[b.widget.type] ?? 5) : 0);
    if (b) {
      place(a, 0, GRID_COLUMNS / 2, h);
      place(b, GRID_COLUMNS / 2, GRID_COLUMNS / 2, h);
    } else {
      place(a, 0, GRID_COLUMNS, h);
    }
    y += h;
  }
  for (const c of others.filter((c) => FULL_WIDTH.has(c.widget.type))) {
    const h = HEIGHT[c.widget.type] ?? 5;
    place(c, 0, GRID_COLUMNS, h);
    y += h;
  }
  return items;
}

/** Widget ids derive from candidate ids ("c_x" → "w_x"), so they are stable and unique. */
export function widgetId(c: Candidate): string {
  return c.id.replace(/^c_/, 'w_');
}

function queryKey(c: Candidate): string {
  return c.widget.query as string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function build(input: AssembleInput, chosen: Candidate[]): DashboardInput {
  const queries: Record<string, QueryInput> = {};
  const widgets: DashboardInput['widgets'] = {};
  for (const c of chosen) {
    queries[queryKey(c)] = { ...c.query, source: SOURCE_ID };
    widgets[widgetId(c)] = { ...c.widget } as DashboardInput['widgets'][string];
  }
  const queryIds = Object.keys(queries);
  const params: Record<string, { type: string; [k: string]: unknown }> = {};
  if (input.timeField && queryIds.length) {
    params.dateRange = { type: 'daterange', label: 'Date range', field: input.timeField, default: 'all', bind: queryIds.map((q) => `${q}.filters`) };
  }
  return {
    specVersion: requiredSpecVersion(widgets as Record<string, { type: string }>),
    id: input.id ?? 'dash_suggested',
    title: (input.title?.trim() || `${cap(input.sourceName.replace(/\.(csv|xlsx)$/i, '').replace(/[_-]+/g, ' ').trim())} overview`).slice(0, 200),
    ...(input.description ? { description: input.description.slice(0, 2000) } : {}),
    dataSources: { [SOURCE_ID]: { type: input.source.type, ref: input.source.ref } },
    queries,
    widgets,
    layout: layout(chosen),
    params,
  };
}

/** Builds the starter dashboard. Drops any widget the validator rejects, so the result is always valid. */
export function assembleDashboard(input: AssembleInput): { dashboard: DashboardInput; used: Candidate[]; dropped: string[] } {
  let chosen = selectCandidates(input.candidates);
  const dropped: string[] = [];
  for (let attempt = 0; attempt <= MAX_WIDGETS; attempt++) {
    const dashboard = build(input, chosen);
    const result = validateDashboard(dashboard, { allowNewerMinor: false });
    if (result.ok) return { dashboard, used: chosen, dropped };
    // Map error paths ("widgets.w_x…", "queries.q_x…") back to candidates and drop them.
    const bad = new Set<string>();
    for (const e of result.errors) {
      const [kind, id] = e.path.split('.');
      for (const c of chosen) {
        if ((kind === 'widgets' && id === widgetId(c)) || (kind === 'queries' && id === queryKey(c))) bad.add(c.id);
      }
    }
    if (!bad.size) {
      // Not attributable to one widget (e.g. the param): retry without the date-range control.
      if (input.timeField) {
        input = { ...input, timeField: undefined };
        continue;
      }
      throw new Error(`assembled dashboard does not validate: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    }
    dropped.push(...[...bad]);
    chosen = chosen.filter((c) => !bad.has(c.id));
  }
  throw new Error('assembled dashboard does not validate');
}
