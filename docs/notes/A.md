# Workstream A: calculations and the query engine (spec 1.3)

## 1. What was built

| # | Item | Where | Status |
| --- | --- | --- | --- |
| 1 | **Calculated measures** `calcs: [{ as, expr }]`. Safe expression language (numbers, `+ - * /`, parentheses, unary minus, `abs`, `round(x[, digits])`, `coalesce`, `nullif`, `least`, `greatest`, aggregate calls `sum(col)` … `count(*)`, quoted names `"order amount"`, joined columns `tg.target`). Parsed to an AST (`packages/spec/src/calc-expr.ts`), compiled to SQL from the AST (binds for numbers), evaluated by the reference engine. Division by zero → NULL; least/greatest NULL if any arg NULL (DuckDB's would skip NULLs; emulated); round half away from zero; result rounded to 6 decimals. Calcs see measures, catalog metrics and earlier calcs by alias, computed from **unrounded** aggregates. | spec `calc-expr.ts`, `query-ext.ts`; api `sql/compile.ts`, `sample/execute.ts` | Done, conformance-tested |
| 2 | **Calculated dimensions**: `buckets: { rules: [{ op, value?, label }], else? }` (CASE; all filter ops incl. contains) and **numeric bins** `bin: { width, offset? }` (`floor((x-offset)/width)*width+offset`). | spec `schema.ts` DimensionSchema | Done |
| 3 | **Aggregations** `median`, `p25`, `p75`, `p90` (continuous/interpolated) and `stddev` (sample). DuckDB `quantile_cont` / `stddev_samp`, Snowflake `PERCENTILE_CONT … WITHIN GROUP` / `MEDIAN`-equivalent / `stddev_samp`. Numeric columns only. | `schema.ts` AGGREGATIONS, `dialect.ts` | Done |
| 4 | **Window / table calcs** `windows: [{ as, type, measure, order?, partition?, offset?, window?, dir?, dense? }]`: `running_total`, `percent_of_total` (fraction 0–1), `rank` (standard or dense, desc default), `moving_average` (window n, default 3, partial frames at the start), `difference` and `percent_change` vs the row `offset` steps earlier along `order` (default 1; offset 12 on months = YoY; change = (v−prev)/abs(prev)). Computed over the aggregated rows before ORDER BY/LIMIT, in an outer SELECT over the grouped query. **Rule:** for ordered windows, `order` + `partition` must cover every dimension (else engines could order ties differently) — validation error `ambiguous_window_order`. | `query-ext.ts`, `compile.ts` | Done |
| 5 | **Top-N with "Other"** `topN: { dimension, n, by, otherLabel? }` (`null` drops the rest). SQL: the dimension becomes `CASE WHEN d IN (SELECT d … GROUP BY 1 ORDER BY <by> DESC NULLS LAST, 1 ASC LIMIT n) THEN d ELSE 'Other' END`, so every measure (avg, distinct, percentiles) of "Other" is exact. Text dimensions only (text columns, buckets). A NULL group counts toward N but folds into Other (SQL `IN` semantics, mirrored by the reference). | `compile.ts`, `execute.ts` | Done |
| 6 | **Filter ops** `contains`, `starts_with`, `ends_with`: case-insensitive, text columns only, `lower(col) LIKE ? ESCAPE '!'` with the user's `!`/`%`/`_` escaped; the pattern is a bind. | `schema.ts` FILTER_OPS, `compile.ts` | Done |
| 7 | **Joins** `joins: [{ source, type: 'inner' \| 'left' (default left), on: [{ left, right }] }]` (≤3 joins, ≤4 keys), same engine type only (sample+sample, local file+file in DuckDB, Snowflake-stored uploads with each other, snowflake+snowflake). Joined columns are referenced as `"<sourceId>.<column>"`; the query's own columns unqualified (or qualified with its source id). Every joined source passes the **same team visibility check** as the primary (file registry lookup by team; Snowflake INFORMATION_SCHEMA under the team role). SQL aliases relations `t0…tn` and qualifies every column. Fan-out and NULL-key semantics are plain SQL. | `sql/joins.ts` (`attachJoinSources`, `joinedSources`), engines, `compile.ts` `buildScope` | Done; **needs run.ts wiring (see 6)** |
| 8 | **Team metric catalog**: `MetricDefinition { name, label?, description?, format?, field+agg \| expr }`, `validateMetricDefinition(def) → {ok, metric} \| {ok:false, errors: Issue[]}`, `expandMetrics(query, metrics)`. Queries reference metrics with a **separate `metrics: [{ metric, as? }]` list** (not `metric` on a measure, see D-A2). Simple metrics → measures; derived (`expr` over other metric names and aggregate calls) → calcs placed before the query's own calcs; cycles and unknown metrics → `invalid_metric` / `unknown_metric`. Unexpanded metrics at an engine → `metrics_not_expanded`. | `services/api/src/data/metrics.ts` | Done (run.ts already calls expandMetrics when `metricCatalog` is set) |
| 9 | `outputColumns` covers dimensions, measures, metrics, calcs, windows (order) with `derived: 'bin' \| 'buckets' \| 'calc' \| 'window' \| 'metric'`. Engines check duplicate output names. | `query.ts` | Done |
| 10 | Conformance: 15 new small-fixture cases + 5 sample-orders cases (DuckDB ≡ reference), 3 join cases, 10 error-code parity cases, Snowflake SQL shapes (percentiles, binds, top-N subquery, joins) and Snowflake join visibility with the fake driver. All new fields version-gated with V13 (`field_too_new` in documents < 1.3), `queryExtensionSince` feeds `requiredSpecVersion`. | tests listed below | Done |
| 11 | Studio: Calculations section (add/edit/remove calcs), **bin width** input on numeric dimensions, advanced JSON sub-editor for windows / topN / joins / metrics; new aggregation and operator labels. **Fixed a data-loss bug:** `normalizeQuery`/`compactQuery` would have stripped every 1.3 field on any query edit; they now carry them. Buckets are edited in the dashboard JSON view (no dedicated UI). | `QueryEditor.tsx`, `draft/query.ts` | Done (basic UI) |

Tests: `packages/spec/test/calculations.test.ts`, `services/api/test/{conformance,calculations,snowflake}.test.ts` (extended/new), `apps/studio/test/calculations.test.tsx`. Existing SQL snapshots are byte-identical (no 1.3 feature → same SQL as before).

## 2. Decisions

### D-A1 Calculations compile from an AST; post-aggregation work stays in SQL
- **Context:** Calcs, windows and top-N need user-written logic without injection risk and with identical results on every engine.
- **Decision:** A small expression grammar parsed into an AST in the spec package (shared by validation, the reference engine and both SQL dialects). Calcs compile to SQL over unrounded aggregates in the same SELECT; windows to window functions in an outer SELECT over the grouped query; top-N to an IN-subquery over the same filtered relation. Numbers are binds; the only inlined numbers are validated integers engines don't accept as binds (LIMIT, frame sizes, lag offsets, round digits) and our own percentile constants.
- **Alternatives:** Post-processing in the API in JS over the aggregated rows (simpler, but not pushdown and needs a separate "all groups" fetch); free SQL snippets (injection, not portable).
- **Consequences:** Results agree to 6 decimals across engines (summation order differs; all derived values are rounded to 6). Every new feature is in the conformance suite.

### D-A2 Catalog metrics are referenced in a separate `metrics` list
- **Decision:** `metrics: [{ metric: 'revenue', as? }]` rather than `{ metric }` on a measure, so `Measure.field`/`agg` stay required and no consumer of measures (renderer, Studio, AI) changes. Expansion turns them into measures or calcs on the server before compiling.
- **Consequences:** Widgets see metric columns via `outputColumns` (`derived: 'metric'`, no `agg`), so additivity checks (pie) reject metric and calc values.

### D-A3 Ordered windows require a total order
- **Decision:** For running_total, moving_average, difference and percent_change, `order` plus `partition` must name every dimension; `offset` counts rows, not calendar periods (a missing month shifts YoY, as in Tableau's LOOKUP).

### D-A4 Top-N is exact and text-only
- **Decision:** "Other" is re-aggregated from rows (CASE in GROUP BY), so averages, distinct counts and percentiles of "Other" are exact; limited to text dimensions so the label type matches. A NULL group counts toward N and folds into Other.

### D-A5 Joins: same engine type, team-checked, resolved by the caller
- **Decision:** Joins name dashboard data sources by id; `data/run.ts` attaches `{type, ref}` (`attachJoinSources`) because engines only receive the primary source. Engines re-check team visibility of every joined source exactly like the primary, so an attached ref grants nothing. Cross-engine joins (e.g. upload ⨝ Snowflake table) are not supported.

## 3. Changelog lines (2026-11-11)
- Spec 1.3 query features: calculated measures (expression language), bins and buckets, median/p25/p75/p90/stddev, window calcs (running total, % of total, rank, moving average, difference, % change / YoY), top-N with "Other", contains/starts_with/ends_with, joins between sources of the same engine, team metric catalog expansion (D-A1 to D-A5).
- Studio: Calculations section, bin width, advanced JSON for windows/top-N/joins/metrics; fixed the Studio dropping 1.3 query fields on edit.
- Verified: in-memory reference ≡ DuckDB (conformance, incl. joins); Snowflake SQL and join visibility with the fake driver. **Not verified:** Snowflake execution of percentiles, window functions over aggregated subqueries, `LIMIT` inside the top-N `IN` subquery, and `LIKE … ESCAPE '!'` against a live account.

## 4. Doc text

### SPEC.md — add section "Calculations (spec 1.3)" after "Query semantics"
```markdown
## Calculations (spec 1.3)

All optional; an error in documents claiming an older specVersion.

| Field | Shape | Notes |
| --- | --- | --- |
| measure `agg` | `median`, `p25`, `p75`, `p90`, `stddev` | numeric columns; continuous percentiles; sample stddev (NULL under 2 values) |
| filter `op` | `contains`, `starts_with`, `ends_with` | text columns, case-insensitive, value is literal text |
| dimension `bin` | `{ width, offset? }` | numeric column → `floor((x − offset) / width) × width + offset` |
| dimension `buckets` | `{ rules: [{ op, value?, label }], else? }` | first matching rule's label, else `else` (NULL if omitted); one of grain / bin / buckets |
| `calcs` | `[{ as, expr }]` | e.g. `revenue / orders`, `sum(profit) / sum(amount)`, `round(x, 1)`; see grammar below |
| `windows` | `[{ as, type, measure, order?, partition?, offset?, window?, dir?, dense? }]` | `running_total`, `percent_of_total` (0–1), `rank`, `moving_average` (default 3 rows), `difference`, `percent_change` (offset 12 on months = YoY) |
| `topN` | `{ dimension, n, by, otherLabel? }` | text dimensions; remainder folded into "Other" (or dropped with `null`) |
| `joins` | `[{ source, type?: inner\|left, on: [{ left, right }] }]` | same engine type; joined columns are `"<sourceId>.<column>"` |
| `metrics` | `[{ metric, as? }]` | team catalog metrics, expanded on the server |

Expression grammar: numbers, `+ - * /`, parentheses, unary minus; names of measures, metrics and earlier calcs
(`"quoted names"` for spaces); aggregate calls `sum avg min max count count_distinct median p25 p75 p90 stddev`
over a column (`count(*)` counts rows); functions `abs`, `round(x[, digits])`, `coalesce`, `nullif`, `least`,
`greatest`. Semantics: NULL in → NULL out, division by zero → NULL, least/greatest NULL if any argument is NULL,
round half away from zero, result rounded to 6 decimals, computed from unrounded aggregates.

Rules: ordered windows need `order`, and `order` + `partition` must name every dimension; `offset` counts rows,
not calendar periods. Windows run over all groups before ORDER BY / LIMIT. Top-N "Other" is re-aggregated exactly;
a NULL group counts toward N and folds into Other. Outputs are ordered dimensions, measures, metrics, calcs, windows.
```

### API.md — under "Dashboards" data route
```markdown
Query errors added in 1.3 (per NDJSON line): `invalid_expression`, `invalid_calc`, `invalid_window`, `invalid_top_n`,
`invalid_dimension`, `invalid_join`, `unknown_metric`, `invalid_metric`, `metrics_not_expanded`, `duplicate_column`.
```

### GUIDE.md — under "Building a dashboard"
```markdown
**Calculations.** In a widget's query, **+ Calc** adds an expression over its measures (e.g. `revenue / orders`,
`sum(profit) / sum(amount)`). A numeric dimension takes a **bin width** for histograms. Under "Table calcs, top N,
joins, catalog metrics" a small JSON box adds running totals, % of total, rank, moving averages, differences and
year-over-year change, top-N with "Other", joins to another source of the same kind, and team catalog metrics.
Buckets (e.g. amount < 100 → "Small") are written in the JSON view.
```

### ARCHITECTURE.md — "Request flows → A dashboard loads", step 3
```markdown
… params applied → catalog metrics expanded (`data/metrics.ts`) → joined sources attached
(`sql/joins.ts`) → cache → gate → the engine compiles: calcs from their AST in the grouped SELECT, windows in an
outer SELECT, top-N as an IN-subquery, joins as aliased relations whose team access is checked like the source's.
```

### DEPLOYMENT.md
No new configuration variables.

### CAPABILITIES.md — gaps closed
Calculated fields/expressions (measure level), table calculations (running total, % of total, rank, moving
average, difference, % change), period comparison data (YoY/MoM via windows; KPI delta display is workstream C),
joins (same engine type), bins/histogram data, top-N with "Other", percentiles/median/stddev, search filter
operators, shared metric catalog (expansion; storage/UI workstream D).

Still missing: row-level calculated fields (expressions over columns before aggregation, other than buckets/bins),
level-of-detail expressions (FIXED/INCLUDE/EXCLUDE), calendar-aware period comparison (offsets count rows),
cross-engine joins/blending and Qlik-style associative selection, forecasting/trend lines (renderer side), string
and date functions in expressions.

## 5. Assistant "Not supported" list (services/api/src/ai/spec-reference.ts)
Remove: "histograms/binning" (bins exist; the histogram *chart* is C's), "calculated fields or ratios between
measures", "running totals, % of total, period-over-period", "joins across sources". Replace with: "row-level
expressions before aggregation (except buckets/bins), level-of-detail expressions, joins across different engines
(e.g. an upload with a Snowflake table), calendar-aware period offsets". The rest of the reference updates itself
from the schemas (new aggs, ops, bin/buckets, calcs/windows/topN/joins/metrics shapes).

## 6. Requests to the lead / other workstreams
1. **Workstream B / lead — run.ts:** call `attachJoinSources(resolved, ctx.dashboard.dataSources)` (from
   `services/api/src/data/sql/joins.ts`) after params/metrics and before `cachedExecute`, for saved and draft
   queries. Without it every join fails with `unknown_source` ("not defined in the dashboard"). The result cache key
   must include the attached refs (it hashes the query, so attaching before `cachedExecute` covers it).
2. **Lead — validate.ts:** the `empty_query` check (`dimensions.length === 0 && measures.length === 0`) rejects valid
   1.3 queries that only have catalog metrics or calcs with aggregate calls. Suggest `outputColumns(q).length === 0`.
3. **Lead — spec-reference.ts:** apply section 5.
4. **Workstream C:** box plots can use `median`/`p25`/`p75` measures (and `min`/`max`); KPI "vs previous period"
   can read a `percent_change` window column (e.g. `reduce: 'last'`); histograms use a `bin` dimension.
5. **Workstream D:** `validateMetricDefinition` requires lower-case metric names (`^[a-z][a-z0-9_]{0,63}$`, same as
   query references) and rejects unknown keys; D's baseline regex is looser, so A's check is the binding one.
6. Note: `apps/studio/test/reducer.test.ts` currently fails on workstream C's in-progress choropleth widget (not A).
