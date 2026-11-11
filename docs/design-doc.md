> **Historical document.** This is the original design proposal (Nov 9, 2026) that Sratchpad was built
> from. It is kept unchanged as a record. For the system as built see [`ARCHITECTURE.md`](ARCHITECTURE.md),
> and for every decision since, including where this proposal was changed (e.g. Snowflake-only storage
> instead of Postgres/S3/Redis, D-020 to D-022), see [`DECISIONS.md`](DECISIONS.md).

# AI-Powered Self-Service BI Platform — Architecture

Nov 9, 2026 · @Amber Pande

A self-service BI tool where developers either drag-and-drop widgets or attach a CSV/Excel file or Snowflake table and get AI-recommended dashboards; one shared backend serves every team, and each dashboard's UI is stored as JSON so it renders plug-and-play inside independent React host apps.

## Goals & scope

The tool lets a developer build a dashboard in one of two ways, and renders the result anywhere. If they know what they want, they drag-and-drop widgets onto a canvas. If they don't, they attach a CSV/Excel file or connect a Snowflake table or view, and the tool profiles the data and recommends charts and a starter dashboard. Either way the dashboard is saved as a JSON document that any of the team's own React apps can render with no code changes.

**Primary users** are developers on your teams embedding analytics into their own apps — not analysts in a standalone BI portal. That shapes every decision below: the renderer must be a drop-in React component, the contract must be stable, and the backend must be multi-tenant so one deployment serves every team.

**Non-negotiable principles**

1. **One shared backend, many host apps.** A single backend owns data connections, query execution, dashboard storage, and AI. Host apps only render JSON and ask the backend for data.
2. **UI as data, not code.** A dashboard is a versioned JSON document. Nothing about a dashboard is compiled into a host app, so a change ships without a host-app release.
3. **The renderer is plug-and-play.** A host app installs one SDK, drops in one component with a dashboard id and an auth token, and a dashboard appears.
4. **AI assists, never blocks.** Recommendations are suggestions a developer accepts, edits, or ignores. The manual drag-and-drop path never depends on the AI service being up.
5. **Fast by construction.** Aggregation happens in the data layer, not the browser. The renderer receives small, already-summarized result sets.

**Out of scope for v1 (call these out now):** scheduled report emailing, row-level security policies per end-user, write-back to source systems, and real-time streaming dashboards. Each is a deliberate later phase, not an oversight.

## Architecture at a glance

Two kinds of client talk to one shared backend through a single gateway. The authoring app saves dashboard JSON; host apps fetch that JSON and then request data for each widget. Inside the backend, four services divide the work, and all data access bottlenecks through the query/semantic layer so no client ever touches a raw connection.

> **Diagram:** system architecture · clients, shared backend, data layer — interactive diagram in the [live doc](https://claude.ai/artifact/XpKVxV9HeXBkNfRdrPmL4E).

The arrow from the AI service back to the query layer matters: recommendations are generated from real profiled data and sample aggregates, not from column names alone.

## The JSON dashboard spec

This schema is the one contract every part of the system shares, so it is the decision most worth getting right. Authoring writes it, the store versions it, and every host app renders it. If it changes carelessly, every embedding app breaks at once.

Keep three concerns separate inside the document: **layout** (where widgets sit), **widgets** (what each one is and how it looks), and **queries** (what data each one needs, declared not as SQL but as a semantic request the query layer compiles). Decoupling the query from raw SQL is what lets the same dashboard run against an uploaded CSV or a Snowflake view unchanged.

```json
{
  "specVersion": "1.0",
  "id": "dash_9f2a",
  "title": "Sales overview",
  "dataSources": {
    "orders": { "type": "snowflake", "ref": "ANALYTICS.PUBLIC.ORDERS" }
  },
  "queries": {
    "q_rev_by_month": {
      "source": "orders",
      "dimensions": [{ "field": "order_date", "grain": "month" }],
      "measures": [{ "field": "amount", "agg": "sum", "as": "revenue" }],
      "filters": [{ "field": "status", "op": "eq", "value": "paid" }],
      "orderBy": [{ "field": "order_date", "dir": "asc" }],
      "limit": 1000
    }
  },
  "widgets": {
    "w_line": {
      "type": "line-chart",
      "query": "q_rev_by_month",
      "encoding": { "x": "order_date", "y": "revenue" },
      "options": { "title": "Revenue by month", "format": { "y": "currency" } }
    },
    "w_kpi": {
      "type": "kpi",
      "query": "q_rev_by_month",
      "options": { "reduce": "sum", "field": "revenue", "label": "Total revenue" }
    }
  },
  "layout": [
    { "i": "w_kpi",  "x": 0, "y": 0, "w": 3, "h": 2 },
    { "i": "w_line", "x": 3, "y": 0, "w": 9, "h": 4 }
  ],
  "params": {
    "dateRange": { "type": "daterange", "default": "last_90d", "bind": ["q_rev_by_month.filters"] }
  }
}
```

**Why this shape**

- **Widgets reference queries by id**, so two widgets share one query and one round-trip. A KPI and a line chart off the same numbers hit the data layer once.
- **Queries are semantic, not SQL.** `dimensions` / `measures` / `filters` compile to Snowflake SQL or a DuckDB query. Host apps and authoring never see SQL, and the same spec is portable across sources.
- **`params` are dashboard-level controls** (date range, filters) bound into queries, so one date picker re-filters every widget without rewriting them.
- **Layout is a grid** (the react-grid-layout shape), which drag-and-drop writes directly and the renderer reads directly.

**Versioning is the discipline that keeps this safe.** `specVersion` is explicit. The renderer SDK supports a range of versions and refuses or down-level-renders anything outside it, so a host app on an older SDK degrades predictably instead of crashing. Treat added optional fields as minor (backward-compatible) and any removed or re-typed field as a major bump requiring a renderer release. A registry of widget `type`s with their option schemas should be the source of truth both authoring and the renderer validate against.

## Rendering & embedding model

A host app embeds a dashboard with one component. The SDK fetches the JSON, validates its `specVersion`, resolves each widget's query through the backend, and renders. Everything else is internal.

```jsx
import { Dashboard } from '@yourorg/bi-renderer';

<Dashboard id="dash_9f2a" token={authToken} params={{ dateRange: 'last_30d' }} />
```

**Inside the renderer**

1. A **widget registry** maps each `type` string to a React component (`line-chart`, `bar-chart`, `kpi`, `table`, `pivot`, `text`). Registering a new widget type is how the catalog grows; the registry is shared by authoring and renderer so they never drift.
2. A **layout engine** reads the grid array and places widgets responsively. The same grid model backs drag-and-drop in authoring, so what you build is what renders.
3. A **data client** batches the widgets' query requests, dedupes shared queries, caches results, and streams each widget its small aggregated result set. Widgets render skeletons until their data lands, so one slow query never blocks the rest.

**Keeping it fast**

- **The browser never aggregates.** Result sets are already grouped and limited by the data layer, so a widget renders tens to hundreds of rows, not millions.
- **One batched round-trip per dashboard load**, not one request per widget, cutting latency on dense dashboards.
- **Virtualize** long tables and pivots so a 10,000-row result renders only what's visible.
- **Code-split widget types** so a host app ships only the chart libraries its dashboards use.
- **Cache at two layers**: the backend caches hot query results (keyed by the semantic query + params), and the SDK caches in-memory per session so re-renders and param tweaks are instant.
- **Pick a charting core deliberately.** A lightweight library (e.g. Recharts or a thin ECharts/visx wrapper) keeps bundle size and render cost down versus a heavy all-in-one. This choice is worth prototyping against your real widgets before committing.

## Data & query layer

The query/semantic layer is the single place that turns a dashboard's declarative query into real execution. It takes the `dimensions` / `measures` / `filters` from the spec plus runtime `params`, compiles them for the right engine, pushes the aggregation down to where the data lives, and returns a small result. Two engines sit behind it.

**Uploaded files (CSV / Excel) — DuckDB.** On upload, the file is parsed and loaded into a columnar store (DuckDB or Parquet on object storage). DuckDB runs analytical aggregation in-process at high speed, so a 1M-row CSV is grouped server-side and the browser sees only the summary. The upload step also runs the profiler (below). Store the parsed columnar copy, not the original file, as the query target.

**Snowflake — pushdown, never extract.** The connector lists schemas, tables, and views the team's credentials can see; the developer picks one. Queries compile to Snowflake SQL and run *in* Snowflake — the backend never pulls the table into memory. Use a connection pool and a per-team warehouse/role so cost and access stay attributable. Enforce `LIMIT` and sane defaults so an accidental unbounded scan can't run up a bill.

**The metadata profiler** runs once per source and feeds both the AI and the authoring UI:

- **Per column**: inferred type (numeric / categorical / temporal / boolean / id / geo), null rate, distinct count / cardinality, min-max-range for numerics, sample values, and detected formats (currency, percent, dates).
- **Per table**: row count, candidate time columns, candidate measures (high-cardinality numerics) vs dimensions (low-cardinality categoricals), and likely keys.
- Profiling samples rather than scans the full table on Snowflake, to stay cheap.

**Guardrails that belong here, not in the client:** query cost limits and timeouts, result-size caps, SQL built only from the semantic spec (never string-concatenated user input, so no injection), and per-team isolation on every connection. Centralizing this is the main payoff of the shared backend — every host app inherits the same safety for free.

## AI recommendation engine

When a developer attaches a file or picks a Snowflake table, the engine turns the profiled metadata into ranked, explained chart suggestions and a starter dashboard — all expressed as the same JSON spec, so a recommendation is just a dashboard they can keep editing.

> **Diagram:** AI recommendation flow · profile → classify → generate → rank → assemble → review — interactive diagram in the [live doc](https://claude.ai/artifact/XpKVxV9HeXBkNfRdrPmL4E).

**How the stages work**

- **Classify fields** from the profiler: a low-cardinality categorical is a dimension, a high-cardinality numeric is a measure, a date column is a time axis. This is deterministic rules, not the LLM.
- **Generate candidates** by matching classified fields to a small library of analytic patterns: measure over time → line; measure by dimension → bar; one measure → KPI; two measures → scatter; distribution → histogram. Each candidate carries a ready semantic query.
- **Rank + explain with Claude.** The LLM gets the compact profile (not raw rows) plus the candidate list, and returns an ordered selection with one-line rationales ("revenue trends monthly; show it first"). Sending summaries, not data, keeps it cheap and keeps source rows out of the prompt.
- **Assemble** the top candidates into a laid-out dashboard JSON; **the developer reviews** and edits in drag-and-drop.

**Design choices worth noting:** keep deterministic logic (classification, candidate generation, query building) outside the LLM so results are reproducible and the system degrades gracefully if the AI is down — you still get rule-based suggestions. Use the LLM for judgment (ordering, titles, narrative), where it adds the most and errors are low-stakes. Never put raw data rows in the prompt; profiled summaries are enough and far safer.

## Build vs buy & tech choices

The differentiators — the JSON spec, the embeddable renderer, the AI layer — are worth building. The commodity infrastructure — a query engine, a columnar store — is worth adopting. Building the whole BI stack from scratch (like rebuilding Superset) would sink the project before the parts that make it distinct ever ship.

| Subsystem | Recommendation | Lean on | Why |
| --- | --- | --- | --- |
| JSON dashboard spec | **Build** | — | This is the product's core contract; no off-the-shelf schema fits the embed-anywhere goal |
| Renderer SDK | **Build**, on a chart lib | Recharts / ECharts / visx | The plug-and-play embedding is a differentiator; the chart primitives are not |
| Query / semantic layer | **Buy/adopt or build thin** | Cube, or a custom compiler | Cube gives a semantic layer + caching; a thin custom compiler keeps control if needs are narrow |
| File (CSV/Excel) engine | **Adopt** | DuckDB | Best-in-class in-process analytics; do not hand-roll aggregation |
| Snowflake connectivity | **Adopt driver** | Official Snowflake SDK + pool | Use the vendor driver; build only the semantic-to-SQL compile |
| AI recommendations | **Build** on an LLM API | Claude API | Orchestration and the candidate library are yours; the model is called, not built |
| Dashboard storage | **Adopt** | Postgres (JSONB) | Versioned JSON documents fit a relational store with JSONB cleanly |
| Results cache | **Adopt** | Redis | Standard; key on semantic query + params |
| Auth / multi-tenancy | **Adopt** | Your existing IdP / OIDC | Reuse the org's identity; add per-team scoping in the gateway |

**A note on "competing with Tableau/Qlik":** do not try to match their breadth of visualizations and governance in v1. Win on the two things they do poorly for your users — *embeddability* (UI as portable JSON dropped into any React app) and *AI-assisted authoring from raw data*. A focused tool that nails those beats a feature-parity clone that ships in two years.

## MVP roadmap

Sequence by what each phase *proves*, not by feature count. The first phase that must work is the contract and the renderer — everything else builds on them. Each phase gates the next.

1. **Phase 1 — The contract renders.** Finalize v1 of the JSON spec, build the renderer SDK with a handful of widget types (KPI, line, bar, table), and the dashboard store. *Proves:* a hand-written JSON renders identically in two different host apps. No authoring UI, no data layer yet — feed it static sample data.
2. **Phase 2 — Real data, pushed down.** Add the query/semantic layer with the DuckDB file path first (upload CSV → profile → query), then Snowflake. *Proves:* a widget shows live aggregated data from a 1M-row file without the browser slowing down.
3. **Phase 3 — Drag-and-drop authoring.** Build the canvas: a field panel from the profiler, draggable widgets, the grid layout, param controls. Saves the same JSON the renderer reads. *Proves:* a developer builds and embeds a dashboard with no code.
4. **Phase 4 — AI recommendations.** Add the profiler-to-candidate pipeline and the Claude ranking step. *Proves:* attach a file or table and get a useful starter dashboard that's fully editable afterward.
5. **Phase 5 — Harden & scale.** Caching, cost guardrails, more widget types, spec versioning discipline, observability, and the out-of-scope items from Goals as they earn priority.

**Gate between every phase:** the JSON spec stays backward-compatible, or the version bumps and the renderer handles both. Breaking the contract silently is the one failure mode that hurts every host app at once.

## Risks & open questions

- **Spec churn breaks host apps.** The biggest risk. Mitigation: freeze v1 scope small, version explicitly, and give the renderer a compatibility range from day one.
- **Snowflake cost runaway.** Self-service + a shared warehouse can produce expensive scans. Open question: per-team warehouse vs shared with quotas? Decide before Phase 2.
- **Widget-type sprawl.** Every new `type` is code in the renderer *and* authoring. Open question: who owns the widget registry and its review bar?
- **AI trust & data exposure.** Recommendations must never leak raw rows into prompts, and must be clearly labeled as suggestions. Open question: do any teams have data that can't go to an external model API at all? That may require an on-prem/self-hosted model path.
- **Multi-tenancy isolation.** One shared backend means a tenancy bug is a cross-team data leak. Needs a hard isolation boundary in the gateway and query layer, tested explicitly.
- **Who owns the semantic layer definitions?** If teams want reusable metrics ("revenue" defined once), that's a governance feature. Open question: is a shared metric catalog in scope, or does each dashboard define its own?
- **Live vs cached freshness.** Caching makes it fast but can show stale numbers. Open question: what's the default TTL, and do widgets need a "last updated" indicator?

**Decisions that still need an owner before Phase 2:** the charting library, Snowflake warehouse/cost model, and whether an external LLM API is acceptable for all teams' data.
