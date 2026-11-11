# Sratchpad: project instructions

Sratchpad is a self-service BI app: developers build dashboards (drag-and-drop or AI-suggested), each
stored as versioned JSON that renders in any team's React app, is readable by other apps, and can be
shared read-only. Production: one container on AWS ECS, Snowflake as the only data service.
Start with `README.md`, then `docs/ARCHITECTURE.md` and `docs/DECISIONS.md`.

## Keep the docs current (required, every change)

Documentation is part of the change, not a follow-up. In the same change as the code:

1. **Update every doc the change affects** (table below). If behavior, a route, a config var, a default,
   a limit or a "not verified" status changes, the docs must say so.
2. **Record decisions in `docs/DECISIONS.md`.** Any choice between alternatives (technology, design,
   security, defaults, naming, scope), whether the owner made it or you did, gets a new `D-NNN` entry:
   Date, Status, Context, Decision, Alternatives, Consequences, plus a row in the index. Never rewrite an
   old entry's substance; supersede it (`Superseded by D-NNN`) and add the new one. Move answered items
   out of "Open questions" (and add new open questions there).
3. **Add a line to `docs/CHANGELOG.md`** under today's date: what changed, the decision id, and what is
   **not verified** (e.g. tested only with fakes).
4. Keep the README status table and "not yet verified" line true.

| If you change… | Update |
| --- | --- |
| Components, flows, storage, security model, limits | `docs/ARCHITECTURE.md` |
| Routes, request/response shapes, roles, errors, SDK props | `docs/API.md` |
| The dashboard JSON, widget types, versioning, query semantics | `docs/SPEC.md` (and bump `specVersion` rules per the spec) |
| Anything a user sees in the Studio, viewer or sharing | `docs/GUIDE.md` |
| Env vars, defaults, Dockerfile, ECS, Snowflake setup | `docs/DEPLOYMENT.md` (configuration reference) |
| A capability added, or a gap vs Tableau/Qlik found or closed | `docs/CAPABILITIES.md` (and the roadmap there) |
| Any decision | `docs/DECISIONS.md` |
| Anything at all | `docs/CHANGELOG.md` |

`docs/design-doc.md` is the historical proposal: do not edit it beyond its header note.

## Commands

```bash
npm run dev          # API :4000, host apps :5173/:5174, Studio :5175, viewer :5176
npm test             # all suites (vitest workspace)
npm run typecheck
npm run build -w @yourorg/bi-api   # dist/server.mjs (esbuild); frontends: -w @yourorg/studio / @yourorg/viewer
docker build -t sratchpad .
```

Postgres-backed suites (dashboard/share/upload stores, Snowflake stores via the Postgres adapter) run
only with `TEST_DATABASE_URL`. Use a throwaway local cluster or container, never a real database.

## Invariants (do not break without a decision entry)

- **The spec is the contract** (`packages/spec`): one validator for every component; additive changes
  are minor bumps, removals/re-typing are major. Never duplicate the schema elsewhere.
- **Clients run only saved queries** (by id); the draft preview is editor-only.
- **Team isolation everywhere:** every store read is team-scoped, other teams' objects read as 404,
  cache keys include the team.
- **SQL only from the spec:** quoted identifiers, every value a bind parameter, only the validated
  `LIMIT` inlined. DDL uses server-generated names and quoted headers only.
- **Share tokens** are read-only, confined to one dashboard, stored as hashes, shown once, never logged.
- **AI** sees profile summaries only (never rows, ids or measure values), picks only rule-built
  candidates, and its absence or failure falls back to rules.
- **The Studio assistant edits drafts only** (never saves), through JSON Patch that must not add
  validation errors; its spec reference is generated from the schemas (`spec-reference.ts`), so new spec
  features need no prompt edits, but new *limits* belong in its "Not supported" list.
- **Styling values are constrained** (hex colors, enums, bounded numbers) and applied only as CSS custom
  properties. Never add free-form CSS to the spec.
- **Metrics labels** never contain team or dashboard ids.
- **Query semantics** match the reference engine (conformance suite).

## Conventions

- TypeScript everywhere; no second backend language (D-023).
- Naming: the product is "Sratchpad" (D-028). The `@yourorg/*` scope, `BI_*` env prefix, `bi-platform/`
  folder and Snowflake object names are intentionally unchanged.
- Snowflake facts (hybrid tables, Iceberg, driver behavior) change: check current Snowflake docs before
  relying on memory, and say what is unverified.
- Be honest in docs and reports about what was tested live versus with fakes.
