import type { ColumnProfile, DataSource, SourceProfile, SourceSummary } from '@yourorg/bi-spec';
import { normalizeQuery } from './query';
import type { DraftSpec, FieldInfo, FieldKind } from './types';

export const sourceKey = (s: DataSource) => `${s.type}:${s.ref}`;

export function fieldKind(col: ColumnProfile): FieldKind {
  if (col.role === 'time' || col.semanticType === 'temporal') return 'time';
  if (col.role === 'measure') return 'measure';
  return 'dimension';
}

export function profileFields(profile: SourceProfile): FieldInfo[] {
  return profile.columns.map((c) => ({
    name: c.name,
    kind: fieldKind(c),
    semanticType: c.semanticType,
    ...(c.role === 'key' || c.role === 'ignore' ? { secondary: true } : {}),
    ...(c.format ? { format: c.format } : {}),
  }));
}

export interface FieldGroups {
  time: FieldInfo[];
  measures: FieldInfo[];
  dimensions: FieldInfo[];
}

export function groupFields(fields: FieldInfo[]): FieldGroups {
  return {
    time: fields.filter((f) => f.kind === 'time'),
    measures: fields.filter((f) => f.kind === 'measure'),
    dimensions: fields.filter((f) => f.kind === 'dimension'),
  };
}

/** The built-in sample dataset, used when the backend can't list sources yet (Phase 1 API). */
export const SAMPLE_ORDERS: SourceSummary = { source: { type: 'sample', ref: 'orders' }, name: 'Orders (sample)' };

/**
 * Field list for the sample `orders` dataset when GET /v1/sources/profile is unavailable.
 * Mirrors services/api/src/data/sample/orders.ts.
 */
export const SAMPLE_ORDERS_FIELDS: FieldInfo[] = [
  { name: 'order_date', kind: 'time', semanticType: 'temporal', format: 'date' },
  { name: 'amount', kind: 'measure', semanticType: 'numeric', format: 'currency' },
  { name: 'quantity', kind: 'measure', semanticType: 'numeric', format: 'integer' },
  { name: 'region', kind: 'dimension', semanticType: 'categorical' },
  { name: 'category', kind: 'dimension', semanticType: 'categorical' },
  { name: 'channel', kind: 'dimension', semanticType: 'categorical' },
  { name: 'status', kind: 'dimension', semanticType: 'categorical' },
  { name: 'order_id', kind: 'dimension', semanticType: 'id', secondary: true },
  { name: 'customer_id', kind: 'dimension', semanticType: 'id', secondary: true },
];

/**
 * Fields the draft already uses for a data source, with kinds guessed from usage. Fills the field
 * panel for sources the backend can't profile.
 */
export function fieldsFromDraft(draft: DraftSpec, sourceId: string): FieldInfo[] {
  const fields = new Map<string, FieldInfo>();
  for (const q of Object.values(draft.queries)) {
    const n = normalizeQuery(q);
    if (n.source !== sourceId) continue;
    for (const d of n.dimensions) if (!fields.has(d.field)) fields.set(d.field, { name: d.field, kind: d.grain ? 'time' : 'dimension', semanticType: d.grain ? 'temporal' : 'categorical' });
    for (const m of n.measures) {
      if (m.field === '*' || fields.has(m.field)) continue;
      const numeric = m.agg === 'sum' || m.agg === 'avg' || m.agg === 'min' || m.agg === 'max';
      fields.set(m.field, { name: m.field, kind: numeric ? 'measure' : 'dimension', semanticType: numeric ? 'numeric' : 'id', ...(numeric ? {} : { secondary: true }) });
    }
  }
  return [...fields.values()];
}

export function mergeFields(primary: FieldInfo[], extra: FieldInfo[]): FieldInfo[] {
  const names = new Set(primary.map((f) => f.name));
  return [...primary, ...extra.filter((f) => !names.has(f.name))];
}
