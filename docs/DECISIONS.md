# Sratchpad: decision log

Every significant decision behind Sratchpad, newest last. Each entry says what was decided, why,
what else was considered, and what it costs. **Add an entry whenever a decision is made or
reversed** (see [`CLAUDE.md`](../CLAUDE.md)); never rewrite history: supersede an entry with a new
one and mark the old one `Superseded by D-NNN`.

Status values: `Accepted`, `Superseded by D-NNN`, `Proposed` (agreed in principle, not built).

Index

| # | Decision | Status |
| --- | --- | --- |
| [D-001](#d-001-embed-first-self-service-bi-with-the-ui-as-json) | Embed-first self-service BI; every dashboard is a versioned JSON document | Accepted |
| [D-002](#d-002-one-typescript-monorepo-and-one-shared-spec-package) | One TypeScript monorepo; one spec package shared by every part | Accepted |
| [D-003](#d-003-the-dashboard-spec-semantic-queries-grid-layout-explicit-versioning) | Spec: semantic queries, grid layout, params, explicit versioning | Accepted |
| [D-004](#d-004-clients-name-saved-queries-they-never-send-query-bodies) | Clients name saved queries; they never send query bodies | Accepted |
| [D-005](#d-005-recharts-as-the-charting-core-behind-a-widget-registry) | Recharts behind a widget registry | Accepted |
| [D-006](#d-006-a-reference-engine-and-a-conformance-suite-define-query-semantics) | Reference engine + conformance suite define query semantics | Accepted |
| [D-007](#d-007-duckdb-for-uploaded-files) | DuckDB for uploaded files | Accepted (role narrowed by D-022) |
| [D-008](#d-008-snowflake-pushdown-never-extract) | Snowflake: pushdown, never extract | Accepted |
| [D-009](#d-009-one-batched-streamed-request-per-dashboard-load) | One batched, streamed (NDJSON) request per dashboard load | Accepted |
| [D-010](#d-010-ai-recommendations-rules-build-claude-only-judges) | AI recommendations: rules build, Claude only judges | Accepted |
| [D-011](#d-011-average-durations-scores-and-rates-never-sum-them) | Average durations, scores and rates; never sum them | Accepted |
| [D-012](#d-012-server-side-result-cache-keyed-on-the-resolved-query) | Server-side result cache keyed on the resolved query | Accepted |
| [D-013](#d-013-per-team-guardrails-in-process-for-now) | Per-team guardrails, in-process for now | Accepted |
| [D-014](#d-014-observability-prometheus-metrics-json-logs-request-ids) | Prometheus metrics, JSON logs, request ids | Accepted |
| [D-015](#d-015-two-team-roles-editor-and-viewer) | Two team roles: editor and viewer | Accepted |
| [D-016](#d-016-read-only-sharing-with-scoped-share-tokens) | Read-only sharing with scoped share tokens | Accepted |
| [D-017](#d-017-a-hosted-viewer-for-business-users) | A hosted viewer for business users | Accepted |
| [D-018](#d-018-the-sdk-must-not-reload-when-a-host-passes-a-new-fetch) | The SDK must not reload when a host passes a new `fetch` | Accepted |
| [D-019](#d-019-keep-the-architecture-change-the-topology-for-10000-users) | Keep the architecture; change the topology for 10,000+ users | Accepted (refined by D-020 to D-022) |
| [D-020](#d-020-minimum-infrastructure-aws-ecs-and-snowflake-only) | Minimum infrastructure: AWS ECS and Snowflake only | Accepted |
| [D-021](#d-021-the-apps-own-records-in-snowflake-hybrid-tables) | The app's own records in Snowflake Hybrid Tables | Accepted |
| [D-022](#d-022-uploads-become-snowflake-managed-iceberg-tables) | Uploads become Snowflake-managed Iceberg tables | Accepted |
| [D-023](#d-023-stay-on-typescript-and-node-no-go-or-python-backend) | Stay on TypeScript/Node; no Go or Python backend | Accepted |
| [D-024](#d-024-one-container-serves-the-studio-the-viewer-and-the-api) | One container serves the Studio, the viewer and the API | Accepted |
| [D-025](#d-025-share-links-use-the-apps-hostname-from-an-allowlist) | Share links use the app's hostname, from an allowlist | Accepted |
| [D-026](#d-026-production-runs-a-bundled-server-on-plain-node) | Production runs a bundled server on plain Node | Accepted |
| [D-027](#d-027-studio-sign-in-with-access-tokens-until-sso) | Studio sign-in with access tokens until SSO | Accepted (temporary) |
| [D-028](#d-028-the-product-is-named-sratchpad) | The product is named Sratchpad | Accepted |
| [D-029](#d-029-documentation-is-part-of-every-change) | Documentation is part of every change | Accepted |
| [D-030](#d-030-a-styling-layer-in-the-spec-spec-12) | A styling layer in the spec (spec 1.2) | Accepted |
| [D-031](#d-031-a-chat-assistant-in-the-studio-that-edits-the-draft-through-validated-json-patches) | A chat assistant in the Studio that edits the draft through validated JSON Patches | Accepted |
| [D-032](#d-032-a-dashboards-theme-mode-wins-over-the-hosts-theme) | A dashboard's theme mode wins over the host's theme | Accepted |
| [D-033](#d-033-track-capability-gaps-against-tableau-and-qlik-openly) | Track capability gaps against Tableau and Qlik openly | Accepted |

Open questions are listed [at the end](#open-questions).

---

## D-001 Embed-first self-service BI with the UI as JSON

- **Date:** 2026-11-09 · **Status:** Accepted · **Source:** [`design-doc.md`](design-doc.md)
- **Context:** Developers on many teams need analytics inside their own React apps. Analysts in a
  standalone BI portal are not the primary users.
- **Decision:** Build a self-service tool where a developer either drags widgets onto a canvas or
  attaches data and gets AI-recommended charts. Every dashboard is saved as a versioned JSON document
  that any team's app renders with one component. One shared backend serves every team.
- **Alternatives:** Adopt Superset/Metabase/Tableau embedding (heavy, iframe-based, not "UI as data");
  compete on visualization breadth (years of work, not the differentiator).
- **Consequences:** The JSON spec is the product's most important contract: breaking it breaks every
  host app at once (see D-003). Out of scope for v1: scheduled emails, per-end-user row-level security,
  write-back, real-time streaming.

## D-002 One TypeScript monorepo and one shared spec package

- **Date:** 2026-11-09 · **Status:** Accepted
- **Context:** The Studio writes the spec, the API validates and stores it, the renderer reads it, and
  teams' apps parse it. If they disagree about the schema, dashboards break.
- **Decision:** An npm-workspaces monorepo, TypeScript everywhere. `packages/spec` (schemas, widget
  registry, `validateDashboard`, wire types) is the single source of truth, imported by every other
  package and offered to teams' apps.
- **Alternatives:** Separate repos per component; a backend in another language with a duplicated schema.
- **Consequences:** One validator, no drift. Packages are consumed as TypeScript source inside the repo;
  publishing the SDK to teams outside it needs a build step (tsup), not yet done. Reaffirmed by D-023.

## D-003 The dashboard spec: semantic queries, grid layout, explicit versioning

- **Date:** 2026-11-09 · **Status:** Accepted · **Detail:** [`SPEC.md`](SPEC.md)
- **Decision:** A document keeps three concerns apart: `layout` (12-column grid, react-grid-layout
  shape), `widgets` (type, encoding, options; reference queries by id) and `queries` (semantic:
  dimensions, measures, filters, orderBy, limit; never SQL). `params` (date range, select) bind into
  queries. `specVersion` is `MAJOR.MINOR`: same major and newer minor renders degraded (unknown widgets
  become placeholders with a banner); a different major is refused. Every widget type and field records
  the version it arrived in (`since`, `fieldsSince`).
- **Alternatives:** Store SQL per widget (not portable between engines, injection risk); unversioned JSON.
- **Consequences:** The same dashboard runs on the sample data, an uploaded file or Snowflake unchanged.
  Adding optional fields or widget types is a minor bump; removing or re-typing is a major bump that
  needs a renderer release. Spec 1.1 added area, scatter, pie, pivot and text widgets, `encoding.series`
  and table pagination.

## D-004 Clients name saved queries; they never send query bodies

- **Date:** 2026-11-09 · **Status:** Accepted
- **Decision:** `POST /v1/dashboards/:id/data` takes query **ids** of a saved dashboard. The only route
  that runs unsaved queries is the editor-only draft preview.
- **Consequences:** A host app, a viewer link or an app token can only run what an author saved.
  This is what makes read-only sharing (D-016) safe.

## D-005 Recharts as the charting core, behind a widget registry

- **Date:** 2026-11-09 · **Status:** Accepted (the design doc listed this as open)
- **Decision:** Recharts renders charts; widgets are looked up in a registry and code-split, so a host
  ships only the chart libraries its dashboards use.
- **Alternatives:** ECharts, visx.
- **Consequences:** Swapping the library touches about four files.

## D-006 A reference engine and a conformance suite define query semantics

- **Date:** 2026-11-09 · **Status:** Accepted · **Detail:** [`SPEC.md`](SPEC.md#query-semantics-every-engine)
- **Decision:** The in-memory sample engine is the reference. `services/api/test/conformance.test.ts`
  runs the same cases through every engine and requires identical rows, order and types. Rules: time
  buckets as `'YYYY-MM-DD'` strings with ISO weeks starting Monday; `orderBy` then every dimension as a
  tie-break; **NULLs sort last in both directions**; `sum`/`avg` rounded to 6 decimals; SQL NULL rules.
- **Consequences:** A dashboard shows the same numbers whichever engine serves it.

## D-007 DuckDB for uploaded files

- **Date:** 2026-11-09 · **Status:** Accepted; its role narrowed by D-022
- **Decision:** Uploaded CSV/Excel is parsed once by DuckDB (in-process library) into typed Parquet,
  profiled there, and (with local uploads) queried there.
- **Alternatives:** Hand-written parsing/aggregation (slow, error-prone).
- **Consequences:** A 1M-row CSV uploads and profiles in about 2 s. Local Parquet does not survive
  multiple ECS tasks, hence D-022: DuckDB now parses and profiles; Snowflake stores and queries.

## D-008 Snowflake: pushdown, never extract

- **Date:** 2026-11-09 · **Status:** Accepted
- **Decision:** Queries compile to Snowflake SQL and run in Snowflake under each team's warehouse and
  role (cost attributable, Snowflake grants are the access check). Profiling samples rather than scans.
  `STATEMENT_TIMEOUT_IN_SECONDS` and `LIMIT` guard against runaway cost.
- **Consequences:** Only small aggregated results reach the API and the browser.

## D-009 One batched, streamed request per dashboard load

- **Date:** 2026-11-09 · **Status:** Accepted
- **Decision:** The renderer batches every widget's query into one request; the API streams one NDJSON
  line per query as each finishes; shared queries are deduped; the SDK caches per session.
- **Consequences:** One slow query never blocks the others; dense dashboards make one round trip.

## D-010 AI recommendations: rules build, Claude only judges

- **Date:** 2026-11-10 · **Status:** Accepted
- **Context:** Recommendations must be reproducible, safe with company data, and never block authoring.
- **Decision:** Deterministic rules classify profiled fields and build complete chart candidates
  (query + widget). Claude (`claude-opus-5-5`, structured outputs, low effort, server-side fallbacks
  on refusal) only orders them, picks which belong, and writes titles and rationales. It can only choose
  candidate ids it was given. It sees the profile summary (types, cardinality, ranges, category labels),
  **never rows, ids or measure values**. With no credentials, an error, a refusal or a timeout the
  response is the rules' answer (`generatedBy: "rules"`). `BI_AI=auto|on|off`.
- **Alternatives:** Let the LLM write queries or SQL (unreproducible, unsafe); send sample rows (data exposure).
- **Consequences:** Works without any AI; a bad AI answer cannot produce a broken or unsafe dashboard.
  Not yet run against the live Claude API (tested with a fake client).

## D-011 Average durations, scores and rates; never sum them

- **Date:** 2026-11-10 · **Status:** Accepted
- **Context:** A test upload (support tickets) produced "Total resolution hours", which is meaningless.
- **Decision:** Columns that look non-additive by name or format (hours, minutes, duration, age, score,
  rating, rate, percent, csat, …) are averaged. Part-to-whole charts use only additive measures and fall
  back to counting records.

## D-012 Server-side result cache keyed on the resolved query

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** Cache key = (team, source, fully resolved query): params are applied first, so another
  date range is another key and relative presets roll over daily. The team is in the key so a cached
  result never bypasses an engine's per-team access checks. **Default TTL 60 s**; widgets show `asOf`
  and "cached". Identical in-flight queries share one execution. In-process LRU by default, Redis
  (`REDIS_URL`) across tasks. A failing cache falls through to the engine.
- **Consequences:** Many people viewing the same dashboard cost one query per minute, not one per view.

## D-013 Per-team guardrails, in-process for now

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** Token-bucket rate limits per team and route group (data, recommendations, uploads,
  writes; `429` + `Retry-After`) and a per-team cap on concurrently executing queries with a bounded queue.
- **Consequences:** Limits are per ECS task: with N tasks a team gets up to N× the budget. Move them to
  a shared store if exact global limits matter.

## D-014 Observability: Prometheus metrics, JSON logs, request ids

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** `/metrics` (Prometheus text, optional `BI_METRICS_TOKEN`) with route-pattern labels and
  **never team or dashboard ids** (bounded cardinality, no data leakage); one JSON access-log line per
  request to stdout (CloudWatch on ECS); `X-Request-Id` on every response.

## D-015 Two team roles: editor and viewer

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** Editors build, save, share, preview and upload. Viewers are read-only team members who
  can list, open and run every dashboard of their team. Authoring routes answer `403 forbidden` to viewers.
- **Consequences:** Roles come from the token today (`token:team:subject:role`), from SSO group claims later.

## D-016 Read-only sharing with scoped share tokens

- **Date:** 2026-11-10 · **Status:** Accepted · **Detail:** [`GUIDE.md`](GUIDE.md#sharing)
- **Context:** Developers must share saved dashboards with (a) independent applications that read the
  JSON and render or parse it themselves and (b) business users who just look.
- **Decision:** Editors create shares per dashboard with audience `app` (token for the API) or `viewer`
  (link to the hosted viewer). A share token (`bis_<id>_<secret>`) is read-only and confined to one
  dashboard: its JSON and its saved queries, nothing else (other dashboards 404, authoring 403). Shares
  can pin a version or follow the latest save, can expire, are revocable immediately, and record when they
  were last used. The token is shown once; only a SHA-256 hash is stored, compared in constant time.
  Viewer links carry the token in the URL fragment, which browsers never send to servers or logs.
- **Alternatives:** Named-user sharing (needs SSO first); public dashboards; signed URLs without revocation.
- **Consequences:** Anyone holding a viewer link can view that dashboard (see open questions). Share
  traffic counts against the owning team's limits and cache.

## D-017 A hosted viewer for business users

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** `apps/viewer`: a full-page, read-only page that takes only the share token, asks
  `GET /v1/share` what it grants, and renders the dashboard with controls built from its params. It sets
  `no-referrer` and `noindex`. It may be embedded in iframes (teams' portals).

## D-018 The SDK must not reload when a host passes a new `fetch`

- **Date:** 2026-11-10 · **Status:** Accepted
- **Context:** Shared links showed nothing: the viewer passed a new `fetch` function on every render,
  `<Dashboard>` rebuilt its data client, reloaded, re-rendered, and looped.
- **Decision:** `<Dashboard>` reads the transport through a ref, so a new function identity never
  reloads the dashboard. Any host writing `fetch={(...a) => …}` inline is now safe. Regression tests
  in the renderer and the viewer count requests.

## D-019 Keep the architecture; change the topology for 10,000+ users

- **Date:** 2026-11-10 · **Status:** Accepted; refined by D-020 to D-022
- **Context:** Review of whether the backend scales to 10,000+ concurrent Studio and dashboard users.
- **Decision:** The shape is right (stateless API, pushdown aggregation, one batched request per load,
  cache keyed on resolved queries, immutable versions). What had to change: no uploads on local disk, a
  shared cache across tasks, a Snowflake concurrency/cost plan (multi-cluster warehouses, Snowflake's
  result cache, extracts for hot dashboards), fewer database connections, SSO. Numbers were estimates;
  a load test (k6) is the way to confirm them.

## D-020 Minimum infrastructure: AWS ECS and Snowflake only

- **Date:** 2026-11-10 · **Status:** Accepted (owner's direction)
- **Decision:** Run the app as one ECS service and use Snowflake for every piece of data: the app's own
  records (D-021) and uploaded data (D-022). No RDS, no S3 bucket of ours, no Redis at first.
- **Consequences:** One data platform to secure and pay for. Every app read uses a Snowflake warehouse,
  which must be running while people use the app. Redis can be added later for a shared cache.

## D-021 The app's own records in Snowflake Hybrid Tables

- **Date:** 2026-11-10 · **Status:** Accepted (owner chose this over RDS Postgres)
- **Context:** Dashboards, versions, shares and upload metadata need transactional, low-latency storage.
  Standard Snowflake or Iceberg tables suit analytics, not frequent small reads and writes.
- **Decision:** Snowflake **Hybrid Tables** (`BI_STORE=snowflake`), created and migrated by the app on
  boot. Every table has an enforced primary key; foreign keys tie versions and shares to dashboards.
  Saves are optimistic (no `SELECT … FOR UPDATE` on hybrid tables): `UPDATE … WHERE latest_version = N`
  plus the version's enforced primary key. Sessions set `READ_LATEST_WRITES = TRUE` so a save on one
  task is visible on all others at once. Timestamps are UTC ISO strings and JSON is text, because
  `TIMESTAMP_TZ` and `VARIANT` cannot be keyed or indexed.
- **Alternatives:** RDS Postgres (implemented and tested; one more service); Iceberg tables for records
  (no constraints, a new snapshot per small write).
- **Consequences:** Hybrid tables need a non-trial account (GA on AWS and Azure commercial regions),
  allow about 16,000 operations/s and 2 TB per database, and are billed at a higher storage rate. Tested
  by running the stores' exact SQL against Postgres through an adapter; **not yet run against a live
  Snowflake account**. Postgres (`BI_STORE=postgres`) stays supported.

## D-022 Uploads become Snowflake-managed Iceberg tables

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** With `BI_UPLOADS=snowflake`, DuckDB still parses, types and profiles each upload
  in-process (no warehouse time), then the rows are exported as a normalized CSV, `PUT` to an internal
  stage, and turned into `CREATE ICEBERG TABLE … AS SELECT` with an explicit cast per column, on
  `EXTERNAL_VOLUME = 'SNOWFLAKE_MANAGED'` (Snowflake stores the files: no S3 bucket). Local copies are
  deleted. Queries on uploads run in Snowflake under an uploads role; teams' own roles get no grants,
  and the app's team-scoped upload records are the access check.
- **Alternatives:** S3 Parquet + DuckDB query workers (another service and bucket); INFER_SCHEMA from
  staged Parquet (less predictable types).
- **Consequences:** Uploads survive any number of ECS tasks; every upload query costs warehouse time
  (cached as D-012). Whether the Node.js driver supports `PUT` is not stated in Snowflake's docs: the
  live smoke test must include an upload.

## D-023 Stay on TypeScript and Node; no Go or Python backend

- **Date:** 2026-11-10 · **Status:** Accepted
- **Context:** Question: is Go or Python needed for scale and fast responses?
- **Decision:** No. A request spends about a millisecond in app code and 100 ms or more waiting on
  Snowflake; Node handles thousands of concurrent waiting requests per process. Speed comes from caching,
  warehouse sizing and batching. A second language would duplicate the spec validator (the top risk in
  the design doc). Production runs compiled code on plain `node` (D-026).

## D-024 One container serves the Studio, the viewer and the API

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** In production one process serves `/` (Studio), `/view/` (viewer), `/bi-api/*` (the API;
  the prefix is stripped before routing, so routes are identical to `/v1/*`) and `/healthz`. Hashed assets
  are cached for a year, HTML never. The Studio cannot be framed (`X-Frame-Options: DENY`); the viewer can.
  HTML is never served by the static handler, so its security headers cannot be skipped.
- **Alternatives:** S3 + CloudFront for the frontends (more infrastructure, CORS or path routing).
- **Consequences:** One ECS service, one target group, one hostname, no CORS. Teams' apps call
  `https://<host>/bi-api/v1/…`.

## D-025 Share links use the app's hostname, from an allowlist

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** With no explicit `BI_VIEWER_URL`, a viewer link is built from the request's host
  (`X-Forwarded-Proto` for the scheme behind the load balancer) **only if the host is in
  `BI_PUBLIC_HOSTS`**. A forged `Host` or `X-Forwarded-Host` header never ends up in a link.
- **Consequences:** Deploy on your domain, list it once, and links follow; no per-environment URL setting.

## D-026 Production runs a bundled server on plain Node

- **Date:** 2026-11-10 · **Status:** Accepted
- **Decision:** esbuild bundles the API and the workspace packages into `dist/server.mjs`; third-party
  runtime dependencies (DuckDB's native module, the Snowflake SDK, …) stay external and are installed in
  the image. Multi-stage Dockerfile on `node:22-bookworm-slim` (glibc for DuckDB), runs as the non-root
  `node` user, port 8080, health check on `/healthz`.
- **Alternatives:** Run TypeScript with `tsx` in production (slower start, dev tooling in the image).
- **Consequences:** The image (about 420 MB) was built and run locally in production mode, including an
  upload through DuckDB's Linux native module.

## D-027 Studio sign-in with access tokens until SSO

- **Date:** 2026-11-10 · **Status:** Accepted (temporary; replace with SSO)
- **Context:** Production refuses dev tokens and has no SSO yet, so the deployed Studio needs a login.
- **Decision:** Production builds have no built-in token. The Studio asks for an access token (an entry
  in `BI_TOKENS`, kept in Secrets Manager), checks it against the API, and keeps it in `sessionStorage`
  for that tab only. Any 401 returns the user to sign-in.
- **Consequences:** Tokens are shared secrets an admin hands out; rotation means editing the secret and
  redeploying. SSO (an OIDC `TokenVerifier`) replaces this.

## D-028 The product is named Sratchpad

- **Date:** 2026-11-10 · **Status:** Accepted (owner's choice)
- **Decision:** User-facing names, the root package, page titles, log lines, Docker image and ECS family,
  and Snowflake `application` / `QUERY_TAG` (`sratchpad:<team>`) say Sratchpad.
- **Kept as they are (renaming is churn, not value; revisit before publishing):** the `@yourorg/*`
  package scope (placeholder), the `BI_*` environment variable prefix, the repository folder
  `bi-platform/`, and Snowflake object names (`BI_APP`, `BI_UPLOADS_STAGE`, `bi_schema_migrations`).

## D-029 Documentation is part of every change

- **Date:** 2026-11-10 · **Status:** Accepted (owner's direction)
- **Decision:** Every change updates the docs it affects in the same change, every decision gets an
  entry here, and every change gets a line in [`CHANGELOG.md`](CHANGELOG.md). The rules for which doc
  covers what are in [`CLAUDE.md`](../CLAUDE.md).

## D-030 A styling layer in the spec (spec 1.2)

- **Date:** 2026-11-10 · **Status:** Accepted · **Detail:** [`SPEC.md`](SPEC.md#styling-spec-12)
- **Context:** Developers want to customize how dashboards look (and to ask the assistant for "any UI/UX
  change"), but spec 1.1 only had a few chart options; colors and chrome came from the host.
- **Decision:** Spec 1.2 adds an optional dashboard `theme` (mode, palette, accent, page and card
  backgrounds, card style, density, radius, font family), an optional widget `style` on every type
  (colors, background, emphasis, accent, title alignment, hide title) and chart options (`showGrid`,
  `dataLabels`, `axis` titles/hide/y range on line, bar, area; grid and axis on scatter). Every value is
  constrained (hex colors, enums, bounded numbers) and the renderer applies them only as scoped CSS
  custom properties, never as raw CSS. Version-gated like every addition: an error in a document claiming
  1.1, ignored with a warning by older readers.
- **Alternatives:** Free-form CSS per widget (a CSS-injection risk in every host app, and unportable);
  host-only theming (no per-dashboard looks).
- **Consequences:** Author-chosen colors are not checked for color-vision safety (the default palette
  is); backgrounds are checked for readable text (D-032). Additive: every 1.0/1.1 document is still valid.

## D-031 A chat assistant in the Studio that edits the draft through validated JSON Patches

- **Date:** 2026-11-10 · **Status:** Accepted · **Detail:** [`GUIDE.md`](GUIDE.md#the-assistant-chat)
- **Context:** Developers should be able to build and restyle dashboards by talking to the Studio.
- **Decision:** A chat panel in the Studio sends the conversation, the current **unsaved draft** and the
  selected widget to `POST /v1/assistant/chat` (editors only, own rate limit). The API runs Claude
  (`claude-opus-5-5`, effort medium, cached system prompt, server-side refusal fallbacks) with four tools:
  `update_dashboard` (RFC 6902 JSON Patch on the draft), `get_source_profile`, `list_sources`,
  `get_dashboard`. After every patch the draft is validated with the API's own validator; a patch that adds
  errors is rejected and the errors are sent back to the model to fix (pre-existing errors are tolerated).
  The spec reference in the prompt is **generated from the live zod schemas**, so the assistant knows
  exactly what the spec can express and learns new features automatically. The Studio applies an answer
  as one undo step and never over edits the developer made while it was working.
- **Safety:** It edits the draft only: it cannot save, share, upload or see other dashboards. It sees
  source profiles, never rows (as D-010). Patches cannot touch `__proto__`/`constructor` paths or replace
  the whole document. Model output is never executed. Requests for features the spec lacks are answered
  honestly with the closest alternative.
- **Alternatives:** Let the model return a whole new document (silently drops things; harder to review);
  high-level tools per action (`add_widget`, `set_color`, …) (a tool per feature; JSON Patch over a
  documented schema covers every current and future field).
- **Consequences:** Needs Anthropic credentials (`BI_ASSISTANT=auto|on|off`); off, the panel says so.
  A turn can take several seconds to tens of seconds. Not yet run against the live Claude API (tested with
  a scripted fake client).

## D-032 A dashboard's theme mode wins over the host's theme

- **Date:** 2026-11-10 · **Status:** Accepted
- **Context:** A dark theme background viewed in a light-mode host produced dark text on dark cards.
- **Decision:** `theme.mode` (`light` / `dark`) sets the dashboard's text and chrome and overrides the
  host's `theme` prop, because the author chose the colors for that mode. Validation warns
  (`low_contrast`) when a background's luminance and the mode disagree; the assistant is told to set the
  mode with backgrounds and is shown these warnings after each edit.

## D-033 Track capability gaps against Tableau and Qlik openly

- **Date:** 2026-11-10 · **Status:** Accepted · **Detail:** [`CAPABILITIES.md`](CAPABILITIES.md)
- **Decision:** Keep an honest list of what Sratchpad cannot build yet (calculations, interactivity, chart
  types, platform features) with a prioritized roadmap: calculated measures and period comparison first,
  then cross-filtering and drill-down.

---

## Open questions

| Question | Owner | Notes |
| --- | --- | --- |
| Which SSO provider (Cognito, Okta, Entra)? | Platform owner | Blocks replacing D-027; roles come from group claims |
| Should viewer links require a company login once SSO exists? | Platform owner | Today anyone with a link can view (D-016) |
| Is an external LLM acceptable for every team's data? | Data governance | `BI_AI=off` per deployment today; per-team switch not built |
| Snowflake warehouse model: per team or shared with quotas? | Platform owner | Affects cost attribution and concurrency (D-008, D-019) |
| A shared metric catalog ("revenue" defined once)? | Product | Each dashboard defines its own today |
| Exact global rate limits across tasks? | Platform owner | Per-task today (D-013) |
| Rename the `@yourorg` scope and `BI_*` prefix? | Owner | Deferred (D-028) |
| Which roadmap item first (calculations vs cross-filtering)? | Product | Proposal in `CAPABILITIES.md` |
