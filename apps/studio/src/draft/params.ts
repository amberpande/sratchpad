import { bindQueryId } from '@yourorg/bi-spec';
import { normalizeQuery } from './query';
import type { DraftSpec, FieldInfo, ParamDraft } from './types';

export const bindTarget = (queryId: string) => `${queryId}.filters`;

export function boundQueries(param: ParamDraft): string[] {
  return (Array.isArray(param.bind) ? param.bind : []).map(bindQueryId);
}

/**
 * Queries a date-range param can filter: those with a time dimension, plus (when the param names a
 * date column) those whose source has that column.
 */
export function bindableQueries(draft: DraftSpec, field: string | undefined, fieldsBySourceId: Record<string, FieldInfo[] | undefined>): string[] {
  return Object.entries(draft.queries)
    .filter(([, q]) => {
      const n = normalizeQuery(q);
      if (!field) return n.dimensions.some((d) => d.grain);
      if (n.dimensions.some((d) => d.field === field)) return true;
      return (fieldsBySourceId[n.source] ?? []).some((f) => f.name === field);
    })
    .map(([id]) => id);
}

/** The time column most queries use, as a default for a new date-range param. */
export function suggestDateField(draft: DraftSpec, fields: FieldInfo[]): string | undefined {
  const counts = new Map<string, number>();
  for (const q of Object.values(draft.queries)) {
    for (const d of normalizeQuery(q).dimensions) if (d.grain) counts.set(d.field, (counts.get(d.field) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? fields.find((f) => f.kind === 'time')?.name;
}

export function queriesWithParams(draft: DraftSpec, queryId: string): Array<[string, ParamDraft]> {
  return Object.entries(draft.params).filter(([, p]) => boundQueries(p).includes(queryId));
}
