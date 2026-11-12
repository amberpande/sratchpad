# Sratchpad: API reference (v1)

Base URL: `https://<your Sratchpad host>/bi-api` in production (single container), `http://localhost:4000`
in development (the frontends' dev servers proxy `/bi-api` there). Paths below are relative to it.
Types live in `packages/spec/src/{wire,sources,sharing}.ts`.

## Authentication and roles

Every `/v1` route needs `Authorization: Bearer <token>`.

| Token | Who | Can |
| --- | --- | --- |
| Team token, role `editor` | Developers who build | Everything for their team |
| Team token, role `viewer` | Read-only team members | List, open and run their team's dashboards and version history |
| Share token `bis_…`, audience `app` | An application | Read one dashboard's JSON and run its saved queries |
| Share token `bis_…`, audience `viewer` | Business users via the viewer | Same as `app`; opened through a viewer link |

Team tokens come from `BI_TOKENS` (`token:team:subject[:role]`, comma-separated) until SSO replaces
them. Dev tokens: `dev-token-team-a`, `dev-token-team-b` (editors), `dev-token-team-a-viewer`. Production
refuses to start without explicit `BI_TOKENS`.

Errors are `{"error": {"code", "message", "details"?}}`. Common codes: `401 unauthorized`,
`403 forbidden` (read-only access), `404 not_found` (also for another team's objects: no existence
leaks), `409 version_conflict`, `413 payload_too_large`, `422 invalid_spec` (with every error path),
`429 rate_limited` (with `Retry-After`), `502 load_failed`, `503 *_unavailable`.

Every response carries `X-Request-Id` (a safe incoming one is echoed).

## Dashboards

| Route | Role | |
| --- | --- | --- |
| `GET /v1/dashboards` | any | The team's dashboards (`{dashboards: [{id, title, latestVersion, updatedAt}]}`); a share token sees only its dashboard |
| `GET /v1/dashboards/:id[?version=n]` | any | Latest or pinned version: `{id, version, title, specVersion, createdAt, createdBy, spec}`, `ETag: "n"`. A pinned share serves only its version |
| `GET /v1/dashboards/:id/versions` | team | Version history (403 for share tokens) |
| `PUT /v1/dashboards/:id` | editor | `{spec, expectedVersion?}`: validates and appends a version (`201` first, `200` after). `expectedVersion: 0` = create only; stale = `409 {currentVersion}` |
| `POST /v1/dashboards/:id/data` | any | `{queries: [ids], params?, version?}` → NDJSON, one line per query in completion order: `{id, ok: true, result, ms}` or `{id, ok: false, error}` |

Clients name saved queries by id and never send query bodies. Up to 50 queries per request. Send
`Cache-Control: no-cache` to skip the result cache (the fresh result still refreshes it). Results carry
`asOf` (when the data was read) and `cached: true` when served from cache.

### Interactions, row-level security and 1.3 query errors

`queries` entries may be variants: `{"query": "q_cat", "key": "q_cat~1", "filters"?: [{"field", "op": "in" | "eq", "values", "grain"?}], "drill"?: {"widget", "level", "path"}}`. Response lines use `key`. Cross-filters need `interactions.crossFilter` and may only use the dashboard's declared dimensions on the same source (max 10 filters × 100 values); drills must follow the widget's saved `drill.levels`. Otherwise `400 invalid_filters` / `invalid_drill`. Row-level security errors are per line: `rls_denied`, `rls_misconfigured`.

`POST /v1/dashboards/:id/shares` also takes `attributes` (`{"region": ["EU"]}` or `"region=EU"`): the row-level security attributes the share sees. Default: the creator's own; never more than the creator has (`403`). Shares list `attributes`.

SDK: `<Dashboard onNavigate={({ dashboardId, params }) => …} />` handles drill-through.

Query errors added in 1.3 (per NDJSON line): `invalid_expression`, `invalid_calc`, `invalid_window`, `invalid_top_n`,
`invalid_dimension`, `invalid_join`, `unknown_metric`, `invalid_metric`, `metrics_not_expanded`, `duplicate_column`.

## Draft preview, sources and uploads (editors)

| Route | |
| --- | --- |
| `POST /v1/preview/data` | `{spec, queries, params?}`: runs queries of an **unsaved** draft (must validate, else `422`); same NDJSON stream |
| `GET /v1/sources` | Sample datasets, the team's uploads, and Snowflake tables/views the team's role can see (if configured) |
| `GET /v1/sources/profile?type=&ref=` | The source's profile (column types, roles, cardinality, ranges, samples for categories); `404` if the team can't see it |
| `POST /v1/sources/files` | `multipart/form-data`, field `file` (.csv UTF-8 or .xlsx, max 50 MB) → `201 {summary, profile}`. Source is `{"type": "file", "ref": "file_<24 hex>"}`, visible only to the uploading team |

```bash
curl -X POST https://<host>/bi-api/v1/sources/files -H "Authorization: Bearer $TOKEN" -F file=@orders.csv
```

## Recommendations (editors)

`POST /v1/recommendations` `{source}` → `{source, profile, candidates, dashboard, generatedBy, warnings}`.
`dashboard` always validates. `generatedBy` is `"rules"` when Claude was off, failed or was slow, else
`"rules+llm"`. Candidates' `query.source` and the dashboard's `dataSources` key is `"src"`.

## Assistant (editors)

| Route | |
| --- | --- |
| `GET /v1/assistant` | `{enabled, model?}`: whether this server runs the assistant |
| `POST /v1/assistant/chat` | `{draft, messages: [{role: "user" \| "assistant", content}], selectedWidgetId?}` → `{reply, draft, changed, changes: string[], issues}` |

The API edits the **unsaved** draft it was sent and returns it; it never saves. `changes` are one-line
summaries of accepted edits; `issues` are validation problems still in the draft (only ones that were
already there: the assistant cannot add errors). Up to 50 messages (send the conversation's text turns;
the latest must be from the user), 10,000 characters each. Errors: `503 assistant_unavailable` (off),
`422 assistant_declined`, `502 assistant_failed`, `429 rate_limited` (`BI_RATE_LIMIT_ASSISTANT`).

## Sharing

| Route | Role | |
| --- | --- | --- |
| `POST /v1/dashboards/:id/shares` | editor | `{audience: "app" \| "viewer", label?, version?, expiresInDays? (1–365)}` → `201 {share, token, viewerUrl?}`. **The token is returned only here.** `viewerUrl` for viewer shares when the host is allowlisted or `BI_VIEWER_URL` is set |
| `GET /v1/dashboards/:id/shares` | editor | `{shares: Share[]}` (never tokens): label, audience, version, createdBy/At, expiresAt, revokedAt, lastUsedAt |
| `DELETE /v1/dashboards/:id/shares/:shareId` | editor | Revoke now (`204`, idempotent) |
| `GET /v1/share` | share token | What the token grants: `{share: {id, dashboardId, audience, label, version?, expiresAt?}, dashboard: {id, title, latestVersion}}` |

A share token answers `404` for other dashboards and `403` for anything else (history, writes, sources,
preview, recommendations, shares). Revoked or expired tokens are `401`.

### Reading a shared dashboard from an application

```ts
import { validateDashboard } from '@yourorg/bi-spec';

const BI = 'https://sratchpad.example.com/bi-api';
const headers = { Authorization: `Bearer ${process.env.BI_SHARE_TOKEN}` };
const { spec, version } = await (await fetch(`${BI}/v1/dashboards/dash_9f2a`, { headers })).json();
const parsed = validateDashboard(spec); // typed widgets, queries, layout, params; render however you like

const res = await fetch(`${BI}/v1/dashboards/dash_9f2a/data`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ queries: ['q_totals'], params: { dateRange: 'last_30d' }, version }),
});
// NDJSON: one {"id", "ok", "result"} line per query
```

Or render it with the SDK: `<Dashboard id="dash_9f2a" token={shareToken} apiUrl={BI} />`.

## Platform (comments, favorites, usage, exports, schedules, alerts, metric catalog)

| Route | Role | |
| --- | --- | --- |
| `GET /v1/platform` | team | `{me: {subject, teamId, role}, email, scheduler}` |
| `GET /v1/dashboards/:id/comments` | team | `{comments}` oldest first |
| `POST /v1/dashboards/:id/comments` | team | `{body (≤4000), widgetId?}` → `201 {comment}` |
| `PATCH /v1/dashboards/:id/comments/:cid` | author | `{body}` |
| `DELETE /v1/dashboards/:id/comments/:cid` | author or editor | `204` |
| `GET /v1/favorites` · `PUT/DELETE /v1/favorites/:id` | team | personal favorites |
| `GET /v1/usage?days=30` | team | `{days, dashboards: [{dashboardId, views, lastViewedDay?, myLastViewedAt?}]}` |
| `GET /v1/dashboards/:id/usage?days=30` | team | `{total, series: [{day, views}]}` |
| `GET /v1/dashboards/:id/export?query=&params=&version=` | team | CSV of one saved query (RLS applies) |
| `GET/POST /v1/subscriptions`, `POST /v1/subscriptions/:sid/run`, `DELETE /v1/subscriptions/:sid` | editor | `{dashboardId, name, recipients, schedule: {frequency, time, timezone, dayOfWeek?, dayOfMonth?}, widgets, includeKpis}` |
| `GET/POST /v1/alerts`, `POST /v1/alerts/:aid/test`, `DELETE /v1/alerts/:aid` | editor | `{dashboardId, name, queryId, field, reduce, op, threshold, intervalMinutes, recipients, webhookUrl?}`; creation returns `webhookSecret` once |
| `GET /v1/refresh` · `PUT/DELETE /v1/dashboards/:id/refresh` | editor | `{intervalMinutes 5–1440}` |
| `GET /v1/metrics-catalog` (team) · `PUT/DELETE /v1/metrics-catalog/:name` (editor) | | metric definitions (format: data/metrics.ts) |

Share tokens get `403` on all of these. Webhook payload: `{type: "alert.fired", alert, dashboard, field, value,
previous, op, threshold, firedAt}`; verify `X-Sratchpad-Signature` = `sha256=` + hex HMAC-SHA256 of
`<X-Sratchpad-Timestamp>.<raw body>` with the secret.

Platform writes share the per-team `writes` rate limit (`BI_RATE_LIMIT_WRITES`).

## Embedding with the SDK

```tsx
import { Dashboard } from '@yourorg/bi-renderer';

<Dashboard id="dash_9f2a" token={authToken} params={{ dateRange: 'last_30d' }} />
```

Proxy `/bi-api` to Sratchpad from the host app, or pass `apiUrl`, or use `BIProvider` for app-wide
defaults. `token` may be a function (refreshed tokens just work). `version` pins a version.
`theme="light" | "dark" | "auto"`; every color is a `--bi-*` CSS variable. Passing an inline `fetch`
is safe (D-018).

## Operations

| Route | |
| --- | --- |
| `GET /healthz` | `{ok: true}`, no auth (load balancer) |
| `GET /metrics` | Prometheus text; requires `Bearer $BI_METRICS_TOKEN` when set. Labels never include team or dashboard ids |
