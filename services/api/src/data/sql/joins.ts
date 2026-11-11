import type { DataSource, Join, Query } from '@yourorg/bi-spec';
import { EngineError } from '../engine';

/**
 * Spec 1.3 joins name other entries of the dashboard's `dataSources` by id. Engines only receive
 * the query's own source, so the caller (data/run.ts) attaches each joined source's {type, ref}
 * before executing. Engines re-check team visibility of every attached source exactly like the
 * primary source, so an attached ref grants nothing by itself.
 */
export type ResolvedJoin = Join & { resolved?: DataSource };

export function attachJoinSources(query: Query, dataSources: Record<string, DataSource>): Query {
  if (!query.joins?.length) return query;
  return {
    ...query,
    joins: query.joins.map((j) => {
      const ds = Object.hasOwn(dataSources, j.source) ? dataSources[j.source] : undefined;
      return ds ? ({ ...j, resolved: { type: ds.type, ref: ds.ref } } as ResolvedJoin) : j;
    }),
  };
}

/** The attached sources of a query's joins; every join must be resolved and of the primary's type. */
export function joinedSources(query: Query, primary: DataSource): Array<{ id: string; source: DataSource }> {
  return ((query.joins ?? []) as ResolvedJoin[]).map((j, k) => {
    if (!j.resolved) throw new EngineError('unknown_source', `joins[${k}]: data source "${j.source}" is not defined in the dashboard.`);
    if (j.resolved.type !== primary.type) {
      throw new EngineError('invalid_join', `joins[${k}]: "${j.source}" is a ${j.resolved.type} source; joins work between sources of the same type (${primary.type}).`);
    }
    return { id: j.source, source: j.resolved };
  });
}
