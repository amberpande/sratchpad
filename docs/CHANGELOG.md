# Sratchpad: changelog

What changed, newest first. One entry per change; link the decision (`D-NNN` in
[`DECISIONS.md`](DECISIONS.md)) when there is one. Keep "Not verified" honest: list what was only
tested with fakes.

## 2026-11-12

### Fix: Studio went blank after an assistant message (D-069)
- The assistant panel's scroll effect returned Chrome's `scrollIntoView` Promise, which React called as cleanup and
  crashed the whole page. Effects now return nothing; the assistant panel and inspector sit behind an error boundary
  with "Try again". Regression test added. Verified in headless Chrome (assistant reply shown, page intact).
  **Not verified:** Safari and Firefox (no crash expected; they return `undefined`).

### Llama 3.2 for local testing (D-068)
- `BI_LLM_PROVIDER=ollama` runs suggestion ranking and the Studio assistant on a local Ollama model (default
  `llama3.2`); refused in production. New `add_chart` assistant tool (all providers); compact prompt mode for local
  models; recovery of tool calls written as text; loop safeguards (empty edits end the turn, no JSON replies).
- Verified live with Llama 3.2: ranking (`rules+llm`, ~13 s); assistant added the requested chart in 3/3 runs and
  in multi-turn chats (~4 s per turn). **Known weak:** renames and styling (claims without editing, or extra edits).

### Spec 1.3: the capability gaps closed (D-034 to D-067)
Built by four workstreams on extension points laid by the lead (D-066), run one at a time after usage limits.
- **Calculations (D-034 to D-038):** calculated measures (expression AST compiled to SQL), bins and buckets,
  median/p25/p75/p90/stddev, window calcs (running total, % of total, rank, moving average, difference, % change /
  YoY), top-N with "Other", contains/starts_with/ends_with, joins within one engine type, team metric catalog.
  Studio Calculations section; fixed the Studio dropping 1.3 query fields on edit.
- **Interactivity and row-level security (D-039 to D-047):** cross-filtering, drill-down and drill-through, tabs,
  mobile layout, params multiselect (cascading), range, search, measure switch; row-level security from
  `BI_RLS_POLICIES` and token/share attributes, enforced in `runQuery`, fail closed. Postgres migration
  `006_share_attributes`; Snowflake `dashboard_shares.attributes`.
- **Visuals and formatting (D-048 to D-054):** map, heatmap, treemap, box plot, waterfall, funnel, gauge, bullet,
  sankey, combo/dual axis, image; number formats, conditional formats, KPI thresholds and comparison, reference
  lines/bands, annotations, tooltip fields, small multiples, table sparklines, click-to-sort; every chart reports
  clicks to the interaction engine. New example `viz_gallery`.
- **Platform (D-055 to D-064):** widget CSV/PNG export, print/PDF (also in the viewer), server CSV export; comments,
  favorites, usage; email subscriptions (SMTP/SES), data alerts (email, signed SSRF-safe webhooks), scheduled
  refresh, metric catalog storage and editor; lease-based scheduler; jobs run as their owner. Migrations Postgres
  `005_platform`, Snowflake `004_platform`. New config `SMTP_URL`, `SMTP_FROM`, `BI_SCHEDULER*`, `BI_WEBHOOK_*`.
- **Integration:** joins wired into `runQuery` with a fail-closed guard for row-secured sources (D-065); `empty_query`
  counts every output column; overlap warnings per tab; Studio drag keeps a widget's tab; platform writes share the
  writes rate limit (D-067); CORS allows PATCH; assistant reference lists the new params and interactivity fields and
  an updated "Not supported" list; fixed test flakes (share secret extraction, pinned migration lists); gauge arc
  cap overlap; taller example table.
- Verified: 474+ tests incl. Postgres and the Snowflake-on-Postgres adapter; DuckDB ≡ reference engine for every
  calculation; maps (world and US) and the gallery in dark mode in Chrome.
- **Not verified:** 1.3 SQL on a live Snowflake account (percentiles, windows, top-N subquery, `LIKE … ESCAPE`), real
  SMTP and webhook delivery, PNG export in a real browser, the image widget against a real host, platform tables on
  live Snowflake, row-level security on Snowflake/DuckDB-on-Snowflake sources.

## 2026-11-10

### Studio assistant, styling layer (spec 1.2) and capability review (D-030 to D-033)
- **Chat assistant** in the Studio (Assistant tab): builds and edits the draft by conversation, including
  layout and look and feel; one undo step per answer; never saves; never overwrites concurrent edits.
  API: `GET /v1/assistant`, `POST /v1/assistant/chat` (Claude tool loop with validated JSON Patch).
- **Spec 1.2** styling: dashboard `theme` (mode, palette, accent, backgrounds, card style, density,
  radius, font), widget `style`, chart `showGrid` / `dataLabels` / `axis`. Renderer applies them as scoped
  CSS custom properties. `low_contrast` validation warning; a theme's `mode` wins over the host theme.
- New `docs/CAPABILITIES.md`: what Sratchpad can build, gaps vs Tableau/Qlik, roadmap.
- Fixed while verifying visually: rotated y-axis titles overlapped tick labels.
- Verified: styled dashboard rendered in Chrome in light and dark pages. Not verified: the assistant
  against the live Claude API (scripted fake client only).

### Deployment: one container on AWS ECS (D-024 to D-027)
- `Dockerfile` (multi-stage, `node:22-bookworm-slim`, non-root, health check) and
  `deploy/ecs/task-definition.json` (Fargate, Secrets Manager, CloudWatch logs).
- Production serves the Studio (`/`), viewer (`/view/`) and API (`/bi-api/*`) from one process
  (`services/api/src/web.ts`); the API strips the `/bi-api` prefix before routing.
- API bundled with esbuild into `dist/server.mjs`, run with plain `node` (`npm run build -w @yourorg/bi-api`).
- Share links are built from the request host when it is in `BI_PUBLIC_HOSTS` (D-025).
- Studio sign-in with access tokens for production builds (D-027).
- Lockfile updated for the viewer workspace (no version changes).
- Verified: image built and run locally in production mode against Postgres, including an upload through
  DuckDB's Linux native module; production bundle smoke-tested (routes, headers, roles, share links).

### Naming and documentation (D-028, D-029)
- Product named **Sratchpad** in UI, root package, logs, image, Snowflake application name and query tags.
- Docs reorganized: `ARCHITECTURE.md`, `API.md`, `SPEC.md`, `GUIDE.md`, `DEPLOYMENT.md`, `DECISIONS.md`,
  this changelog; `CONTRACTS.md` folded into `API.md`; `design-doc.md` marked historical; `CLAUDE.md`
  added with the rule that docs change with the code.

### Uploads as Snowflake-managed Iceberg tables (D-022)
- `BI_UPLOADS=snowflake`: DuckDB parses and profiles, then CSV → `PUT` → `CREATE ICEBERG TABLE … AS SELECT`
  on `EXTERNAL_VOLUME = 'SNOWFLAKE_MANAGED'`; local copies deleted; queries run in Snowflake under the
  uploads role. Upload records gained `storage` and `table` (Postgres migration `004_upload_storage`).
- Not verified: live Snowflake round trip, in particular `PUT` from the Node.js driver.

### App records in Snowflake Hybrid Tables (D-021)
- `BI_STORE=snowflake`: dashboards, versions, shares and upload records in hybrid tables, migrated on boot;
  optimistic saves; `READ_LATEST_WRITES`. Store contracts shared across memory, Postgres and Snowflake.
- Verified: the stores' SQL against Postgres through an adapter (including concurrent saves).
  Not verified: a live Snowflake account.

### Sharing (D-015 to D-018)
- Roles `editor` / `viewer`; share tokens for apps and viewer links (pin, expiry, revoke, last used);
  hosted viewer app (`apps/viewer`); Share dialog in the Studio.
- Fixed: shared links showed nothing (reload loop when a host passed an inline `fetch`) (D-018).

### Recommendations and hardening (D-010 to D-014)
- `POST /v1/recommendations`: rule-built candidates, optional Claude ranking, assembled starter dashboard.
- Durations, scores and rates are averaged, never summed (D-011).
- Result cache, per-team rate limits and query gate, Prometheus metrics, JSON logs, request ids.
- Studio: fixed preview ignoring the configured network layer; Studio added to `npm run dev`.
- Not verified: live Claude API (fake client only).

## 2026-11-09

- Phase 1: spec v1/1.1, renderer SDK, versioned dashboard store, two host apps (D-001 to D-006, D-009).
- Phase 2: query layer: DuckDB uploads, Snowflake pushdown, profiler, draft preview (D-007, D-008).
- Phase 3: the Studio (drag-and-drop authoring).
