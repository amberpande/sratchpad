import { z } from 'zod';
import { V13, type ExtContext } from './ext';
import type { Filter, Query, TimeGrain } from './schema';
import { bucketFilters } from './dashboard-ext';

/**
 * OWNER: workstream B (interactivity). Widget-level additions in spec 1.3, valid on every type:
 *
 *   drill         – { levels: [{ field, grain?, label? }, …] }: clicking a mark goes one level down
 *                   (the first dimension is replaced by the next level, filtered to the clicked
 *                   value); a breadcrumb goes back up. levels[0] must be the query's first dimension.
 *   drillThrough  – { dashboardId, params?: { targetParam: sourceField } }: clicking a mark asks the
 *                   host to open another dashboard (`onNavigate`), passing the clicked value.
 *   interactions  – { crossFilter: false } opts this widget out of dashboard cross-filtering.
 *
 * The server derives drill variants only from the saved levels (drillQuery): the client sends a
 * level index and the clicked path values, never a query.
 */

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const field = z.string().min(1).max(128);
const GRAIN = z.enum(['day', 'week', 'month', 'quarter', 'year']);

export const DrillLevelSchema = z.object({ field, grain: GRAIN.optional(), label: z.string().max(80).optional() }).strict();
export const DrillSchema = z
  .object({
    levels: z.array(DrillLevelSchema).min(2).max(6),
    /** Since 1.4: which query dimension drills (0 = the first, the x axis; 1 = typically the series) (D-088). */
    dimension: z.number().int().min(0).max(7).optional(),
  })
  .strict();
export const DrillThroughSchema = z
  .object({
    dashboardId: z.string().regex(idPattern),
    /** Target dashboard param ← result column of the clicked mark. */
    params: z.record(z.string().regex(idPattern), field).optional(),
    label: z.string().max(80).optional(),
  })
  .strict();
export const WidgetInteractionsSchema = z.object({ crossFilter: z.boolean().optional() }).strict();
/**
 * Since 1.4 (D-089): show the widget only when the control `param` has a value ("set"), has none
 * ("empty"), or holds one of `values` ("in"; a multiselect matches when any chosen value is listed).
 */
export const VisibleWhenSchema = z
  .object({
    param: z.string().regex(idPattern),
    is: z.enum(['set', 'empty', 'in']).default('set'),
    values: z.array(z.union([z.string().max(500), z.number(), z.boolean()])).min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => (v.is === 'in') === (v.values !== undefined), { message: '"values" is required with is "in", and only then.' });
export type VisibleWhen = z.infer<typeof VisibleWhenSchema>;

/** Whether a widget with `visibleWhen` shows for the current param values. */
export function isWidgetVisible(rule: VisibleWhen | undefined, values: Record<string, unknown>): boolean {
  if (!rule) return true;
  const v = values[rule.param];
  const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && (v.length === 0 || v.every((x) => x === null))) || v === 'all';
  if (rule.is === 'set') return !empty;
  if (rule.is === 'empty') return empty;
  const chosen = Array.isArray(v) ? v : [v];
  return chosen.some((x) => rule.values!.includes(x as never));
}

export type DrillLevel = z.infer<typeof DrillLevelSchema>;
export type DrillConfig = z.infer<typeof DrillSchema>;
export type DrillThroughConfig = z.infer<typeof DrillThroughSchema>;

export interface WidgetExtensionFields {
  /** Since 1.3. */
  drill?: DrillConfig;
  /** Since 1.3. */
  drillThrough?: DrillThroughConfig;
  /** Since 1.3. */
  interactions?: { crossFilter?: boolean };
  /** Since 1.4. */
  visibleWhen?: VisibleWhen;
}

const KEYS = ['drill', 'drillThrough', 'interactions', 'visibleWhen'] as const;

/** Returns the parsed extension fields, or null when they are invalid (errors already recorded). */
export function validateWidgetExtension(
  raw: Record<string, unknown>,
  ctx: ExtContext & { base: string; queryId?: string; queries: Record<string, Query> },
): WidgetExtensionFields | null {
  const out: WidgetExtensionFields = {};
  let ok = true;
  const schemas = { drill: DrillSchema, drillThrough: DrillThroughSchema, interactions: WidgetInteractionsSchema, visibleWhen: VisibleWhenSchema };
  for (const key of KEYS) {
    if (raw[key] === undefined) continue;
    const path = `${ctx.base}.${key}`;
    if (!ctx.gate(path, key === 'visibleWhen' ? '1.4' : V13)) continue;
    const result = schemas[key].safeParse(raw[key]);
    if (!result.success) {
      ok = false;
      for (const issue of result.error.issues) ctx.errors.push({ path: [path, ...issue.path].join('.'), code: 'invalid_value', message: issue.message });
      continue;
    }
    (out as Record<string, unknown>)[key] = result.data;
  }
  if (out.drill) {
    const q = ctx.queryId ? ctx.queries[ctx.queryId] : undefined;
    const index = out.drill.dimension ?? 0;
    if (out.drill.dimension !== undefined) ctx.gate(`${ctx.base}.drill.dimension`, '1.4');
    const first = q?.dimensions[index];
    if (!ctx.queryId) {
      ctx.errors.push({ path: `${ctx.base}.drill`, code: 'invalid_value', message: 'Drill-down needs a widget with a query.' });
      ok = false;
    } else if (q && (!first || first.field !== out.drill.levels[0]!.field || (first.grain ?? undefined) !== out.drill.levels[0]!.grain)) {
      ctx.errors.push({
        path: `${ctx.base}.drill.levels.0`,
        code: 'invalid_value',
        message: `The first drill level must match the query's ${index === 0 ? 'first dimension' : `dimension ${index}`}${first ? ` (${first.field}${first.grain ? `, grain ${first.grain}` : ''})` : ''}.`,
      });
      ok = false;
    }
  }
  return ok ? out : null;
}

export function widgetExtensionSince(raw: Record<string, unknown>): string | undefined {
  if (raw.visibleWhen !== undefined || (raw.drill as { dimension?: unknown } | undefined)?.dimension !== undefined) return '1.4';
  return KEYS.some((k) => raw[k] !== undefined) ? V13 : undefined;
}

// ── drill variants (server contract) ─────────────────────────────────────────

export type DrillQueryResult = { ok: true; query: Query } | { ok: false; message: string };

/**
 * The query for drill level `level` (1..levels-1), given the values clicked at each level above it.
 * Only the saved levels decide what runs: the first dimension becomes levels[level] (keeping its
 * output name, so the widget's encoding still fits) and each path value becomes a filter.
 */
export function drillQuery(query: Query, drill: DrillConfig, level: unknown, path: unknown): DrillQueryResult {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level >= drill.levels.length) {
    return { ok: false, message: `Drill level must be 1–${drill.levels.length - 1}.` };
  }
  if (!Array.isArray(path) || path.length !== level) return { ok: false, message: `A drill to level ${level} needs ${level} clicked value(s).` };
  const index = drill.dimension ?? 0;
  const first = query.dimensions[index];
  if (!first) return { ok: false, message: 'This query has no dimension to drill.' };
  const alias = first.as ?? first.field;
  const filters: Filter[] = [];
  for (let j = 0; j < level; j++) {
    const lvl = drill.levels[j]!;
    const v = path[j];
    if (lvl.grain) {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, message: `Level ${j} is a time bucket: send its "YYYY-MM-DD" start.` };
      filters.push(...bucketFilters(lvl.field, v, lvl.grain as TimeGrain));
    } else {
      const okScalar = (typeof v === 'string' && v.length <= 500) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
      if (v === null) filters.push({ field: lvl.field, op: 'is_null' });
      else if (!okScalar) return { ok: false, message: 'Drill path values must be strings, numbers, booleans or null.' };
      else filters.push({ field: lvl.field, op: 'eq', value: v as string | number | boolean });
    }
  }
  const target = drill.levels[level]!;
  const dimension = { field: target.field, ...(target.grain ? { grain: target.grain } : {}), as: alias };
  const dimensions = query.dimensions.map((d, i) => (i === index ? dimension : d));
  return { ok: true, query: { ...query, dimensions, filters: [...query.filters, ...filters] } };
}
