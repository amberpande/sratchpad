import { SPEC_VERSION } from '@yourorg/bi-spec';
import type { DraftSpec } from './types';

/**
 * Two-way JSON: the raw view and the canvas edit the same document. Parsing only checks the
 * top-level shape the editor needs to walk the document; everything deeper is reported by
 * validateDashboard, inline, like any other mistake.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type CoerceResult = { ok: true; draft: DraftSpec } | { ok: false; message: string };

export function coerceDraft(value: unknown): CoerceResult {
  if (!isRecord(value)) return { ok: false, message: 'The document must be a JSON object.' };
  for (const key of ['dataSources', 'queries', 'widgets'] as const) {
    if (value[key] !== undefined && !isRecord(value[key])) return { ok: false, message: `"${key}" must be an object.` };
    for (const [id, entry] of Object.entries((value[key] as Record<string, unknown> | undefined) ?? {})) {
      if (!isRecord(entry)) return { ok: false, message: `"${key}.${id}" must be an object.` };
    }
  }
  if (value.params !== undefined && !isRecord(value.params)) return { ok: false, message: '"params" must be an object.' };
  if (value.layout !== undefined && !Array.isArray(value.layout)) return { ok: false, message: '"layout" must be an array.' };
  if (Array.isArray(value.layout) && value.layout.some((it) => !isRecord(it))) return { ok: false, message: 'Every layout entry must be an object.' };
  for (const [id, q] of Object.entries((value.queries as Record<string, Record<string, unknown>> | undefined) ?? {})) {
    for (const list of ['dimensions', 'measures', 'filters', 'orderBy']) {
      const v = q[list];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => !isRecord(x)))) return { ok: false, message: `"queries.${id}.${list}" must be an array of objects.` };
    }
  }
  return {
    ok: true,
    draft: {
      ...(value as object),
      specVersion: typeof value.specVersion === 'string' ? value.specVersion : (value.specVersion as string),
      id: value.id as string,
      title: value.title as string,
      dataSources: (value.dataSources ?? {}) as DraftSpec['dataSources'],
      queries: (value.queries ?? {}) as DraftSpec['queries'],
      widgets: (value.widgets ?? {}) as DraftSpec['widgets'],
      layout: (value.layout ?? []) as DraftSpec['layout'],
      params: (value.params ?? {}) as DraftSpec['params'],
    },
  };
}

export function parseDraftJson(text: string): CoerceResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `Not valid JSON: ${(error as Error).message}` };
  }
  return coerceDraft(value);
}

export function draftToJson(draft: DraftSpec): string {
  return JSON.stringify(draft, null, 2);
}

export function emptyDraft(id: string, title: string): DraftSpec {
  return { specVersion: SPEC_VERSION, id, title, dataSources: {}, queries: {}, widgets: {}, layout: [], params: {} };
}
