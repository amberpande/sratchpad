/**
 * Sharing contracts. An editor shares a saved dashboard with read-only consumers:
 *
 *   audience "app"    – an independent application reads the dashboard JSON (and its data) through
 *                       the API with the share token, and renders or parses it however it likes.
 *   audience "viewer" – business users open the hosted viewer link and just look at the dashboard.
 *
 * Both are read-only and scoped to one dashboard: the token can fetch that dashboard's JSON and run
 * its saved queries, nothing else. Tokens are shown once at creation; the server stores a hash.
 */

export type ShareAudience = 'app' | 'viewer';
export const SHARE_AUDIENCES: readonly ShareAudience[] = ['app', 'viewer'];
/** Every share token starts with this, so gateways and secret scanners can recognise it. */
export const SHARE_TOKEN_PREFIX = 'bis_';

export interface Share {
  id: string;
  dashboardId: string;
  audience: ShareAudience;
  label: string;
  /** Pinned version; absent = always the latest saved version. */
  version?: number;
  createdBy: string;
  createdAt: string;
  /** Absent = never expires. */
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

/** POST /v1/dashboards/:id/shares */
export interface CreateShareBody {
  audience: ShareAudience;
  label?: string;
  /** Pin a saved version; omit to follow the latest. */
  version?: number;
  /** 1–365; omit for no expiry. */
  expiresInDays?: number;
}

export interface CreateShareResponse {
  share: Share;
  /** The secret. Returned only here; store it, it cannot be shown again. */
  token: string;
  /** For audience "viewer" (when the server knows the viewer's URL): the link to send. */
  viewerUrl?: string;
}

/** GET /v1/share, called with a share token: what this token grants. */
export interface ShareIntrospection {
  share: Pick<Share, 'id' | 'dashboardId' | 'audience' | 'label' | 'version' | 'expiresAt'>;
  dashboard: { id: string; title: string; latestVersion: number };
}
