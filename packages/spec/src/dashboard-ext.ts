import { z } from 'zod';
import { V13, type ExtContext } from './ext';
import type { DataSource, Filter, LayoutItem, Query, TimeGrain } from './schema';
import type { RenderableWidget } from './widgets';
import { EXTRA_PARAM_SCHEMAS } from './params-ext';

/**
 * OWNER: workstream B (interactivity). Dashboard-level additions in spec 1.3:
 *
 *   interactions  – { crossFilter: true }: clicking a mark in one widget filters the others.
 *   tabs          – [{ id, title }]; layout items carry `tab` (items without one go on the first tab).
 *   mobileLayout  – narrow-screen order / height / hide per widget, used when the grid stacks.
 *
 * Plus the server-side contract for cross-filters: a client may only send `in`/`eq` filters on
 * fields that are dimensions of some saved query reading the same source (the author-declared
 * surface), with bounded scalar values. See runtimeFilters().
 */

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const id = z.string().regex(idPattern, 'must start with a letter and use only letters, digits, "_" or "-" (max 64)');

export const InteractionsSchema = z.object({ crossFilter: z.boolean().optional() }).strict();
export const TabSchema = z.object({ id, title: z.string().min(1).max(80) }).strict();
export const MobileLayoutItemSchema = z
  .object({
    i: id,
    /** Position when stacked (lower first). Default: reading order. */
    order: z.number().int().min(0).max(1000).optional(),
    /** Height in grid rows when stacked. */
    h: z.number().int().min(1).max(48).optional(),
    /** Leave this widget out on narrow screens. */
    hide: z.boolean().optional(),
  })
  .strict();

export type InteractionsConfig = z.infer<typeof InteractionsSchema>;
export type DashboardTab = z.infer<typeof TabSchema>;
export type MobileLayoutItem = z.infer<typeof MobileLayoutItemSchema>;

export interface DashboardExtensionFields {
  /** Since 1.3. */
  interactions?: InteractionsConfig;
  /** Since 1.3. */
  tabs?: DashboardTab[];
  /** Since 1.3. */
  mobileLayout?: MobileLayoutItem[];
}

/** What runtimeFilters needs from a validated dashboard. */
export interface ValidDashboardLike {
  queries: Record<string, Query>;
  dataSources: Record<string, DataSource>;
  interactions?: InteractionsConfig;
  /** Drill levels of widgets are declared dimensions too. */
  widgets?: Record<string, unknown>;
}

export const DASHBOARD_EXTENSION_KEYS: readonly string[] = ['interactions', 'tabs', 'mobileLayout'];

function zodPath(base: string, path: (string | number)[]): string {
  return [base, ...path].join('.');
}

export function validateDashboardExtension(
  input: Record<string, unknown>,
  ctx: ExtContext & { widgets: Record<string, RenderableWidget>; queries: Record<string, Query>; layout: LayoutItem[] },
): DashboardExtensionFields {
  const out: DashboardExtensionFields = {};
  const parse = <T>(key: string, schema: z.ZodType<T>): T | undefined => {
    if (input[key] === undefined || !ctx.gate(key, V13)) return undefined;
    const result = schema.safeParse(input[key]);
    if (result.success) return result.data;
    for (const issue of result.error.issues) ctx.errors.push({ path: zodPath(key, issue.path), code: 'invalid_value', message: issue.message });
    return undefined;
  };
  const interactions = parse('interactions', InteractionsSchema);
  if (interactions) out.interactions = interactions;

  const tabs = parse('tabs', z.array(TabSchema).min(1).max(20));
  if (tabs) {
    const seen = new Set<string>();
    tabs.forEach((t, i) => {
      if (seen.has(t.id)) ctx.errors.push({ path: `tabs.${i}.id`, code: 'duplicate_id', message: `Tab "${t.id}" appears twice.` });
      seen.add(t.id);
    });
    out.tabs = tabs;
  }
  // `tab` on layout items: 1.3, and must name a tab.
  const rawLayout = Array.isArray(input.layout) ? (input.layout as unknown[]) : [];
  rawLayout.forEach((item, i) => {
    const tab = item && typeof item === 'object' ? (item as Record<string, unknown>).tab : undefined;
    if (tab === undefined) return;
    if (!ctx.gate(`layout.${i}.tab`, V13)) return;
    if (!tabs) ctx.errors.push({ path: `layout.${i}.tab`, code: 'unknown_reference', message: 'Layout items name a tab, but the dashboard defines no "tabs".' });
    else if (!tabs.some((t) => t.id === tab)) ctx.errors.push({ path: `layout.${i}.tab`, code: 'unknown_reference', message: `Tab "${String(tab)}" is not defined in tabs.` });
  });

  const mobile = parse('mobileLayout', z.array(MobileLayoutItemSchema).max(200));
  if (mobile) {
    mobile.forEach((m, i) => {
      if (!ctx.widgets[m.i]) ctx.errors.push({ path: `mobileLayout.${i}.i`, code: 'unknown_reference', message: `Widget "${m.i}" is not defined in widgets.` });
    });
    out.mobileLayout = mobile;
  }
  return out;
}

export function dashboardExtensionSince(doc: Record<string, unknown>): string | undefined {
  if (DASHBOARD_EXTENSION_KEYS.some((k) => doc[k] !== undefined)) return V13;
  if (Array.isArray(doc.layout) && doc.layout.some((it) => it && typeof it === 'object' && (it as Record<string, unknown>).tab !== undefined)) return V13;
  const params = doc.params && typeof doc.params === 'object' ? Object.values(doc.params as Record<string, unknown>) : [];
  if (params.some((p) => p && typeof p === 'object' && Object.hasOwn(EXTRA_PARAM_SCHEMAS, String((p as Record<string, unknown>).type)))) return V13;
  return undefined;
}

/** The tab a layout item belongs to (items without one go on the first tab). */
export function layoutItemTab(item: LayoutItem & { tab?: string }, tabs: DashboardTab[] | undefined): string | undefined {
  if (!tabs?.length) return undefined;
  return item.tab ?? tabs[0]!.id;
}

// ── cross-filter runtime filters (server contract) ────────────────────────────

/** A cross-filter as clients send it with a data request. */
export interface RuntimeFilter {
  field: string;
  /** Since 1.4: 'between' with a grain = every bucket from values[0] through values[1] (a brushed range). */
  op: 'in' | 'eq' | 'between';
  values: Array<string | number | boolean>;
  /** For a time dimension: the clicked value is a bucket start ("YYYY-MM-DD") of this grain. */
  grain?: TimeGrain;
}

export const MAX_RUNTIME_FILTERS = 10;
export const MAX_RUNTIME_VALUES = 100;
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];

function sameSource(a: { type: string; ref: string } | undefined, b: { type: string; ref: string } | undefined) {
  return !!a && !!b && a.type === b.type && a.ref === b.ref;
}

/**
 * The fields a query may be cross-filtered on: the dimension fields (source columns) of every saved
 * query in the dashboard that reads the same source, and the drill levels of widgets on such queries,
 * with the grains they use.
 */
export function crossFilterFields(dashboard: ValidDashboardLike, queryId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const q = dashboard.queries[queryId];
  if (!q) return out;
  const source = dashboard.dataSources[q.source];
  const add = (field: string, grain?: string) => {
    const grains = out.get(field) ?? new Set<string>();
    if (grain) grains.add(grain);
    out.set(field, grains);
  };
  // Custom SQL (1.4): only its own declared dimension columns, which is what its outer WHERE can filter.
  if (typeof (q as { sql?: unknown }).sql === 'string') {
    for (const c of (q as { columns?: Array<{ name: string; role: string }> }).columns ?? []) if (c.role === 'dimension') add(c.name);
    return out;
  }
  for (const other of Object.values(dashboard.queries)) {
    if (!sameSource(dashboard.dataSources[other.source], source)) continue;
    for (const d of other.dimensions) add(d.field, d.grain);
  }
  for (const w of Object.values(dashboard.widgets ?? {})) {
    const widget = w as { query?: string; drill?: { levels?: Array<{ field: string; grain?: string }> } };
    const wq = widget.query ? dashboard.queries[widget.query] : undefined;
    if (!wq || !widget.drill?.levels || !sameSource(dashboard.dataSources[wq.source], source)) continue;
    for (const lvl of widget.drill.levels) add(lvl.field, lvl.grain);
  }
  return out;
}

/** Start of the next bucket after `start` (a "YYYY-MM-DD" bucket start of `grain`). */
export function nextBucket(start: string, grain: TimeGrain): string {
  const d = new Date(`${start}T00:00:00Z`);
  switch (grain) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'month':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarter':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

/** Filters selecting one time bucket. */
export function bucketFilters(field: string, start: string, grain: TimeGrain): Filter[] {
  return [
    { field, op: 'gte', value: start },
    { field, op: 'lt', value: nextBucket(start, grain) },
  ];
}

export type RuntimeFiltersResult = { ok: true; filters: Filter[] } | { ok: false; message: string };

/**
 * Validates client-sent cross-filters for one query and turns them into query filters. Requires the
 * dashboard to enable cross-filtering. Never trusts the client beyond the author-declared surface.
 */
export function runtimeFilters(dashboard: ValidDashboardLike, queryId: string, raw: unknown): RuntimeFiltersResult {
  if (raw === undefined) return { ok: true, filters: [] };
  if (!dashboard.interactions?.crossFilter) return { ok: false, message: 'This dashboard does not enable cross-filtering.' };
  if (!Array.isArray(raw) || raw.length > MAX_RUNTIME_FILTERS) return { ok: false, message: `"filters" must be a list of at most ${MAX_RUNTIME_FILTERS}.` };
  const allowed = crossFilterFields(dashboard, queryId);
  const filters: Filter[] = [];
  for (const f of raw as unknown[]) {
    if (!f || typeof f !== 'object') return { ok: false, message: 'Each filter must be an object.' };
    const { field, op, values, grain } = f as Record<string, unknown>;
    if (typeof field !== 'string' || !allowed.has(field)) {
      return { ok: false, message: `Cross-filters may only use dimensions of this dashboard's queries on the same source${typeof field === 'string' ? ` ("${field}" is not one)` : ''}.` };
    }
    if (op !== 'in' && op !== 'eq' && op !== 'between') return { ok: false, message: 'Cross-filter op must be "in", "eq" or "between".' };
    if (op === 'between') {
      // A brushed time range (1.4, D-090): two bucket starts, both included.
      const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
      if (typeof grain !== 'string' || !GRAINS.includes(grain) || !allowed.get(field)!.has(grain)) return { ok: false, message: '"between" needs a time grain this dashboard uses for the field.' };
      if (!Array.isArray(values) || values.length !== 2 || !iso(values[0]) || !iso(values[1]) || values[0] > values[1]) return { ok: false, message: '"between" takes two "YYYY-MM-DD" bucket starts, in order.' };
      filters.push({ field, op: 'gte', value: values[0] }, { field, op: 'lt', value: nextBucket(values[1], grain as TimeGrain) });
      continue;
    }
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_RUNTIME_VALUES) {
      return { ok: false, message: `Cross-filter values must be a list of 1–${MAX_RUNTIME_VALUES}.` };
    }
    const scalarOk = (v: unknown) => (typeof v === 'string' && v.length <= 500) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
    if (!values.every(scalarOk)) return { ok: false, message: 'Cross-filter values must be strings (max 500), numbers or booleans.' };
    if (op === 'eq' && values.length !== 1) return { ok: false, message: '"eq" takes exactly one value.' };
    if (grain !== undefined) {
      if (typeof grain !== 'string' || !GRAINS.includes(grain) || !allowed.get(field)!.has(grain)) {
        return { ok: false, message: `"${field}" is not used with grain "${String(grain)}" in this dashboard.` };
      }
      if (values.length !== 1 || typeof values[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(values[0])) {
        return { ok: false, message: 'A time-bucket cross-filter takes one "YYYY-MM-DD" bucket start.' };
      }
      filters.push(...bucketFilters(field, values[0], grain as TimeGrain));
      continue;
    }
    filters.push(op === 'eq' ? { field, op: 'eq', value: values[0] as string | number | boolean } : { field, op: 'in', value: values as Array<string | number | boolean> });
  }
  return { ok: true, filters };
}
