import type { TimeGrain } from './schema';

/** Wire types shared by the backend and the renderer SDK. */

export type ColumnType = 'string' | 'number' | 'time' | 'boolean';
export type Cell = string | number | boolean | null;

export interface ResultColumn {
  name: string;
  type: ColumnType;
  grain?: TimeGrain;
}

/** A small, already-aggregated result set. The browser never aggregates. */
export interface QueryResult {
  columns: ResultColumn[];
  rows: Array<Record<string, Cell>>;
  /** True when the query's limit cut rows off. */
  truncated: boolean;
  /** When the data was read from the source (ISO 8601). Older servers omit it. */
  asOf?: string;
  /** True when served from the backend's result cache rather than a fresh query. */
  cached?: boolean;
}

/** GET /v1/dashboards/:id */
export interface StoredDashboard {
  id: string;
  version: number;
  title: string;
  specVersion: string;
  createdAt: string;
  createdBy: string;
  spec: unknown;
}

/** POST /v1/dashboards/:id/data — one batched round-trip per dashboard load. */
export interface DataRequestBody {
  /** Pin to the version the renderer loaded. Defaults to the latest. */
  version?: number;
  queries: string[];
  params?: Record<string, unknown>;
}

/** The data endpoint streams one NDJSON line per query, in completion order. */
export type DataResponseLine =
  | { id: string; ok: true; result: QueryResult; ms?: number }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';
