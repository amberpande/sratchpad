import type { SourceProfile, SourceSummary, UploadResponse } from '@yourorg/bi-spec';

/**
 * The source catalog behind GET /v1/sources and GET /v1/sources/profile. Each source type has a
 * provider; every call is scoped to the caller's team, and "not visible to this team" is the same
 * answer as "does not exist" (null), so refs never leak across teams.
 */
export interface SourceProvider {
  readonly type: string;
  /** `refresh` skips cached listings (the Studio's refresh button). */
  list(teamId: string, options?: { refresh?: boolean }): Promise<SourceSummary[]>;
  /** Null when the source does not exist or the team cannot see it. */
  profile(teamId: string, ref: string): Promise<SourceProfile | null>;
}

export interface UploadInput {
  teamId: string;
  subject: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface FileUploader {
  readonly maxBytes: number;
  upload(input: UploadInput): Promise<UploadResponse>;
}

export interface SourceCatalog {
  providers: SourceProvider[];
  uploads?: FileUploader;
}
