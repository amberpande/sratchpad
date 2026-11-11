# Sratchpad: changelog

What changed, newest first. One entry per change; link the decision (`D-NNN` in
[`DECISIONS.md`](DECISIONS.md)) when there is one. Keep "Not verified" honest: list what was only
tested with fakes.

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
