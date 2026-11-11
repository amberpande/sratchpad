/**
 * The dashboard store keeps every saved version of a dashboard's JSON. Saving never mutates
 * a version; it appends the next one, so host apps can pin a version and authors can roll back.
 */

export interface DashboardRecord {
  teamId: string;
  id: string;
  version: number;
  title: string;
  specVersion: string;
  /** The document exactly as the author saved it. */
  spec: unknown;
  createdBy: string;
  createdAt: string;
}

export interface DashboardSummary {
  id: string;
  title: string;
  latestVersion: number;
  updatedAt: string;
}

export interface VersionSummary {
  version: number;
  title: string;
  specVersion: string;
  createdBy: string;
  createdAt: string;
}

export interface SaveInput {
  teamId: string;
  id: string;
  title: string;
  specVersion: string;
  spec: unknown;
  createdBy: string;
  /** Optimistic concurrency: the version the edit was based on (0 = must not exist yet). */
  expectedVersion?: number;
}

export interface DashboardStore {
  get(teamId: string, id: string, version?: number): Promise<DashboardRecord | null>;
  list(teamId: string): Promise<DashboardSummary[]>;
  listVersions(teamId: string, id: string): Promise<VersionSummary[]>;
  /** Appends a version. Throws VersionConflictError when expectedVersion is stale. */
  save(input: SaveInput): Promise<DashboardRecord>;
  close?(): Promise<void>;
}
