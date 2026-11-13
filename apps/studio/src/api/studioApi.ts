import type {
  ApiErrorBody,
  DataResponseLine,
  QueryResult,
  CreateShareBody,
  CreateShareResponse,
  Share,
  DataSource,
  Issue,
  RecommendationResponse,
  SourceProfile,
  SourceSummary,
  StoredDashboard,
  UploadResponse,
} from '@yourorg/bi-spec';

export const API_URL = '/bi-api';
// Dev builds sign in as team-a automatically. Production builds have no built-in token: the Studio
// asks for an access token (until SSO replaces it), see SignIn in App.tsx.
export const TOKEN: string = import.meta.env.VITE_BI_TOKEN ?? (import.meta.env.DEV ? 'dev-token-team-a' : '');

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

export type SavedDashboard = StoredDashboard & { warnings?: Issue[] };

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantReply {
  reply: string;
  draft: unknown;
  changed: boolean;
  changes: string[];
  issues: Issue[];
}

// ── platform features (workstream D) ──

export interface PlatformStatus {
  me: { subject: string; teamId: string; role: 'editor' | 'viewer' };
  email: boolean;
  scheduler: boolean;
}

export interface DashboardComment {
  id: string;
  dashboardId: string;
  widgetId?: string;
  body: string;
  author: string;
  createdAt: string;
  editedAt?: string;
}

export interface ScheduleInput {
  frequency: 'hourly' | 'daily' | 'weekly' | 'monthly';
  time: string;
  timezone: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
}

export interface RunRecord {
  at: string;
  status: string;
  message?: string;
}

export interface SubscriptionInfo {
  id: string;
  dashboardId: string;
  name: string;
  recipients: string[];
  schedule: ScheduleInput;
  widgets: string[];
  includeKpis: boolean;
  owner: string;
  nextRunAt: string;
  lastRun?: RunRecord;
}

export interface AlertInfo {
  id: string;
  dashboardId: string;
  name: string;
  queryId: string;
  field: string;
  reduce: string;
  op: string;
  threshold: number;
  intervalMinutes: number;
  recipients: string[];
  webhookUrl?: string;
  webhookSecretSet?: boolean;
  state: 'unknown' | 'ok' | 'firing';
  lastValue?: number | null;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  lastError?: string;
}

export interface RefreshInfo {
  dashboardId: string;
  intervalMinutes: number;
  nextRunAt: string;
  lastRun?: RunRecord;
}

export interface UsageSummary {
  days: number;
  dashboards: Array<{ dashboardId: string; views: number; lastViewedDay?: string; myLastViewedAt?: string }>;
}

export interface CatalogMetric {
  name: string;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * The route isn't there (yet). Phase 2/4 routes may be missing on an older backend; callers fall
 * back instead of failing.
 */
export function isRouteMissing(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501);
}

export interface StudioApiOptions {
  apiUrl?: string;
  token?: string;
  fetch?: typeof fetch;
}

/** Thin typed client for the authoring routes (dashboards, sources, recommendations). */
export class StudioApi {
  readonly apiUrl: string;
  readonly token: string;
  /** The transport every authoring call uses; the preview client shares it. */
  readonly fetchImpl: typeof fetch;

  constructor(options: StudioApiOptions = {}) {
    this.apiUrl = (options.apiUrl ?? API_URL).replace(/\/+$/, '');
    this.token = options.token ?? TOKEN;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, { method, headers, body: payload });
    } catch (error) {
      throw new ApiError(0, 'network_error', `Can't reach the BI API (${(error as Error).message}). Is it running on :4000?`);
    }
    if (!response.ok) {
      let code = 'http_error';
      let message = `Request failed with status ${response.status}.`;
      let details: unknown;
      try {
        const err = ((await response.json()) as ApiErrorBody).error;
        if (err) ({ code, message, details } = err);
      } catch {
        /* not JSON (e.g. the dev proxy can't reach the API) */
      }
      throw new ApiError(response.status, code, message, details);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async listDashboards(): Promise<DashboardSummary[]> {
    return (await this.request<{ dashboards: DashboardSummary[] }>('GET', '/v1/dashboards')).dashboards;
  }

  getDashboard(id: string, version?: number): Promise<StoredDashboard> {
    return this.request('GET', `/v1/dashboards/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`);
  }

  async listVersions(id: string): Promise<VersionSummary[]> {
    return (await this.request<{ versions: VersionSummary[] }>('GET', `/v1/dashboards/${encodeURIComponent(id)}/versions`)).versions;
  }

  /** expectedVersion 0 = create only; otherwise the version the edit is based on (409 if stale). */
  saveDashboard(id: string, spec: unknown, expectedVersion: number): Promise<SavedDashboard> {
    return this.request('PUT', `/v1/dashboards/${encodeURIComponent(id)}`, { spec, expectedVersion });
  }

  async listSources(): Promise<SourceSummary[]> {
    return (await this.request<{ sources: SourceSummary[] }>('GET', '/v1/sources')).sources;
  }

  getProfile(source: DataSource): Promise<SourceProfile> {
    const q = new URLSearchParams({ type: source.type, ref: source.ref });
    return this.request('GET', `/v1/sources/profile?${q}`);
  }

  uploadFile(file: File): Promise<UploadResponse> {
    const form = new FormData();
    form.append('file', file);
    return this.request('POST', '/v1/sources/files', form);
  }

  recommend(source: DataSource): Promise<RecommendationResponse> {
    return this.request('POST', '/v1/recommendations', { source });
  }

  assistantStatus(): Promise<{ enabled: boolean; model?: string }> {
    return this.request('GET', '/v1/assistant');
  }

  assistantChat(body: { draft: unknown; messages: AssistantMessage[]; selectedWidgetId?: string }): Promise<AssistantReply> {
    return this.request('POST', '/v1/assistant/chat', body);
  }

  async listShares(id: string): Promise<Share[]> {
    return (await this.request<{ shares: Share[] }>('GET', `/v1/dashboards/${encodeURIComponent(id)}/shares`)).shares;
  }

  createShare(id: string, body: CreateShareBody): Promise<CreateShareResponse> {
    return this.request('POST', `/v1/dashboards/${encodeURIComponent(id)}/shares`, body);
  }

  revokeShare(id: string, shareId: string): Promise<void> {
    return this.request('DELETE', `/v1/dashboards/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`);
  }
  // ── platform features (workstream D) ──

  platformStatus(): Promise<PlatformStatus> {
    return this.request('GET', '/v1/platform');
  }

  async listComments(id: string): Promise<DashboardComment[]> {
    return (await this.request<{ comments: DashboardComment[] }>('GET', `/v1/dashboards/${encodeURIComponent(id)}/comments`)).comments;
  }

  async addComment(id: string, body: string, widgetId?: string): Promise<DashboardComment> {
    return (await this.request<{ comment: DashboardComment }>('POST', `/v1/dashboards/${encodeURIComponent(id)}/comments`, { body, ...(widgetId ? { widgetId } : {}) })).comment;
  }

  async editComment(id: string, commentId: string, body: string): Promise<DashboardComment> {
    return (await this.request<{ comment: DashboardComment }>('PATCH', `/v1/dashboards/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { body })).comment;
  }

  deleteComment(id: string, commentId: string): Promise<void> {
    return this.request('DELETE', `/v1/dashboards/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`);
  }

  async favorites(): Promise<string[]> {
    return (await this.request<{ dashboards: string[] }>('GET', '/v1/favorites')).dashboards;
  }

  setFavorite(id: string, on: boolean): Promise<void> {
    return this.request(on ? 'PUT' : 'DELETE', `/v1/favorites/${encodeURIComponent(id)}`);
  }

  usage(days = 30): Promise<UsageSummary> {
    return this.request('GET', `/v1/usage?days=${days}`);
  }

  async listSubscriptions(dashboardId: string): Promise<SubscriptionInfo[]> {
    return (await this.request<{ subscriptions: SubscriptionInfo[] }>('GET', `/v1/subscriptions?dashboardId=${encodeURIComponent(dashboardId)}`)).subscriptions;
  }

  async createSubscription(body: Omit<SubscriptionInfo, 'id' | 'owner' | 'nextRunAt' | 'lastRun'>): Promise<SubscriptionInfo> {
    return (await this.request<{ subscription: SubscriptionInfo }>('POST', '/v1/subscriptions', body)).subscription;
  }

  async runSubscription(id: string): Promise<SubscriptionInfo> {
    return (await this.request<{ subscription: SubscriptionInfo }>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/run`)).subscription;
  }

  deleteSubscription(id: string): Promise<void> {
    return this.request('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  async listAlerts(dashboardId: string): Promise<AlertInfo[]> {
    return (await this.request<{ alerts: AlertInfo[] }>('GET', `/v1/alerts?dashboardId=${encodeURIComponent(dashboardId)}`)).alerts;
  }

  createAlert(body: Omit<AlertInfo, 'id' | 'state' | 'webhookSecretSet' | 'lastValue' | 'lastCheckedAt' | 'lastFiredAt' | 'lastError'>): Promise<{ alert: AlertInfo; webhookSecret?: string }> {
    return this.request('POST', '/v1/alerts', body);
  }

  async testAlert(id: string): Promise<AlertInfo> {
    return (await this.request<{ alert: AlertInfo }>('POST', `/v1/alerts/${encodeURIComponent(id)}/test`)).alert;
  }

  deleteAlert(id: string): Promise<void> {
    return this.request('DELETE', `/v1/alerts/${encodeURIComponent(id)}`);
  }

  async listRefresh(): Promise<RefreshInfo[]> {
    return (await this.request<{ schedules: RefreshInfo[] }>('GET', '/v1/refresh')).schedules;
  }

  async setRefresh(dashboardId: string, intervalMinutes: number): Promise<RefreshInfo> {
    return (await this.request<{ schedule: RefreshInfo }>('PUT', `/v1/dashboards/${encodeURIComponent(dashboardId)}/refresh`, { intervalMinutes })).schedule;
  }

  deleteRefresh(dashboardId: string): Promise<void> {
    return this.request('DELETE', `/v1/dashboards/${encodeURIComponent(dashboardId)}/refresh`);
  }

  /**
   * Runs one query of an unsaved draft and returns its result (custom SQL "Run and detect columns").
   * Uses the editor-only preview route; nothing is saved.
   */
  async runDraftQuery(spec: unknown, queryId: string): Promise<QueryResult> {
    const response = await this.fetchImpl(`${this.apiUrl}/v1/preview/data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ spec, queries: [queryId] }),
    }).catch((error: Error) => {
      throw new ApiError(0, 'network_error', `Can't reach the BI API (${error.message}).`);
    });
    if (!response.ok) {
      let message = `Request failed with status ${response.status}.`;
      let code = 'http_error';
      try {
        const err = ((await response.json()) as ApiErrorBody).error;
        if (err) ({ code, message } = err);
      } catch {
        /* not JSON */
      }
      throw new ApiError(response.status, code, message);
    }
    const line = JSON.parse((await response.text()).trim().split('\n')[0] ?? '{}') as DataResponseLine;
    if (!line.ok) throw new ApiError(200, line.error.code, line.error.message);
    return line.result;
  }

  async metricCatalog(): Promise<CatalogMetric[]> {
    return (await this.request<{ metrics: CatalogMetric[] }>('GET', '/v1/metrics-catalog')).metrics;
  }

  async putMetric(name: string, def: Record<string, unknown>): Promise<CatalogMetric> {
    return (await this.request<{ metric: CatalogMetric }>('PUT', `/v1/metrics-catalog/${encodeURIComponent(name)}`, def)).metric;
  }

  deleteMetric(name: string): Promise<void> {
    return this.request('DELETE', `/v1/metrics-catalog/${encodeURIComponent(name)}`);
  }

  /** URL of the server-side CSV export of one saved query (fetch it with the auth header). */
  exportUrl(dashboardId: string, queryId: string): string {
    return `${this.apiUrl}/v1/dashboards/${encodeURIComponent(dashboardId)}/export?query=${encodeURIComponent(queryId)}`;
  }

  /** Downloads the server-side CSV export (row-level security applies) as a Blob. */
  async exportCsv(dashboardId: string, queryId: string): Promise<Blob> {
    const res = await this.fetchImpl(this.exportUrl(dashboardId, queryId), { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new ApiError(res.status, 'export_failed', `Export failed with status ${res.status}.`);
    return res.blob();
  }
}
