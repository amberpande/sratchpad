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
| [D-027](#d-027-studio-sign-in-with-access-tokens-until-sso) | Studio sign-in with access tokens until SSO | Superseded by D-074 |
| [D-028](#d-028-the-product-is-named-sratchpad) | The product is named Sratchpad | Accepted |
| [D-029](#d-029-documentation-is-part-of-every-change) | Documentation is part of every change | Accepted |
| [D-030](#d-030-a-styling-layer-in-the-spec-spec-12) | A styling layer in the spec (spec 1.2) | Accepted |
| [D-031](#d-031-a-chat-assistant-in-the-studio-that-edits-the-draft-through-validated-json-patches) | A chat assistant in the Studio that edits the draft through validated JSON Patches | Accepted |
| [D-032](#d-032-a-dashboards-theme-mode-wins-over-the-hosts-theme) | A dashboard's theme mode wins over the host's theme | Accepted |
| [D-033](#d-033-track-capability-gaps-against-tableau-and-qlik-openly) | Track capability gaps against Tableau and Qlik openly | Accepted |
| [D-034](#d-034-calculations-compile-from-an-ast-post-aggregation-work-stays-in-sql) | Calculations compile from an AST; post-aggregation work stays in SQL | Accepted |
| [D-035](#d-035-catalog-metrics-are-referenced-in-a-separate-metrics-list) | Catalog metrics are referenced in a separate `metrics` list | Accepted |
| [D-036](#d-036-ordered-window-calcs-require-a-total-order) | Ordered window calcs require a total order | Accepted |
| [D-037](#d-037-top-n-with-other-is-exact-and-text-only) | Top-N with "Other" is exact and text-only | Accepted |
| [D-038](#d-038-joins-same-engine-type-team-checked-attached-by-the-runner) | Joins: same engine type, team-checked, attached by the runner | Accepted |
| [D-039](#d-039-cross-filters-are-request-variants-checked-against-the-declared-surface) | Cross-filters are request variants checked against the declared surface | Accepted |
| [D-040](#d-040-drill-down-keeps-the-output-column-name) | Drill-down keeps the output column name | Accepted |
| [D-041](#d-041-drill-through-is-a-host-callback) | Drill-through is a host callback | Accepted |
| [D-042](#d-042-the-measure-switch-param-swaps-among-declared-alternatives-only) | The measure-switch param swaps among declared alternatives only | Accepted |
| [D-043](#d-043-cascading-choices-come-from-a-saved-query) | Cascading choices come from a saved query | Accepted |
| [D-044](#d-044-tabs-are-a-tab-on-layout-items) | Tabs are a `tab` on layout items | Accepted |
| [D-045](#d-045-row-level-security-is-enforced-in-runquery-and-fails-closed) | Row-level security is enforced in `runQuery` and fails closed | Accepted |
| [D-046](#d-046-share-links-carry-a-subset-of-the-creators-attributes) | Share links carry a subset of the creator's attributes | Accepted |
| [D-047](#d-047-mobile-layout-is-an-optional-per-widget-override) | Mobile layout is an optional per-widget override | Accepted |
| [D-048](#d-048-custom-number-formats-are-a-new-keyed-option-not-a-widened-format) | Custom number formats are a new keyed option, not a widened `format` | Accepted |
| [D-049](#d-049-new-visuals-reshape-and-lay-out-never-aggregate) | New visuals reshape and lay out, never aggregate | Accepted |
| [D-050](#d-050-author-colors-stay-hex-and-reach-css-only-as-custom-properties) | Author colors stay hex and reach CSS only as custom properties | Accepted |
| [D-051](#d-051-maps-bundle-public-domain-atlases-in-a-lazy-chunk) | Maps bundle public-domain atlases in a lazy chunk | Accepted |
| [D-052](#d-052-images-are-https-only-checked-twice) | Images are https-only, checked twice | Accepted |
| [D-053](#d-053-chart-interactions-go-through-one-helper) | Chart interactions go through one helper | Accepted |
| [D-054](#d-054-studio-only-required-slots-for-option-dependent-encodings) | Studio-only required slots for option-dependent encodings | Accepted |
| [D-055](#d-055-one-generic-platform-store-one-sql-implementation) | One generic platform store, one SQL implementation | Accepted |
| [D-056](#d-056-scheduler-leader-election-by-lease-row) | Scheduler leader election by lease row | Accepted |
| [D-057](#d-057-email-is-an-optional-smtp-endpoint) | Email is an optional SMTP endpoint | Accepted |
| [D-058](#d-058-subscription-links-are-short-lived-viewer-shares) | Subscription links are short-lived viewer shares | Accepted |
| [D-059](#d-059-webhooks-are-pinned-to-checked-addresses-at-connect-time) | Webhooks are pinned to checked addresses at connect time | Accepted |
| [D-060](#d-060-alerts-notify-on-transitions) | Alerts notify on transitions | Accepted |
| [D-061](#d-061-scheduled-refresh-is-cache-warming-not-extracts) | Scheduled refresh is cache warming, not extracts | Accepted |
| [D-062](#d-062-widget-exports-in-the-browser-csv-export-on-the-server) | Widget exports in the browser, CSV export on the server | Accepted |
| [D-063](#d-063-scheduled-jobs-run-as-their-owner) | Scheduled jobs run as their owner | Accepted |
| [D-064](#d-064-csv-exports-neutralize-spreadsheet-formulas) | CSV exports neutralize spreadsheet formulas | Accepted |
| [D-065](#d-065-joining-a-row-secured-source-is-refused-fail-closed) | Joining a row-secured source is refused (fail closed) | Superseded by D-079 |
| [D-066](#d-066-spec-13-built-through-extension-hooks-by-four-workstreams-one-at-a-time) | Spec 1.3 built through extension hooks by four workstreams, one at a time | Accepted |
| [D-067](#d-067-platform-writes-share-the-per-team-writes-budget) | Platform writes share the per-team writes budget | Accepted |
| [D-068](#d-068-llama-32-through-ollama-for-local-testing-only) | Llama 3.2 through Ollama for local testing only | Accepted |
| [D-069](#d-069-effects-never-return-values-panels-behind-error-boundaries) | Effects never return values; Studio panels behind error boundaries | Accepted |
| [D-070](#d-070-custom-sql-queries-for-developers-spec-14) | Custom SQL queries for developers (spec 1.4) | Accepted |
| [D-071](#d-071-custom-sql-runs-wrapped-and-isolated-per-engine) | Custom SQL runs wrapped and isolated per engine | Accepted |
| [D-072](#d-072-custom-sql-is-refused-where-row-level-security-applies) | Custom SQL is refused where row-level security applies | Accepted |
| [D-073](#d-073-the-assistant-never-writes-custom-sql) | The assistant never writes custom SQL | Accepted |
| [D-074](#d-074-single-sign-on-with-any-oidc-provider) | Single sign-on with any OIDC provider | Accepted |
| [D-075](#d-075-viewer-links-can-require-a-company-sign-in) | Viewer links can require a company sign-in | Accepted |
| [D-076](#d-076-global-rate-limits-through-the-shared-redis) | Global rate limits through the shared Redis | Accepted |
| [D-077](#d-077-ai-features-can-be-limited-to-listed-teams) | AI features can be limited to listed teams | Accepted |
| [D-078](#d-078-metric-catalog-history-and-owners) | Metric catalog history and owners | Accepted |
| [D-079](#d-079-row-level-security-on-joined-sources) | Row-level security on joined sources | Accepted |
| [D-080](#d-080-param-placeholders-in-custom-sql) | `{{param}}` placeholders in custom SQL | Accepted |
| [D-081](#d-081-trend-lines-and-forecasts-in-the-renderer) | Trend lines and forecasts in the renderer | Accepted |
| [D-082](#d-082-calendar-aware-period-comparison) | Calendar-aware period comparison | Accepted |
| [D-083](#d-083-row-level-calculated-fields) | Row-level calculated fields | Accepted |
| [D-084](#d-084-level-of-detail-as-a-two-pass-query) | Level of detail as a two-pass query | Accepted |
| [D-085](#d-085-k-means-clustering-on-scatter-plots) | k-means clustering on scatter plots | Accepted |
| [D-086](#d-086-reusable-value-sets) | Reusable value sets | Accepted |
| [D-087](#d-087-click-to-filter-in-the-studio-preview) | Click-to-filter in the Studio preview | Accepted |
| [D-088](#d-088-drill-on-any-query-dimension-including-the-series) | Drill on any query dimension, including the series | Accepted |
| [D-089](#d-089-show-or-hide-widgets-by-a-controls-value) | Show or hide widgets by a control's value | Accepted |
| [D-090](#d-090-brush-a-time-range-to-cross-filter) | Brush a time range to cross-filter | Accepted |
| [D-091](#d-091-keyboard-selection-of-chart-marks) | Keyboard selection of chart marks | Accepted |
| [D-092](#d-092-iso-country-codes-and-us-counties-on-maps) | ISO country codes and US counties on maps | Accepted |
| [D-093](#d-093-more-font-families-including-the-host-apps-own) | More font families, including the host app's own | Accepted |
| [D-094](#d-094-alert-snoozing-and-escalation) | Alert snoozing and escalation | Accepted |
| [D-095](#d-095-per-widget-usage-from-data-loads-and-interactions) | Per-widget usage from data loads and interactions | Accepted |
| [D-096](#d-096-pdf-reports-in-subscription-emails) | PDF reports in subscription emails | Accepted |

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

- **Date:** 2026-11-10 · **Status:** Superseded by D-074 (access tokens remain for service accounts)
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

## D-034 Calculations compile from an AST; post-aggregation work stays in SQL

- **Date:** 2026-11-11 · **Status:** Accepted · **Detail:** [`SPEC.md`](SPEC.md#calculations-spec-13)
- **Context:** Calculated measures, window calcs and top-N need user-written logic without injection risk and with identical results on every engine.
- **Decision:** A small expression grammar (numbers, `+ - * /`, parentheses, `abs`, `round`, `coalesce`, `nullif`, `least`, `greatest`, aggregate calls) parsed into an AST in the spec package and shared by validation, the reference engine and both SQL dialects. Calcs compile into the grouped SELECT over unrounded aggregates; windows into an outer SELECT; top-N into an IN-subquery. Numbers are binds; the only inlined numbers are validated integers engines don't accept as binds.
- **Alternatives:** Post-processing in JavaScript over aggregated rows (not pushdown); free SQL snippets (injection, not portable).
- **Consequences:** Results agree to 6 decimals across engines; every feature is in the conformance suite. No row-level expressions before aggregation (other than bins and buckets), no level-of-detail expressions.

## D-035 Catalog metrics are referenced in a separate `metrics` list

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Queries reference team metrics as `metrics: [{ metric, as? }]`, not `{ metric }` on a measure, so `Measure.field`/`agg` stay required and no consumer changes. The server expands them into measures or calcs before compiling (`data/metrics.ts`).
- **Consequences:** Metric and calc columns carry no `agg`, so additivity checks (pie) reject them.

## D-036 Ordered window calcs require a total order

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** For running total, moving average, difference and percent change, `order` plus `partition` must name every dimension (else engines could order ties differently). `offset` counts rows, not calendar periods (offset 12 on months = year over year).
- **Consequences:** A missing month shifts the comparison, as in Tableau's LOOKUP. Calendar-aware offsets are a known gap.

## D-037 Top-N with "Other" is exact and text-only

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** "Other" is re-aggregated from rows (CASE in GROUP BY), so averages, distinct counts and percentiles of "Other" are exact. Text dimensions only; a NULL group counts toward N and folds into "Other".

## D-038 Joins: same engine type, team-checked, attached by the runner

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** A query joins other data sources of the same dashboard by id (`joins`), only between sources of the same engine type. `runQuery` attaches their `{type, ref}`; engines re-check team visibility of every joined source exactly like the primary, so an attached ref grants nothing.
- **Consequences:** No cross-engine joins (for example an upload with a Snowflake table). Row-level security limits joins further (D-065).

## D-039 Cross-filters are request variants checked against the declared surface

- **Date:** 2026-11-11 · **Status:** Accepted
- **Context:** Clicking a chart must filter the others, yet clients may only run saved queries (D-004).
- **Decision:** The client sends a variant `{query, key, filters}`. The server accepts only `in`/`eq` on dimension fields of the dashboard's saved queries (or widget drill levels) on the same source, up to 10 filters of 100 scalar values, and only when `interactions.crossFilter` is on. Filters are appended before the cache, so cache keys include them.
- **Alternatives:** Free-form filters (unsafe); a param for every widget pair (unwieldy).
- **Consequences:** A click can only narrow results to values of declared dimensions.

## D-040 Drill-down keeps the output column name

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** `drill.levels[0]` must equal the query's first dimension. Level k replaces it with `levels[k]` under the original output name and adds a filter for each clicked value above it. The server derives the variant from the saved levels only.
- **Consequences:** Widget encodings keep working at every level. Only the first dimension drills.

## D-041 Drill-through is a host callback

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** `drillThrough` asks the host, through `<Dashboard onNavigate>`, to open another dashboard with mapped params.
- **Consequences:** Share tokens grant one dashboard, so viewer links can't drill through.

## D-042 The measure-switch param swaps among declared alternatives only

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** A `measure` param names the output column it swaps (`as`) and its options (`{value, field, agg}`); clients send only an option value; the swapped measure keeps the alias, so widgets don't change.

## D-043 Cascading choices come from a saved query

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** A multiselect's `optionsQuery` reads a column of a saved query through the normal data route; binding that query to another param narrows the choices. No new API; a param can't read options from a query it filters itself.

## D-044 Tabs are a `tab` on layout items

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** `tabs: [{id, title}]` plus `tab` on layout items; items without one go on the first tab. Only the open tab's widgets render and query. Overlap is checked per tab.

## D-045 Row-level security is enforced in `runQuery` and fails closed

- **Date:** 2026-11-11 · **Status:** Accepted · **Detail:** [`ARCHITECTURE.md`](ARCHITECTURE.md#security-model)
- **Context:** Every path that runs queries must be secured: dashboard data, previews, exports, alerts, subscriptions.
- **Decision:** A team policy (`BI_RLS_POLICIES`) maps a source column to a principal attribute (from the token now, from SSO later). It is applied inside `runQuery` after params, drill and cross-filters and before the cache. A principal without the attribute gets `rls_denied` and no rows; `*` means all rows; a malformed policy stops the server. Callers without a principal are denied on governed sources.
- **Alternatives:** Filtering in each route (easy to miss one); Snowflake row access policies (Snowflake-only, a role per user).
- **Consequences:** Background jobs must run as someone (D-063). Profiles are editor-only summaries over all rows and are not row-filtered.

## D-046 Share links carry a subset of the creator's attributes

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** A share stores the row-level security attributes it grants: the creator's own by default, or a narrower set; never more (403). Stored in Postgres migration `006_share_attributes` and the Snowflake `dashboard_shares.attributes` column.
- **Consequences:** A link keeps showing what was granted until it is revoked, even if the creator's access later shrinks.

## D-047 Mobile layout is an optional per-widget override

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** `mobileLayout` sets order, height and hiding for widgets when the grid stacks below 640 px; the default stays reading order.

## D-048 Custom number formats are a new keyed option, not a widened `format`

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** `options.numberFormats` keyed by result column, a constrained object (decimals, prefix, suffix, k/M/B scaling, percent, thousands), not format strings. It wins over the enum `format`.
- **Alternatives:** Making `format` accept objects (can't be version-gated; breaks 1.2 readers); ICU/Excel strings (unbounded).

## D-049 New visuals reshape and lay out, never aggregate

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Heatmap, sankey, treemap, waterfall, funnel, bullet and box plot require queries grouped by exactly their dimensions; the browser only positions aggregated rows. Waterfall offsets and funnel conversion ratios are display arithmetic, like stacking. A treemap drops its tail (with a note) instead of summing it into "Other".

## D-050 Author colors stay hex and reach CSS only as custom properties

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Conditional formats, KPI thresholds and map ramps set CSS custom properties from validated hex; SVG fills use validated hex or theme variables. Default scales use the first series color at rising opacity, so they follow light and dark themes.

## D-051 Maps bundle public-domain atlases in a lazy chunk

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** world-atlas (1:110m) and us-atlas (states 1:10m) with d3-geo, about 220 KB, loaded only when a dashboard has a map. Countries match by name, aliases or ISO numeric code; US states by name, FIPS or postal code; unmatched rows are counted in a note.
- **Consequences:** No ISO alpha-2/3 country codes, counties or custom geographies yet.

## D-052 Images are https-only, checked twice

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** The schema refuses non-https `src`/`href`; the renderer checks again, sends no referrer, and opens links with `noopener noreferrer`. `alt` is required.

## D-053 Chart interactions go through one helper

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Every chart uses `useMarks(field)` (wrapping the interaction contract), so selection, shift-click, the pointer cursor and dimming behave the same everywhere. Marks are selected by click; the table view remains the keyboard path.

## D-054 Studio-only required slots for option-dependent encodings

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** The spec keeps `map.region/value` and `bullet.category` optional (they depend on other options); the Studio fills them so every new widget starts valid. `combo.lines` is optional.

## D-055 One generic platform store, one SQL implementation

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Comments, favorites, subscriptions, alerts, refresh schedules and metric catalogs are team-scoped JSON records; usage is counters; the scheduler uses leases. Three tables (`platform_records`, `platform_counters`, `platform_leases`) with one portable SQL implementation for Postgres (`005_platform`) and Snowflake hybrid tables (`004_platform`), plus a memory store.
- **Alternatives:** A table per feature (twice the migrations); standard Snowflake tables (no keys or locking).
- **Consequences:** No queries inside the JSON; listing filters by id prefix (escaped `LIKE`).

## D-056 Scheduler leader election by lease row

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Every ECS task ticks (default 60 s); only the holder of the `scheduler` lease (expiry three ticks) runs due jobs.
- **Alternatives:** EventBridge Scheduler or SQS (new AWS services, against D-020); a separate worker service.
- **Consequences:** Jobs may run up to about three ticks late after a leader dies; at-least-once if a task crashes mid-run.

## D-057 Email is an optional SMTP endpoint

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** nodemailer with `SMTP_URL` (Amazon SES SMTP recommended). Without it, features keep working and record runs as not delivered.
- **Alternatives:** The SES API SDK (new dependency, AWS-specific).

## D-058 Subscription links are short-lived viewer shares

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Each email gets a new viewer share expiring after about 2.5 schedule intervals (3, 10 or 40 days); the previous one is revoked.
- **Alternatives:** One long-lived link (a leaked email would work forever).

## D-059 Webhooks are pinned to checked addresses at connect time

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Alert webhooks are https only, with no credentials in the URL and an optional host allowlist. Every resolved address is checked inside the socket's own lookup (no DNS-rebinding gap); private, loopback, link-local and similar ranges are refused; no redirects; timeout; signed with HMAC-SHA256 (`X-Sratchpad-Signature`, `X-Sratchpad-Timestamp`).
- **Alternatives:** Validate, then call `fetch` (it resolves again: rebinding risk).

## D-060 Alerts notify on transitions

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Only entering "firing" notifies, not every check. `change_pct` compares with the previous check's value.

## D-061 Scheduled refresh is cache warming, not extracts

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Scheduled refresh re-runs a dashboard's queries with the cache bypassed. No materialized copies; data stays live in Snowflake. True extracts and incremental loads remain a gap.

## D-062 Widget exports in the browser, CSV export on the server

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Widget CSV and PNG are made in the browser (exactly what the viewer saw); PDF through the browser's print dialog (no headless browser in the image); a server CSV export of one saved query for automation, through `runQuery` with the caller's principal.

## D-063 Scheduled jobs run as their owner

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Subscriptions, alerts and refresh capture the owner's subject, role and row-level security attributes when created and run as that principal through `runQuery`. Only editors create subscriptions, so emails show what an editor sees.
- **Consequences:** If the owner's access later shrinks, the job keeps the old attributes until it is recreated (open question).

## D-064 CSV exports neutralize spreadsheet formulas

- **Date:** 2026-11-11 · **Status:** Accepted
- **Decision:** Text cells starting with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'`, in browser and server exports.

## D-065 Joining a row-secured source is refused (fail closed)

- **Date:** 2026-11-11 · **Status:** Superseded by D-079
- **Context:** Row-level security filters a query's primary source; joins (D-038) bring in other sources.
- **Decision:** `runQuery` checks every joined source's access too: a missing attribute is `rls_denied`, and a joined source that would need row filters is refused rather than read unfiltered.
- **Consequences:** Joins with governed sources need future work (filters on joined relations).

## D-066 Spec 1.3 built through extension hooks by four workstreams, one at a time

- **Date:** 2026-11-10 to 2026-11-12 · **Status:** Accepted
- **Context:** Closing the capability gaps (D-033) touched the spec, renderer, Studio and API at once. Parallel agents risked overwriting each other; account usage limits stopped all four together.
- **Decision:** The lead added extension points (`query-ext`, `params-ext`, `dashboard-ext`, `widget-ext`, the interaction contract, widget menu and toolbar slots, a platform-routes hook, the metric-catalog contract), pinned new dependencies (d3-geo 3.1.1, topojson-client, world-atlas, us-atlas, d3-hierarchy 3.1.2, d3-sankey, nodemailer 10.2.1; only versions at least two weeks old) and gave each workstream exclusive files. After the usage limits, workstreams ran one at a time with integration between phases.
- **Consequences:** Every 1.3 feature is optional and version-gated; the validator and contracts stayed stable while four areas changed.

## D-067 Platform writes share the per-team writes budget

- **Date:** 2026-11-12 · **Status:** Accepted
- **Decision:** Comment, favorite, subscription, alert, refresh and catalog writes go through the same per-team `writes` rate limit as dashboard saves; reads are not limited.

## D-068 Llama 3.2 through Ollama for local testing only

- **Date:** 2026-11-12 · **Status:** Accepted (owner's request)
- **Context:** The owner wants to exercise the AI features locally without an Anthropic API key, using Llama 3.2.
- **Decision:** `BI_LLM_PROVIDER=ollama` (default `anthropic`) runs suggestion ranking and the Studio assistant on a
  local Ollama model (`OLLAMA_MODEL`, default `llama3.2`). Refused when `NODE_ENV=production`. Only the model call
  changes: `OllamaRanker` uses Ollama structured JSON output with the same prompt, compact profile and sanitizing;
  `OllamaAssistantClient` translates the assistant's Messages-shaped tool loop to Ollama `/api/chat` tools, so
  validation, "draft only" and "profiles, never rows" are unchanged. Data stays on the machine.
- **Made it work with a 3B model (verified live):** Llama 3.2 wrote tool calls as text, wandered in the long prompt
  and re-ran earlier requests. So: tool calls written as JSON text are recovered (known tools only, still validated);
  a `compact` prompt mode for local models (short directive instructions, source columns inline, latest request
  only, honest "No changes were made" note); a new `add_chart` tool (one simple chart built and validated by the
  server, available to every provider); and loop safeguards for every provider (an empty edit is "nothing to change",
  a turn ends after empty edits that follow a change, a JSON tool call is never shown as the reply).
- **Consequences:** With Llama 3.2 (3B), ranking works and adding simple charts is reliable (about 4 s per turn);
  edits and styling are unreliable (it may claim or wander). A larger local model (`OLLAMA_MODEL=llama3.1:8b`,
  `qwen2.5:7b`, …) should do better. Claude remains the production model.

## D-069 Effects never return values; Studio panels behind error boundaries

- **Date:** 2026-11-12 · **Status:** Accepted
- **Context:** The owner reported the whole Studio going blank shortly after sending an assistant message.
  Reproduced in real Chrome: the assistant panel's `useEffect(() => el.scrollIntoView(...))` returned the value of
  `scrollIntoView`, which current Chrome returns as a Promise. React treats an effect's return value as its cleanup
  and called it ("destroy is not a function"), and an uncaught render-phase error unmounts the whole app.
- **Decision:** Effects use block bodies so they return nothing (fixed in `AssistantPanel`, `QueryEditor`, renderer
  `context.tsx` and `DataTable`). A small `PanelBoundary` error boundary wraps the assistant panel and the inspector,
  so a future bug there shows "The … panel hit an error" with **Try again** instead of blanking the Studio; the draft is kept.
- **Alternatives:** A lint rule only (would not contain other panel crashes); one boundary around the whole app
  (would still lose the canvas view).
- **Consequences:** Regression test `apps/studio/test/assistant-crash.test.tsx` (scrollIntoView returning a Promise;
  boundary recovery). Verified in headless Chrome against the running app with Llama 3.2.

## D-070 Custom SQL queries for developers (spec 1.4)

- **Date:** 2026-11-12 · **Status:** Accepted (owner's request). Amends the "SQL only from the spec" invariant.
- **Context:** The owner wants developers to be able to write their own SQL for any chart, beyond what the visual
  query builder expresses (D-034 rejected "free SQL snippets" inside calcs; this is a whole-query mode instead).
- **Decision:** A query may carry `sql` (one SELECT, or WITH … SELECT, max 20,000 characters) and `columns` (the
  result columns widgets bind to: `name`, `role` dimension/measure, optional `type` string/number/time/boolean)
  instead of dimensions/measures/calcs/windows/topN/joins/metrics. Spec minor bump to **1.4** (additive). The query's
  `source` picks the engine; the SQL names the dashboard's data sources by id (`FROM orders`), and on Snowflake any
  table the team's role can read. Dashboard filters, cross-filters and the query's own filters apply to the result
  columns; a filter bound to a column the SQL does not declare is a validation error. Editors write SQL in the
  Studio's new **SQL** mode, which runs the draft and fills `columns` ("Run and detect columns"); viewers and share
  tokens only ever run saved SQL, like every saved query. `BI_CUSTOM_SQL=on|off` (default on) turns it off on every path.
- **Alternatives:** Saved SQL "data sources" (views) managed by an admin (safer, slower to iterate; still possible
  with Snowflake views); SQL fragments inside the visual builder (injection-prone, D-034); templated `{{param}}`
  placeholders in the SQL (deferred: filters apply to the result for now).
- **Consequences:** Drill-down, measure switches, top-N, calcs and the metric catalog do not apply to SQL queries.
  A filter on a column the SQL aggregated away cannot run (the validator says so). Charts read time columns
  without a grain (axis labels show dates). Older renderers render 1.4 documents degraded (D-004).

## D-071 Custom SQL runs wrapped and isolated per engine

- **Date:** 2026-11-12 · **Status:** Accepted
- **Context:** Free SQL from editors must not escape a team's data, change data, or run unbounded.
- **Decision:** The server never runs the SQL as written. It checks for a single statement (dialect-aware: strings,
  quoted names, comments) and runs it as a subquery of a statement it builds: dashboard sources as CTEs,
  `SELECT <declared columns> FROM (<sql>) WHERE <filters as binds> ORDER BY … LIMIT <validated n + 1>`. Inside a
  subquery anything but a query is a syntax error. Per engine:
  - **Snowflake:** runs under the team's role, so Snowflake grants decide what it reads. It requires an explicit team
    role that is not the app store role or the uploads role (those can read every team's records); otherwise
    `custom_sql_unavailable`. Sessions are pinned to `MULTI_STATEMENT_COUNT = 1`. Team roles should be SELECT-only.
  - **Local uploads and sample data:** a throwaway DuckDB per query with external access off, `allowed_paths`
    limited to the team's referenced upload files, extension autoload off and configuration locked before the SQL
    runs; prepared, so a second statement is refused. Error messages drop server file paths.
  - **Uploads stored in Snowflake:** refused. They are read with the shared uploads role, which sees every team's
    upload tables.
- **Alternatives:** Parsing SQL into an AST and allow-listing (large, dialect-specific, still bypassable); a
  per-team Snowflake role for uploads (more admin work; possible later to lift the uploads restriction).
- **Consequences:** Snowflake custom SQL depends on admins giving each team its own read-only role
  (`SNOWFLAKE_TEAM_CONFIG`). Statement timeout, per-team concurrency, row cap and result cache apply as for every
  query. Verified against DuckDB live; the Snowflake path only with a fake driver.

## D-072 Custom SQL is refused where row-level security applies

- **Date:** 2026-11-12 · **Status:** Accepted
- **Context:** Row-level security filters one source by a column (D-039..D-047). Free SQL can read any table the
  role sees and can rename or aggregate the secured column, so filtering its result is not sound.
- **Decision:** A custom SQL query is refused (`rls_denied`) for any principal that a team policy for that engine
  type would filter. A principal with `*` (all rows) on every such policy may run it. Fail closed, like D-065.
- **Alternatives:** Filtering the SQL's result by the secured column (bypassable); applying policies inside Snowflake
  with row access policies (the right long-term answer; needs per-user Snowflake identity).
- **Consequences:** Teams with row-level security use the visual builder (or Snowflake row access policies) until
  SSO and per-user Snowflake identity exist.

## D-073 The assistant never writes custom SQL

- **Date:** 2026-11-12 · **Status:** Accepted
- **Context:** The assistant edits drafts through JSON Patch; draft previews run immediately. SQL written by a model
  from a prompt is harder to review than visual query fields.
- **Decision:** Edits that add or change any query's `sql` or `columns` are rejected by the server (removing a SQL
  query with its widget is allowed); the prompt tells the assistant to point developers to the SQL mode.
- **Alternatives:** Letting the assistant draft SQL for review (useful; revisit with a "propose SQL" flow that the
  developer applies explicitly).
- **Consequences:** The assistant keeps building queries from dimensions, measures and calcs.

## D-074 Single sign-on with any OIDC provider

- **Date:** 2026-11-13 · **Status:** Accepted. Supersedes D-027 (tokens stay for service accounts).
- **Context:** SSO was the main unbuilt piece and the provider (Cognito, Okta, Entra) was undecided.
- **Decision:** Build against the OIDC standard, not a vendor: any provider works, so the choice no longer blocks
  the build. API: `OidcVerifier` (discovery, JWKS with rotation refetch, RS/PS/ES signatures via `node:crypto`, `iss`,
  `aud` or Cognito `client_id`, `exp`/`nbf` with 60 s skew; `alg: none` and HMAC never accepted). Team and role come
  from IdP groups through `OIDC_GROUP_MAP`; row-level attributes from claims (`OIDC_ATTRIBUTE_CLAIMS`); a user with no
  mapped group gets nothing. Static tokens are tried first (service accounts, local dev) and are optional in
  production once SSO is on. Browser: authorization code flow with PKCE (public client, no secret), ID token as the
  bearer (its `aud` is always the client id), kept in `sessionStorage`, renewed with a refresh token when issued;
  shared package `@yourorg/bi-auth-client`. `GET /auth/config` tells the Studio and viewer how to sign in.
- **Alternatives:** A vendor SDK per provider (lock-in); ALB OIDC authentication in front of ECS (no per-request
  team claims for the API, no token for host apps); access tokens as the browser bearer (their audience differs per
  provider).
- **Consequences:** The provider must put groups in the ID token (Cognito does by default as `cognito:groups`; Okta
  and Entra need a groups claim configured). A user in several teams lands in the first mapped team. Verified with
  fakes in tests and live in Chrome against a local mock provider; **not verified** against a real Cognito/Okta/Entra tenant.

## D-075 Viewer links can require a company sign-in

- **Date:** 2026-11-13 · **Status:** Accepted
- **Context:** Open question: anyone with a viewer link could view (D-016).
- **Decision:** `BI_VIEWER_LOGIN=on` (needs SSO) makes the API require, next to the share token, the viewer's own ID
  token in `X-BI-User` from the share's team; the viewer app runs the same PKCE sign-in first. Default `off` keeps
  links working for people outside SSO.
- **Alternatives:** Always require login (breaks sharing with people outside the company); per-share setting
  (useful later; one switch is simpler to reason about now).
- **Consequences:** App share tokens (host apps) are unaffected only when `off`; with `on`, host apps must forward a
  user token too.

## D-076 Global rate limits through the shared Redis

- **Date:** 2026-11-13 · **Status:** Accepted. Answers the open question on global limits (D-013).
- **Decision:** With `REDIS_URL` (the result cache's connection), per-team request limits count across every ECS
  task: a fixed one-minute window per (bucket, team) with `INCR`/`PEXPIRE`. Without Redis, or when Redis errors, the
  in-process token bucket applies (limits never take the API down). Concurrent-query gates stay per task: they bound
  that task's own connections.
- **Alternatives:** A sliding window or token bucket in Lua (smoother, more code); Snowflake counters (too slow per
  request); DynamoDB (a new AWS service).
- **Consequences:** A burst at a window edge can reach twice the limit for a moment. Needs Redis for exact limits
  (listed under "Not possible" without it).

## D-077 AI features can be limited to listed teams

- **Date:** 2026-11-13 · **Status:** Accepted. Answers the open question on external LLMs per team.
- **Decision:** `BI_AI_TEAMS=team-a,team-b` limits the model-backed features to those teams: others get rule-based
  suggestions (the model is never called) and the assistant reports `ai_disabled_for_team`. Unset = every team.
- **Alternatives:** A per-team setting in the database (needs an admin UI); per-source flags (finer, harder to audit).
- **Consequences:** Data governance can approve the external model team by team.

## D-078 Metric catalog history and owners

- **Date:** 2026-11-13 · **Status:** Accepted
- **Context:** Catalog edits overwrote the definition and any editor could change shared metrics.
- **Decision:** Every save and delete of a catalog metric is kept as a version (who, when, definition):
  `GET /v1/metrics-catalog/:name/history`; the Studio's catalog shows it with **Restore**. `BI_METRIC_OWNERS`
  (`{"team-a": ["ana@example.com"]}`) limits changes to the listed subjects per team; teams not listed keep the old
  behavior (every editor).
- **Alternatives:** A review/approval workflow (more process than teams asked for); a new "metric owner" role in tokens
  and SSO groups (possible later; a subject list needs no IdP change).
- **Consequences:** Changes still apply to every dashboard immediately, but are attributable and reversible.

## D-079 Row-level security on joined sources

- **Date:** 2026-11-13 · **Status:** Accepted. Supersedes D-065.
- **Decision:** Each joined source's row filters apply to its own columns (`"<sourceId>.<column>"`) in WHERE, after the
  join, on every engine. Joined rows the principal may not see never contribute; a left-joined row that only matched
  hidden rows is dropped (results can only narrow). A principal missing a joined source's attribute is still refused.
- **Alternatives:** Filtering inside the join (keeps unmatched primary rows with NULLs: more faithful to the left join,
  but more SQL shapes to test); keep refusing.
- **Consequences:** Joins work for governed teams. Cross-engine joins remain impossible (see CAPABILITIES "Not possible").

## D-080 `{{param}}` placeholders in custom SQL

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Custom SQL may name dashboard params: `{{p}}` (select/search; a list expands to `?, ?, …` for `IN (…)`),
  `{{p.from}}` / `{{p.to}}` (date range, inclusive, as DATE), `{{p.low}}` / `{{p.high}}` (range). Each becomes a bind
  parameter, never text; an empty value binds NULL. Unknown names are validation errors. Params no longer need a
  binding (`bind: []` is valid) so a control can feed only placeholders; an unused param is a warning.
- **Alternatives:** Only outer filters on the result (could not filter before aggregation); string templating
  (injection).
- **Consequences:** Placeholders inside string literals are not supported (write them outside quotes). A param used
  as a placeholder should not also be bound to the same query.

## D-081 Trend lines and forecasts in the renderer

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Line charts take `options.trend` (`linear` or `moving_average`, optional `forecast` periods), computed in
  the browser from the aggregated rows: least squares over equally spaced periods, a 95% prediction band for
  forecasts. Dashed lines, a light band, never part of the data or exports.
- **Alternatives:** Snowflake ML forecasting (warehouse cost; Snowflake only); exponential smoothing (better for
  seasonality; more parameters to explain).
- **Consequences:** Forecasts assume a straight-line trend; seasonality is not modelled.

## D-082 Calendar-aware period comparison

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** `difference` / `percent_change` windows with `calendar: true` compare with the row whose order date is
  `offset` periods earlier (same partition), joining the grouped rows to themselves on the shifted date in SQL (a CTE),
  and by date in the reference engine. Missing periods stay missing instead of shifting the comparison.
- **Alternatives:** Densifying the time axis (adds rows the author did not ask for); RANGE window frames (not portable).
- **Consequences:** Needs the order dimension to have a grain. Conformance-tested on DuckDB; Snowflake SQL only by shape.

## D-083 Row-level calculated fields

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Queries take `fields: [{ as, expr }]`: numeric expressions over one row's columns with the calc grammar
  (no aggregations) plus `year`, `quarter`, `month`, `day`, `weekday` of a date column. A field is used by name as a
  dimension, measure, filter or inside calcs; earlier fields can be referenced. SQL inlines only parsed numeric
  literals (like `round` digits); everything else is quoted columns.
- **Alternatives:** String functions (`upper`, `concat`) now (needs typed expressions; next step); free SQL fragments
  (rejected, D-034).
- **Consequences:** String row-level functions remain a gap; custom SQL covers them meanwhile.

## D-084 Level of detail as a two-pass query

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** `detail: { dimensions, measures }` aggregates first at the query's dimensions plus the detail dimensions
  (Tableau INCLUDE), then the query's measures aggregate those named results. Implemented by running the same compiler
  twice (inner pass without ORDER/LIMIT); filters on detail measures run in the outer pass. Conformance-tested.
- **Alternatives:** FIXED/EXCLUDE semantics (FIXED ignores the view's dimensions; EXCLUDE is covered by
  `percent_of_total` partitions); window functions at row level (wrong weights for non-additive outer aggregates).
- **Consequences:** No catalog metrics with `detail` yet; one detail level per query.

## D-085 k-means clustering on scatter plots

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Scatter `options.cluster: { k }` colors points by k-means on scaled (x, y), deterministic seeding and
  stable cluster numbering so every viewer sees the same groups. Computed in the browser over the plotted rows.
- **Alternatives:** Server-side or Snowflake ML clustering (more dimensions; heavier); random seeding (unstable colors).
- **Consequences:** Two dimensions only; up to the plotted rows (query limit).

## D-086 Reusable value sets

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** A dashboard's `sets` name lists of values of one column (`top customers`). A dimension with `set` groups
  values into the set's label and "Other"; a filter with `set` and `in` / `not_in` uses the list. The server expands
  sets into buckets and lists before execution, so every engine runs features it already supports.
- **Alternatives:** Dynamic sets (top N by a measure: covered by `topN`); team-level sets in the catalog (later, like
  metrics).
- **Consequences:** Sets are static lists edited in the JSON view.

## D-087 Click-to-filter in the Studio preview

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** The Studio's preview client sends cross-filter and drill variants as their own entries (like the SDK's
  client), keyed and cached by variant, so clicks behave in the Studio as in the viewer.
- **Consequences:** The server already validated variants on the preview route; no server change.

## D-088 Drill on any query dimension, including the series

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** `drill.dimension` (default 0) picks which query dimension drills; line and bar charts report clicks on a
  series (line or bar of that series) with the series value. With `dimension` set, only clicks on that dimension's
  marks drill.
- **Consequences:** Charts that have no series still drill on the x axis only.

## D-089 Show or hide widgets by a control's value

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Widget `visibleWhen: { param, is: set | empty | in, values? }`. A hidden widget runs no query and leaves its
  grid space empty; the Studio canvas always shows it so authors can edit it.
- **Alternatives:** Collapsing the space (moves other widgets as controls change: disorienting); container widgets
  (larger layout change).

## D-090 Brush a time range to cross-filter

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Dragging across a line chart's time axis selects every bucket from start to end; other widgets get a
  `between` cross-filter (`>= start`, `< next bucket after end`), validated like other cross-filters.

## D-091 Keyboard selection of chart marks

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Interactive charts get a keyboard toolbar of their values (hidden until focused): arrow keys move, Enter
  or Space selects (Shift adds), announced politely. Same effect as clicking a mark.
- **Alternatives:** Focusable SVG marks (chart-library specific, many tab stops).

## D-092 ISO country codes and US counties on maps

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** World maps also match ISO 3166-1 alpha-2 and alpha-3 codes (table in the renderer). A `usa-counties`
  basemap (us-atlas counties) matches 5-digit FIPS codes or "County, ST"; it loads on demand (≈800 KB) behind the
  widget's loading state, so other dashboards do not download it.
- **Consequences:** Other custom geographies (sales territories) remain a gap.

## D-093 More font families, including the host app's own

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Theme fonts add `inherit` (the host app's font, for embedded dashboards) and humanist, geometric, slab
  and condensed stacks of fonts already installed on users' systems. Still an enum: no URLs, no free CSS (D-030).
- **Alternatives:** Web font URLs (network requests and CSP changes in every host app).

## D-094 Alert snoozing and escalation

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** `POST /v1/alerts/:id/snooze {minutes}` silences notifications (checks and state continue; 0 unsnoozes).
  `escalateAfterMinutes` + `escalateTo`: when an alert is still firing that long after it fired, the escalation list is
  emailed once per firing episode. Studio: Snooze menu, escalation fields.

## D-095 Per-widget usage from data loads and interactions

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** The saved-dashboard data route counts loads per query, and cross-filter or drill variants as
  interactions; `/v1/dashboards/:id/usage` reports them per widget (widgets sharing a query share its numbers). Studio:
  **Usage** dialog.
- **Alternatives:** Client-side events per widget (more traffic, spoofable by any client).

## D-096 PDF reports in subscription emails

- **Date:** 2026-11-13 · **Status:** Accepted
- **Decision:** Subscriptions take `attachPdf`: a text PDF (title, KPIs, each selected widget's data as a table, up to 200
  rows) built by a small writer with the built-in PDF fonts. No headless browser and no dependency.
- **Alternatives:** Chromium in the container to print the dashboard (pixel-perfect charts; a much larger image and
  more attack surface).
- **Consequences:** Charts are not drawn in the PDF (the email links to the dashboard); non-Western characters print as
  "?" with the built-in fonts.

---

## Open questions

| Question | Owner | Notes |
| --- | --- | --- |
| Which SSO provider (Cognito, Okta, Entra)? | Platform owner | No longer blocks the build (D-074 works with any OIDC provider); still needed to deploy |
| Should viewer links require a company login? | Platform owner | Switch built (`BI_VIEWER_LOGIN`, D-075); default off |
| Is an external LLM acceptable for every team's data? | Data governance | Per-team switch built (`BI_AI_TEAMS`, D-077); which teams is the open part |
| Snowflake warehouse model: per team or shared with quotas? | Platform owner | Affects cost attribution and concurrency (D-008, D-019) |
| A shared metric catalog ("revenue" defined once)? | Product | Each dashboard defines its own today |
| Rename the `@yourorg` scope and `BI_*` prefix? | Owner | Deferred (D-028) |
| Should scheduled jobs refresh the owner's row-level attributes instead of keeping them from creation? | Platform owner | Needs an identity source (SSO) or an expiry (D-063) |
| Should custom SQL work with row-level security (Snowflake row access policies) and on uploads stored in Snowflake (per-team uploads role)? | Platform owner | Refused today (D-071, D-072) |
