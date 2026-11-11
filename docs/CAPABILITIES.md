# Sratchpad: capabilities and gaps

What you can build in Sratchpad today, what Tableau or Qlik can do that Sratchpad cannot (yet), and
the order we would close the gaps. Keep this current: update it whenever a gap is closed or found.

Sratchpad deliberately does not try to match Tableau/Qlik feature for feature (D-001). It wins on
**embeddability** (dashboards as JSON, rendered in any team's app, readable by other apps), **AI-assisted
authoring** (suggestions and the Studio assistant) and **one governed backend**. The gaps below are the
price of that focus; the ones that block real dashboards are first on the roadmap.

## What you can build today (spec 1.2)

| Area | Supported |
| --- | --- |
| Chart types | KPI, line, bar (vertical/horizontal, stacked), area (stacked), scatter (size, label), pie/donut, pivot table, table (paged or virtualized), text |
| Data | Sample data, uploaded CSV/Excel, Snowflake tables/views (pushdown) |
| Queries | Group by dimensions and time grains (day…year); sum, avg, min, max, count, count distinct; filters (11 operators); sort; limit |
| Multi-series | Several measures, or one measure split by a column (`series`) |
| Controls | Date range (presets or from/to) and single-value select, bound to any queries |
| Layout | Free 12-column grid, any size, responsive stacking on narrow screens |
| Formatting | Number, integer, currency, percent, compact, date, month, text; table column labels, formats and alignment |
| **Styling (1.2)** | Dashboard theme: light/dark mode, series palette, accent, page and card backgrounds, card style (bordered, flat, elevated), density, corner radius, font family. Per widget: colors, background, emphasis, title alignment, hide title. Charts: gridlines, data labels, axis titles, hide axes, y-axis min/max, legend, curve, orientation, stacking |
| Authoring | Drag-and-drop Studio, live preview, versions, conflicts, JSON view, AI suggestions, **chat assistant** |
| Sharing | Embed with one component; read-only app tokens; viewer links; team viewer role |

## What Tableau / Qlik can do that Sratchpad cannot yet

### Analysis and calculations (biggest gap)

| Missing | Example you cannot build today |
| --- | --- |
| Calculated fields / expressions | Profit margin = sum(profit) / sum(revenue); conditional buckets (IF amount > 1000 THEN "Large") |
| Table calculations | Running totals, % of total, rank, moving averages, year-over-year change |
| Level-of-detail expressions (Tableau FIXED/INCLUDE/EXCLUDE) | Average order value per customer, then averaged by region |
| Period comparison on KPIs | "Revenue $1.2M, ▲ 8% vs last month" |
| Joins / blending / associative model (Qlik) | One chart combining orders and targets from two tables |
| Bins and histograms | Distribution of order sizes |
| Sets, groups, top-N with "Other" in queries | "Top 10 customers, rest as Other" (only pie and series fold today) |
| Forecasting, trend lines, clustering | Revenue forecast band |

### Interactivity

| Missing | Example |
| --- | --- |
| Cross-filtering (click a bar to filter the rest) | Click "Europe" and every chart shows Europe |
| Drill-down / drill-through | Year → quarter → month; click a region to open a detail dashboard |
| Multi-select, range sliders, search filters, cascading filters | Pick 3 regions; amount between 100 and 500 |
| Dashboard actions, parameters that switch measures | A dropdown that swaps "Revenue" / "Orders" in every chart |
| Tabs, multi-page dashboards, show/hide containers | Overview tab and Detail tab |
| Sort by clicking a column or axis | – |

### Visual types and formatting

| Missing | |
| --- | --- |
| Maps (filled, symbol, heat) | Geo columns are detected but not drawable |
| Heatmap, treemap, box plot, waterfall, funnel, gauge, bullet, sankey, combo/dual-axis, small multiples | |
| Conditional formatting (color by value or threshold), color scales | |
| Reference lines and bands, annotations | Target line on a chart |
| Sparklines in tables, rich tooltips, custom number format strings, decimals per field | |
| Images, logos, custom fonts beyond the four families, free CSS | Free CSS is excluded on purpose (safety in every host app) |

### Platform

| Missing | |
| --- | --- |
| Export to PDF/PNG/CSV, scheduled email subscriptions, data alerts | Out of scope for v1 (design doc) |
| Row-level security per end user | Out of scope for v1 |
| Shared metric catalog / semantic layer governance | Open question |
| Extracts with scheduled refresh, incremental loads | Uploads are one-off; Snowflake is queried live (cached 60 s) |
| Comments, favorites, usage analytics per dashboard | |
| Mobile-specific layouts | Narrow screens stack widgets automatically |

## Roadmap proposal (most valuable first)

1. **Calculated measures and period comparison**: ratios and expressions in queries (compiled to SQL, never
   evaluated in the browser), KPI deltas vs previous period, % of total and running totals.
2. **Cross-filtering and drill-down**: click to filter, hierarchies on time and dimensions.
3. **Richer controls**: multi-select, ranges, search; a parameter that switches measures.
4. **Conditional formatting and reference lines**.
5. **More chart types**: map (choropleth/symbol), heatmap, histogram, combo, waterfall, funnel.
6. **Tabs / multi-page dashboards**.
7. **Exports and subscriptions** (PDF/PNG/CSV, scheduled email), then **row-level security**.

Each is a spec minor bump (additive) with renderer, Studio and assistant support; the assistant learns
new features automatically because its spec reference is generated from the schemas.
