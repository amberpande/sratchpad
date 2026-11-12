# Sratchpad: architecture

How the system is built today. Why it is built this way: [`DECISIONS.md`](DECISIONS.md). The original
proposal it grew from: [`design-doc.md`](design-doc.md).

## In one picture

```
                    ┌──────────────────────── AWS ECS service (N tasks) ────────────────────────┐
 Developers ──────► │  /            Studio (authoring)                                          │
 Business users ──► │  /view/       Viewer (read-only, from share links)        one Node process│
 Teams' apps ─────► │  /bi-api/*    API ──► gateway ──► store · query layer · AI · sharing      │
                    └───────────────────────────────┬──────────────────────────────┬────────────┘
                                                    │                              │
                          ┌─────────────────────────▼───────┐        ┌─────────────▼─────────────┐
                          │ Snowflake                       │        │ Claude API (optional)     │
                          │  BI_APP.APP     hybrid tables   │        │  ranks rule-built chart   │
                          │   dashboards, versions, shares, │        │  candidates; sees profile │
                          │   upload records                │        │  summaries only           │
                          │  BI_APP.UPLOADS Iceberg tables  │        └───────────────────────────┘
                          │   (one per upload)              │
                          │  teams' own tables (pushdown)   │
                          └─────────────────────────────────┘
```

Local development runs the same code without Snowflake: an in-memory store, uploads as local Parquet
queried by DuckDB, and Vite dev servers for the frontends proxying `/bi-api` to the API on :4000.

## Components

| Component | Path | Responsibility |
| --- | --- | --- |
| **Spec** | `packages/spec` | The contract: dashboard schema (zod), widget registry with `since` versions, `validateDashboard`, version compatibility, params, wire and sharing types. Imported by everything. |
| **Renderer SDK (widgets)** | `packages/renderer/src/widgets` | Widgets (`packages/renderer/src/widgets`): Recharts for cartesian/pie/combo, hand-built SVG for heatmap, treemap (d3-hierarchy), box plot, waterfall, gauge, sankey (d3-sankey) and map (d3-geo + bundled world/US atlases in a lazy chunk). Shared helpers in `vizParts.tsx` (sizing, color scales, threshold matching, facets, reference marks, `useMarks` → interaction contract). Author colors reach CSS only as custom properties. |
| **Renderer SDK** | `packages/renderer` | `<Dashboard id token>`: fetches the JSON, gates on `specVersion`, lays out the grid, batches and streams queries, caches per session, renders widgets (Recharts, code-split). |
| **Studio** | `apps/studio` | Authoring: data panel from the profiler, palette, drag-and-drop grid, inspector, params, JSON view, undo/redo, live draft preview, history, conflict handling, suggestions, Share dialog, sign-in. |
| **Viewer** | `apps/viewer` | Read-only full-page dashboard opened from a share link (`/view/#token=…`). |
| **Host apps** | `apps/host-ops`, `apps/host-sales` | Two example "team apps" embedding the same dashboard (the Phase 1 proof). |
| **API** | `services/api` | The one shared backend (below). |
| **Integration tests** | `tests/integration` | Store → API → SDK → rendered widgets, in two host shapes. |

### Inside the API (`services/api/src`)

| Module | Job |
| --- | --- |
| `app.ts` | Routes, gateway (token → team, role or share scope), role checks, rate limits, request ids, access logs, metrics. |
| `web.ts` | Production single-container layer: Studio, viewer, `/bi-api` → API, static caching and security headers. |
| `auth.ts` | `TokenVerifier` interface; static tokens today (`token:team:subject:role`), OIDC later. |
| `store/` | Dashboard store: `memory`, `postgres`, `snowflake/` (hybrid tables + migrations + SQL client). |
| `sharing/` | Share records, token minting and verification (hash only), memory/Postgres stores; Snowflake store lives in `store/snowflake/stores.ts`. |
| `data/` | Query layer: engines (`sample`, `duckdb` for local files, `snowflake`), semantic → SQL compiler (`sql/`), profiler, uploads (`files/`: ingest, registry, Iceberg loader), result cache, run loop. |
| `ai/` | Recommendations (classify fields, candidates, Claude ranker, layout) and the Studio assistant (`assistant.ts`: tool loop, JSON Patch, validation gate; `spec-reference.ts`: prompt reference generated from the spec schemas). |
| `guard/` | Per-team rate limiter and query concurrency gate. |
| `rls.ts` | Row-level security policies (`BI_RLS_POLICIES`) and per-principal row filters; applied inside `data/run.ts`. |
| `data/sql/joins.ts`, `data/metrics.ts` | Joined-source attachment; team metric catalog expansion. |
| `platform/`, `routes/platform.ts` | Platform store (records, counters, leases; memory or one SQL implementation for Postgres/Snowflake), service (comments, favorites, usage, subscriptions, alerts, refresh, metric catalog), scheduler (lease-based leader), mailer (SMTP), webhooks (SSRF-pinned, signed). |
| `obs/` | Metrics registry (Prometheus text) and structured logger. |
| `config.ts`, `server.ts` | Environment → config; wiring of stores, engines, cache, AI, web layer; graceful shutdown. |

## Request flows

### A dashboard loads (Studio preview, host app, viewer)

1. `GET /bi-api/v1/dashboards/:id` → gateway resolves the token to a team (or a share scope) → the
   store returns the latest (or pinned) version's JSON → the SDK validates `specVersion`.
2. The SDK sends **one** `POST …/:id/data` with every widget's query id and the param values (plus
   cross-filter or drill variants from clicks: `{query, key, filters | drill}`, validated against the dashboard).
3. For each query: params are applied → drill and cross-filters → row-level security (from the principal) →
   catalog metrics expanded → joined sources attached (and checked) → result cache checked (key: team + source + resolved query) →
   on a miss, the per-team gate admits it → the engine compiles SQL and runs it where the data lives →
   one NDJSON line per query streams back as soon as it finishes.
4. Widgets render as their lines arrive; each shows its data's age (`asOf`, "cached").

### Authoring

The Studio keeps an unsaved draft and previews it with `POST /bi-api/v1/preview/data` (editor only;
the draft must validate). Save is `PUT …/:id` with `expectedVersion`: a stale version is `409`, offered
as reload or save on top. Every save appends an immutable version.

### Upload

`POST …/sources/files` (editor) → size and type checks → DuckDB parses and types the file into Parquet
→ profile computed locally → with `BI_UPLOADS=snowflake`: export normalized CSV → `PUT` to the stage →
`CREATE ICEBERG TABLE … AS SELECT` with explicit casts → delete staged and local copies → record
(team, storage, table, profile) saved. Queries on the upload are compiled for Snowflake and run under
the uploads role after the team-scoped record lookup.

### Recommendation

`POST …/recommendations` (editor) → profile → rules classify fields and build candidates → Claude
ranks and words them (optional, with a deadline) → candidates sanitized → layout assembled into a
dashboard that always validates → returned as an editable draft.

### Assistant turn

Studio sends `{draft, messages, selectedWidgetId}` to `POST …/assistant/chat` (editor) → Claude gets the
generated spec reference (cached) and the draft → it calls `get_source_profile` / `list_sources` as needed
and `update_dashboard` with JSON Patch operations → each patch is applied to a copy, `specVersion` is
raised if newer features are used, and the draft is validated: if the patch adds errors it is rejected and
the errors go back to Claude, otherwise it becomes the working draft (low-contrast or overlap warnings are
reported back as advice) → the final draft returns to the Studio, which applies it as one undo step
(unless the developer edited meanwhile). Nothing is saved.

### Scheduled jobs

Every task ticks; the holder of the `scheduler` lease runs due subscriptions, alerts and refreshes, each as its
owner (row-level attributes captured at creation) through `runQuery`. Emails go via SMTP; webhooks are pinned to
checked public addresses and signed.

### Sharing

Editor creates a share → token minted (`bis_<id>_<secret>`), hash stored → for viewers, the link is
`https://<allowlisted host>/view/#token=…`. A request with a share token is confined to that dashboard's
JSON and saved queries; the pinned version (if any) is enforced; expired or revoked tokens are `401`.

## Data and storage

| What | Production (`BI_STORE=snowflake`) | Alternative | Dev |
| --- | --- | --- | --- |
| Dashboards + versions | `BI_APP.APP.dashboards`, `dashboard_versions` (hybrid) | Postgres | memory |
| Shares | `BI_APP.APP.dashboard_shares` (hybrid; token hashes only) | Postgres | memory |
| Upload records | `BI_APP.APP.file_sources` (hybrid) | Postgres | JSON manifest |
| Upload data | `BI_APP.UPLOADS.FILE_<ID>` (Snowflake-managed Iceberg) | local Parquet | local Parquet |
| Teams' tables | queried in place (pushdown), team role | – | – |
| Comments, favorites, usage, subscriptions, alerts, catalog, leases | `BI_APP.APP.platform_*` (hybrid) | Postgres | memory |
| Result cache | in-process LRU per task | Redis (`REDIS_URL`) | in-process |

Saves are optimistic on hybrid tables (`UPDATE … WHERE latest_version = N` + enforced version key).
Schemas migrate on boot; concurrent tasks converge.

## Security model

- **Identity:** every `/v1` request resolves to a principal: team + role (`editor` / `viewer`), or a
  share scope (one dashboard, optional pinned version). Static tokens today; SSO planned.
- **Isolation:** every store read is scoped by team; another team's dashboard, upload or share reads as
  "not found". Cache keys include the team.
- **Least privilege:** viewers and share tokens are read-only; share tokens see one dashboard; clients
  run only saved queries (except the editor-only draft preview).
- **SQL safety:** SQL is generated only from the spec; identifiers quoted; every value is a bind
  parameter; the only inlined number is a validated `LIMIT`. DDL for uploads uses server-generated names
  and quoted headers only.
- **Secrets:** share tokens and access tokens are never logged; share secrets stored as SHA-256 hashes;
  viewer links keep tokens in the URL fragment; production secrets come from Secrets Manager.
- **AI:** the model sees profile summaries only. For suggestions it can only pick rule-built candidates; the
  assistant can only patch the unsaved draft, every patch is validated, prototype paths are refused, and
  nothing it returns is executed or saved without the developer.
- **Row-level security:** `BI_RLS_POLICIES` maps a source column to a principal attribute per team (attributes from the token/IdP; shares carry a subset of their creator's). Enforced inside `runQuery`, so dashboard data, previews, exports, alerts and subscriptions all apply it, before the result cache (keys include the row filters). Fails closed: a missing attribute shows no rows (`rls_denied`); a malformed policy stops the server. Profiles (editor-only) are summaries computed over all rows and are not row-filtered.
- **Interactions never widen what runs:** cross-filters and drill variants are derived from author-declared dimensions and drill levels and re-validated on the server; params are checked against their declarations (measure switches only among declared options).
- **Platform:** exports and jobs go through `runQuery` (row-level security, cache, limits); webhooks are https-only,
  SSRF-pinned and HMAC-signed; CSV exports neutralize formulas; subscription links are expiring, revocable shares.
- **Styling:** theme and widget style values are constrained by the schema and applied only as CSS custom
  properties (no CSS injection into host apps).
- **Browser:** Studio not frameable; `nosniff`, `no-referrer`; the viewer is `noindex`.

## Scaling notes

The API is stateless; scale by adding ECS tasks. Most dashboard traffic is absorbed by the result cache
(many viewers, same queries). Snowflake is the throughput and cost ceiling: size and multi-cluster the
warehouses, and rely on its result cache. Known per-task limits: rate limits and the query gate (D-013),
the in-process cache without Redis. Hybrid tables allow about 16,000 operations/s per database.
A load test is the next step before a company-wide rollout ([`DEPLOYMENT.md`](DEPLOYMENT.md#before-rolling-out-to-every-team)).

## Current limits

- SSO not built (D-027 stopgap). Anyone holding a viewer link can view it.
- Snowflake paths (hybrid store, Iceberg uploads, query engine incl. 1.3 SQL: percentiles, windows, top-N, `LIKE … ESCAPE`),
  the Claude ranker and assistant, real SMTP and webhook delivery, and browser PNG export are tested with fakes,
  adapters or jsdom, **not yet against live services**.
- Rate limits and the query gate are per task.
- Joins only within one engine type, and not with row-secured sources (D-065). Only a query's first dimension drills.
- Maps: world countries (names, ISO numeric) and US states only.
- Excel: first non-empty sheet, row 1 is the header. CSV must be UTF-8. Uploads up to 50 MB.
- The SDK is consumed as TypeScript source in the monorepo; publishing it needs a build step.
- Remaining analytical gaps (level-of-detail expressions, row-level expressions, forecasting, extracts, …):
  [`CAPABILITIES.md`](CAPABILITIES.md).
