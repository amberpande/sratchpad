# Sratchpad: capabilities and gaps

What you can build in Sratchpad today, what Tableau or Qlik can still do that Sratchpad cannot, and what we
would build next. Keep this current: update it whenever a gap is closed or found (see `CLAUDE.md`).

Sratchpad does not try to match Tableau and Qlik feature for feature (D-001). It wins on **embeddability**
(dashboards as JSON rendered in any team's app and readable by other apps), **AI-assisted authoring**
(suggestions and the Studio assistant) and **one governed backend**. Spec 1.3 (2026-11-12) closed most of the
gaps listed in the previous version of this page (D-033, D-034 to D-067).

## What you can build today (spec 1.3)

| Area | Supported |
| --- | --- |
| Chart types | KPI, line, bar, area, scatter, pie/donut, table, pivot, text, **map** (world countries, US states; filled or symbol), **heatmap**, **treemap**, **box plot**, **waterfall**, **funnel**, **gauge**, **bullet**, **sankey**, **combo / dual axis**, **image**, **small multiples** (facet) |
| Data | Sample data, uploaded CSV/Excel (Snowflake Iceberg tables in production), Snowflake tables (pushdown), **joins** between sources of the same engine |
| Calculations | Group by dimensions and time grains; sum, avg, min, max, count, count distinct, **median, p25, p75, p90, stddev**; **calculated measures** (`revenue / orders`, `sum(profit) / sum(amount)`, round, coalesce, …); **bins** (histograms) and **buckets** (CASE groups); **table calcs**: running total, % of total, rank, moving average, difference, % change (period over period, year over year); **top-N with "Other"**; **team metric catalog** |
| Filters and controls | Date range, select, **multi-select** (fixed or query-driven, cascading), **range**, **search** (contains / starts with / ends with), **measure switch** |
| Interactivity | **Click to filter** other widgets, **drill-down** (hierarchies on time and dimensions, breadcrumb), **drill-through** (host apps), **tabs**, **mobile layout**, **click-to-sort** tables |
| Formatting | Number formats (decimals, prefix/suffix, k/M/B, percent) per column; **conditional formatting** (rules or color scales) on tables and pivots; KPI **thresholds** and **▲/▼ comparison**; **reference lines and bands**, **annotations**, **tooltip fields**, **table sparklines**; theme (mode, palette, accent, backgrounds, card style, density, radius, font), per-widget style, gridlines, data labels, axis titles and ranges |
| Authoring | Drag-and-drop Studio, live preview, versions, conflicts, JSON view, AI suggestions, chat assistant, editors for calcs, params, tabs, drill, reference lines, conditional formats; **custom SQL for any chart** (spec 1.4, developers) |
| Sharing and security | Embed with one component; read-only app tokens and viewer links (with row-level attributes); team viewer role; **row-level security per user** (fail closed) |
| Platform | **Export** widget CSV/PNG, dashboard **print/PDF**, server CSV export; **scheduled email subscriptions** (KPIs, link, CSV); **data alerts** (email, signed webhooks); **scheduled refresh** (cache warming); **comments**, **favorites**, **usage analytics** |

## What Tableau / Qlik can still do that Sratchpad cannot

### Analysis

| Missing | Example |
| --- | --- |
| Level-of-detail expressions (Tableau FIXED / INCLUDE / EXCLUDE) | Average order value per customer, then averaged by region |
| Row-level calculated fields in the visual builder (expressions over columns before aggregation; string and date functions) | `amount * fx_rate`, `upper(region)` (bins and buckets are the only visual row-level calcs; custom SQL can do it) |
| Calendar-aware period comparison | "Same month last year" when months are missing (window offsets count rows) |
| Joins across engines; blending; Qlik's associative model | An upload joined with a Snowflake table |
| Joins with row-secured sources | Refused today (D-065) |
| Custom SQL with row-level security, on uploads stored in Snowflake, or with `{{param}}` placeholders | Refused / not built (D-070 to D-072) |
| Forecasting, trend lines, clustering | Revenue forecast band |
| Sets and groups as reusable objects | "Top customers" set used across sheets |

### Interactivity

| Missing | Example |
| --- | --- |
| Drill on a series value (only the first dimension drills) | Click a channel line to drill by product |
| Show/hide containers, dynamic zone visibility | A panel that appears when a filter is set |
| Multi-bucket time selections in one click | Brush a date range on a chart |
| Keyboard selection of chart marks | (the "View as table" toggle is the keyboard path) |
| Cross-filtering in the Studio preview | Works in the viewer and embedded dashboards |

### Visual types and formatting

| Missing | |
| --- | |
| Counties, custom geographies, ISO alpha-2/3 country codes on maps | |
| Custom fonts beyond the four families; free CSS | Free CSS is excluded on purpose (safety in every host app) |

### Platform

| Missing | |
| --- | |
| Materialized extracts and incremental loads | Scheduled refresh warms the cache; data stays live (D-061) |
| PDF attachments in emails | Emails carry a link and CSV files |
| Alert snoozing and escalation; per-widget usage analytics | |
| Single sign-on | Access tokens until SSO (D-027) |

## Roadmap proposal (most valuable first)

1. **SSO** (team and role from group claims), then refresh job owners' attributes from it (open question, D-063).
2. **Level-of-detail and row-level expressions** (compiled to SQL like calcs, D-034).
3. **Row-level security on joined sources** and cross-engine joins.
4. **Materialized extracts** for hot dashboards (Snowflake-native, D-020).
5. **Forecast and trend lines**, drill on series, show/hide containers.
6. **PDF in emails**, alert snoozing, more map geographies.

Each is an additive spec minor bump where it touches the document; the assistant learns new spec features
automatically (its reference is generated from the schemas), but new limits go in its "Not supported" list.
