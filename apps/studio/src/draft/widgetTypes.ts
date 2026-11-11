import { WIDGET_TYPES, type WidgetTypeDefinition } from '@yourorg/bi-spec';
import type { ZodTypeAny } from 'zod';

/**
 * Reads the widget registry (WIDGET_TYPES) so authoring never hard-codes the catalog: a type added
 * in a later spec minor shows up in the palette and gets a generic inspector automatically.
 *
 * Field slots (encoding/options that name a query output column) are discovered by probing the
 * type's own `fieldRefs` with sentinel values, so the registry stays the single source of truth.
 */

export type SlotRole = 'dimension' | 'measure' | 'any';

export interface FieldSlot {
  container: 'encoding' | 'options';
  key: string;
  /** Accepts several columns (e.g. several y series). */
  multiple: boolean;
  /** A list of column objects ({ field, label?, format? }), like table columns. */
  columns: boolean;
  required: boolean;
  role: SlotRole;
}

export type OptionControl =
  | { key: string; kind: 'text'; required: boolean }
  | { key: string; kind: 'number'; required: boolean; min?: number; max?: number; defaultValue?: number }
  | { key: string; kind: 'boolean'; required: boolean; defaultValue?: boolean }
  | { key: string; kind: 'enum'; required: boolean; values: string[]; defaultValue?: string }
  | { key: string; kind: 'enumObject'; required: boolean; fields: Array<{ key: string; values: string[] }> }
  | { key: string; kind: 'json'; required: boolean };

export interface WidgetTypeInfo {
  type: string;
  since: string;
  label: string;
  /** False for static widgets (e.g. text) that run no query. */
  needsQuery: boolean;
  /** Optional fields added after `since`, by path: { "encoding.series": "1.1" }. */
  fieldsSince: Record<string, string>;
  slots: FieldSlot[];
  options: OptionControl[];
}

const DIMENSION_KEYS = new Set(['x', 'category', 'label', 'group', 'groupby', 'series', 'color', 'dimension', 'row', 'rows', 'column', 'name', 'stage']);

interface ZodDefLike {
  typeName?: string;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  defaultValue?: () => unknown;
  values?: readonly string[] | Record<string, string>;
  options?: ZodTypeAny[];
  type?: ZodTypeAny;
  checks?: Array<{ kind: string; value?: number }>;
  shape?: () => Record<string, ZodTypeAny>;
}

const def = (s: ZodTypeAny): ZodDefLike => (s as unknown as { _def: ZodDefLike })._def;

interface Unwrapped {
  schema: ZodTypeAny;
  optional: boolean;
  defaultValue?: unknown;
}

function unwrap(schema: ZodTypeAny): Unwrapped {
  let s = schema;
  let optional = false;
  let defaultValue: unknown;
  for (let i = 0; i < 10; i++) {
    const d = def(s);
    if (d.typeName === 'ZodOptional' || d.typeName === 'ZodNullable') {
      optional = true;
      s = d.innerType!;
    } else if (d.typeName === 'ZodDefault') {
      optional = true;
      defaultValue = d.defaultValue?.();
      s = d.innerType!;
    } else if (d.typeName === 'ZodEffects') {
      s = d.schema!;
    } else break;
  }
  return { schema: s, optional, defaultValue };
}

function shapeOf(schema: ZodTypeAny | undefined): Record<string, ZodTypeAny> {
  if (!schema) return {};
  const s = unwrap(schema).schema;
  const d = def(s);
  if (d.typeName !== 'ZodObject') return {};
  const shape = (s as unknown as { shape?: Record<string, ZodTypeAny> }).shape;
  return shape ?? d.shape?.() ?? {};
}

function enumValues(s: ZodTypeAny): string[] | null {
  const d = def(s);
  if (d.typeName === 'ZodEnum') return [...(d.values as readonly string[])];
  if (d.typeName === 'ZodNativeEnum') return Object.values(d.values as Record<string, string>).filter((v) => typeof v === 'string');
  if (d.typeName === 'ZodLiteral') return null;
  return null;
}

function isStringLike(s: ZodTypeAny): boolean {
  const u = unwrap(s).schema;
  const d = def(u);
  if (d.typeName === 'ZodString') return true;
  if (d.typeName === 'ZodUnion') return (d.options ?? []).some((o) => isStringLike(o));
  return false;
}

function acceptsArray(s: ZodTypeAny): boolean {
  const u = unwrap(s).schema;
  const d = def(u);
  if (d.typeName === 'ZodArray') return true;
  if (d.typeName === 'ZodUnion') return (d.options ?? []).some((o) => acceptsArray(o));
  return false;
}

function arrayOfFieldObjects(s: ZodTypeAny): boolean {
  const u = unwrap(s).schema;
  const d = def(u);
  return d.typeName === 'ZodArray' && d.type !== undefined && 'field' in shapeOf(d.type);
}

const probeValue = (key: string) => `__probe__${key}`;

/**
 * Spec 1.3 option lists whose items name a column but are settings, not column pickers (they get
 * their own editors in the inspector), so they never become "columns" slots.
 */
const NOT_SLOTS = new Set(['referenceLines', 'referenceBands', 'annotations', 'conditionalFormats', 'thresholds']);

/**
 * Slots the spec marks optional because they depend on another option, but which the Studio fills for
 * the default setting (a map is a choropleth unless set to symbol, which needs region + value).
 */
const STUDIO_REQUIRED: Record<string, string[]> = { map: ['region', 'value'], bullet: ['category'] };

function probeSlots(definition: WidgetTypeDefinition, type = ''): FieldSlot[] {
  const encodingShape = shapeOf(definition.encoding);
  const optionShape = shapeOf(definition.options);
  const encoding: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(encodingShape)) if (isStringLike(s) || acceptsArray(s)) encoding[key] = probeValue(key);
  for (const [key, s] of Object.entries(optionShape)) {
    const u = unwrap(s).schema;
    if (NOT_SLOTS.has(key)) continue;
    if (arrayOfFieldObjects(s)) options[key] = [{ field: probeValue(key) }];
    else if (isStringLike(u) && !enumValues(u)) options[key] = probeValue(key);
  }
  let refs: Array<{ path: string; field: string }> = [];
  try {
    refs = definition.fieldRefs({ encoding: definition.encoding ? encoding : undefined, options });
  } catch {
    refs = [];
  }
  const slots: FieldSlot[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const [container, key] = ref.path.split('.') as ['encoding' | 'options', string];
    if ((container !== 'encoding' && container !== 'options') || !key || seen.has(`${container}.${key}`)) continue;
    seen.add(`${container}.${key}`);
    const schema = (container === 'encoding' ? encodingShape : optionShape)[key];
    if (!schema) continue;
    const columns = container === 'options' && arrayOfFieldObjects(schema);
    const lower = key.toLowerCase();
    slots.push({
      container,
      key,
      columns,
      multiple: columns || acceptsArray(schema),
      required: !unwrap(schema).optional || (STUDIO_REQUIRED[type] ?? []).includes(key),
      role: columns ? 'any' : DIMENSION_KEYS.has(lower) ? 'dimension' : 'measure',
    });
  }
  return slots;
}

/**
 * Which slots must hold a measure or a dimension, asked of the type's own `check` (if it has one):
 * feed it probe columns that all have one role and see which slots it rejects.
 */
function probeRoles(definition: WidgetTypeDefinition, slots: FieldSlot[]): FieldSlot[] {
  if (!definition.check || !slots.length) return slots;
  const encoding: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  for (const slot of slots) {
    const value = slot.columns ? [{ field: probeValue(slot.key) }] : probeValue(slot.key);
    (slot.container === 'encoding' ? encoding : options)[slot.key] = value;
  }
  const names = slots.map((s) => probeValue(s.key));
  const rejected = (role: 'dimension' | 'measure'): Set<string> => {
    try {
      const columns = names.map((name) => ({ name, role, field: name, ...(role === 'measure' ? { agg: 'sum' as const } : {}) }));
      const query = { source: 'probe', dimensions: [], measures: [], filters: [], orderBy: [], limit: 1000 };
      const issues = definition.check!({ encoding: definition.encoding ? encoding : undefined, options }, { columns, query });
      return new Set(issues.filter((i) => i.code === 'invalid_role').map((i) => i.path));
    } catch {
      return new Set();
    }
  };
  const needMeasure = rejected('dimension');
  const needDimension = rejected('measure');
  return slots.map((slot) => {
    const path = `${slot.container}.${slot.key}`;
    if (needMeasure.has(path)) return { ...slot, role: 'measure' };
    if (needDimension.has(path)) return { ...slot, role: 'dimension' };
    return slot;
  });
}

function optionControls(definition: WidgetTypeDefinition, slots: FieldSlot[]): OptionControl[] {
  const slotKeys = new Set(slots.filter((s) => s.container === 'options').map((s) => s.key));
  const controls: OptionControl[] = [];
  for (const [key, raw] of Object.entries(shapeOf(definition.options))) {
    if (slotKeys.has(key)) continue;
    const { schema, optional, defaultValue } = unwrap(raw);
    const required = !optional;
    const d = def(schema);
    const values = enumValues(schema);
    if (values) controls.push({ key, kind: 'enum', required, values, defaultValue: defaultValue as string | undefined });
    else if (d.typeName === 'ZodString') controls.push({ key, kind: 'text', required });
    else if (d.typeName === 'ZodBoolean') controls.push({ key, kind: 'boolean', required, defaultValue: defaultValue as boolean | undefined });
    else if (d.typeName === 'ZodNumber') {
      const checks = d.checks ?? [];
      controls.push({
        key,
        kind: 'number',
        required,
        min: checks.find((c) => c.kind === 'min')?.value,
        max: checks.find((c) => c.kind === 'max')?.value,
        defaultValue: defaultValue as number | undefined,
      });
    } else if (d.typeName === 'ZodObject') {
      const fields = Object.entries(shapeOf(schema)).map(([k, s]) => ({ key: k, values: enumValues(unwrap(s).schema) }));
      if (fields.length && fields.every((f) => f.values)) {
        controls.push({ key, kind: 'enumObject', required, fields: fields.map((f) => ({ key: f.key, values: f.values! })) });
      } else controls.push({ key, kind: 'json', required });
    } else controls.push({ key, kind: 'json', required });
  }
  // Title first: it is the one every widget has.
  return controls.sort((a, b) => (a.key === 'title' ? -1 : b.key === 'title' ? 1 : 0));
}

export function humanizeType(type: string): string {
  const spaced = type.replace(/[-_]+/g, ' ').trim();
  if (spaced.toLowerCase() === 'kpi') return 'KPI';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const cache = new Map<string, WidgetTypeInfo>();

export function widgetTypeInfo(type: string): WidgetTypeInfo | undefined {
  const definition = (WIDGET_TYPES as Record<string, WidgetTypeDefinition | undefined>)[type];
  if (!definition) return undefined;
  let info = cache.get(type);
  if (!info) {
    const slots = probeRoles(definition, probeSlots(definition, type));
    info = {
      type,
      since: definition.since,
      label: humanizeType(type),
      needsQuery: definition.query !== 'none',
      fieldsSince: definition.fieldsSince ?? {},
      slots,
      options: optionControls(definition, slots),
    };
    cache.set(type, info);
  }
  return info;
}

/** Every widget type this build of the spec knows, in registry order. */
export function widgetTypes(): WidgetTypeInfo[] {
  return Object.keys(WIDGET_TYPES)
    .map((t) => widgetTypeInfo(t))
    .filter((i): i is WidgetTypeInfo => Boolean(i));
}

/** Values for required options that have no default, so a new widget starts valid. */
export function requiredOptionDefaults(info: WidgetTypeInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of info.options) {
    if (!c.required) continue;
    if (c.kind === 'text') out[c.key] = c.key === 'text' ? 'Write something here.' : humanizeType(c.key);
    else if (c.kind === 'enum' && c.defaultValue === undefined) out[c.key] = c.values[0];
    else if (c.kind === 'number' && c.defaultValue === undefined) out[c.key] = c.min ?? 1;
    else if (c.kind === 'boolean' && c.defaultValue === undefined) out[c.key] = false;
  }
  return out;
}

/** Default grid size for a new widget of a type. */
export function defaultSize(type: string): { w: number; h: number } {
  const info = widgetTypeInfo(type);
  if (info && !info.needsQuery) return { w: 4, h: 3 };
  if (type === 'kpi' || (info && info.slots.length === 1 && !info.slots[0]!.multiple && info.slots[0]!.role === 'measure')) return { w: 3, h: 2 };
  if (type === 'table' || info?.slots.some((s) => s.columns)) return { w: 12, h: 4 };
  return { w: 6, h: 4 };
}
