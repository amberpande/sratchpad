import type { DashboardInput, DataSource, QueryInput } from './schema';
import type { Widget } from './widgets';
import type { Cell, ColumnType } from './wire';

/**
 * Contracts for Phases 2–4: data sources, the metadata profiler and AI recommendations.
 * The profiler runs once per source and feeds both the authoring UI (field panel) and the AI.
 * See docs/API.md for the routes that carry these types.
 */

export type SemanticType = 'numeric' | 'categorical' | 'temporal' | 'boolean' | 'id' | 'geo' | 'text';
/** How a column is best used when building charts. */
export type FieldRole = 'measure' | 'dimension' | 'time' | 'key' | 'ignore';
export type Cardinality = 'low' | 'medium' | 'high' | 'unique';
export type DetectedFormat = 'currency' | 'percent' | 'integer' | 'decimal' | 'date' | 'datetime';

export interface ColumnProfile {
  name: string;
  physicalType: ColumnType;
  semanticType: SemanticType;
  role: FieldRole;
  /** 0..1 */
  nullRate: number;
  distinctCount: number;
  cardinality: Cardinality;
  min?: Cell;
  max?: Cell;
  /** Up to 5 distinct non-null values. Never full rows. */
  sampleValues: Cell[];
  format?: DetectedFormat;
}

export interface SourceProfile {
  source: DataSource;
  rowCount: number;
  /** True when profiling sampled rather than scanned (Snowflake). */
  sampled: boolean;
  columns: ColumnProfile[];
  timeColumns: string[];
  measureCandidates: string[];
  dimensionCandidates: string[];
  keyCandidates: string[];
  profiledAt: string;
}

export interface SourceSummary {
  source: DataSource;
  /** Display name: file name, "DB.SCHEMA.TABLE", or the sample dataset name. */
  name: string;
  rowCount?: number;
  createdAt?: string;
}

/** POST /v1/sources/files response. */
export interface UploadResponse {
  summary: SourceSummary;
  profile: SourceProfile;
}

/** POST /v1/preview/data body: run queries of an UNSAVED draft (authoring preview). */
export interface PreviewRequestBody {
  spec: unknown;
  queries: string[];
  params?: Record<string, unknown>;
}

export interface Recommendation {
  id: string;
  title: string;
  /** One line, e.g. "Revenue trends monthly; show it first." */
  rationale: string;
  /** Analytic pattern that produced it, e.g. "measure_over_time". */
  pattern: string;
  query: QueryInput;
  /** Widget whose `query` field names the key under which `query` is placed in the dashboard. */
  widget: Widget;
  score: number;
}

/** POST /v1/recommendations body: { source }. */
export interface RecommendationResponse {
  source: DataSource;
  profile: SourceProfile;
  candidates: Recommendation[];
  /** A laid-out starter dashboard built from the top candidates. Always a valid spec. */
  dashboard: DashboardInput;
  /** "rules" when the LLM was unavailable or disabled: the system degrades, never blocks. */
  generatedBy: 'rules' | 'rules+llm';
  warnings: string[];
}
