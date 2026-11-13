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
| Chart types | Maps now also with **US counties** and ISO country codes; KPI, line, bar, area, scatter, pie/donut, table, pivot, text, **map** (world countries, US states; filled or symbol), **heatmap**, **treemap**, **box plot**, **waterfall**, **funnel**, **gauge**, **bullet**, **sankey**, **combo / dual axis**, **image**, **small multiples** (facet) |
| Data | Sample data, uploaded CSV/Excel (Snowflake Iceberg tables in production), Snowflake tables (pushdown), **joins** between sources of the same engine (row-secured too, D-079), **custom SQL** with `{{param}}` placeholders |
| Calculations | **Row-level fields** (`amount * fx_rate`, `year(order_date)`); **level of detail** (aggregate per customer, then by region); **calendar-aware** YoY; **value sets**; group by dimensions and time grains; sum, avg, min, max, count, count distinct, **median, p25, p75, p90, stddev**; **calculated measures** (`revenue / orders`, `sum(profit) / sum(amount)`, round, coalesce, …); **bins** (histograms) and **buckets** (CASE groups); **table calcs**: running total, % of total, rank, moving average, difference, % change (period over period, year over year); **top-N with "Other"**; **team metric catalog** |
| Filters and controls | Date range, select, **multi-select** (fixed or query-driven, cascading), **range**, **search** (contains / starts with / ends with), **measure switch** |
| Interactivity | **Brush a time range**, **drill on a series**, **show/hide widgets** by a control, **keyboard selection**, click-to-filter in the Studio too; **click to filter** other widgets, **drill-down** (hierarchies on time and dimensions, breadcrumb), **drill-through** (host apps), **tabs**, **mobile layout**, **click-to-sort** tables |
| Formatting | **Trend lines and forecasts** (line charts), **clustering** (scatter); number formats (decimals, prefix/suffix, k/M/B, percent) per column; **conditional formatting** (rules or color scales) on tables and pivots; KPI **thresholds** and **▲/▼ comparison**; **reference lines and bands**, **annotations**, **tooltip fields**, **table sparklines**; theme (mode, palette, accent, backgrounds, card style, density, radius, font), per-widget style, gridlines, data labels, axis titles and ranges |
| Authoring | Drag-and-drop Studio, live preview, versions, conflicts, JSON view, AI suggestions, chat assistant, editors for calcs, params, tabs, drill, reference lines, conditional formats; **custom SQL for any chart** (spec 1.4, developers) |
| Sharing and security | **Single sign-on (any OIDC provider)**; optional company sign-in for viewer links; embed with one component; read-only app tokens and viewer links (with row-level attributes); team viewer role; **row-level security per user** (fail closed) |
| Platform | **SSO**, **PDF reports** in emails, **alert snooze and escalation**, **per-widget usage**, metric **history**; **export** widget CSV/PNG, dashboard **print/PDF**, server CSV export; **scheduled email subscriptions** (KPIs, link, CSV); **data alerts** (email, signed webhooks); **scheduled refresh** (cache warming); **comments**, **favorites**, **usage analytics** |

## What Tableau / Qlik can still do that Sratchpad cannot

### Analysis

| Missing | Example |
| --- | --- |
| Tableau FIXED (ignores the view's dimensions); more than one detail level per query | INCLUDE-style `detail` is built (D-084) |
| String row-level functions | `upper(region)`, `concat(a, b)` (numeric and date-part fields are built, D-083; custom SQL can do strings) |
| Seasonal forecasting | Forecasts are linear with a 95% band (D-081) |
| Dynamic or team-level sets | Static dashboard sets are built (D-086); dynamic top-N is `topN` |
| Custom SQL with row-level security or on uploads stored in Snowflake | Refused (D-071, D-072; see "Not possible") |

### Interactivity

| Missing | Example |
| --- | --- |
| Brushing on bar and area charts | Line charts brush (D-090) |
| Collapsing the space of a hidden widget | Hidden widgets leave their space (D-089) |

### Visual types and formatting

| Missing | |
| --- | |
| Custom geographies (sales territories, postcodes) | Countries (names, ISO numeric/alpha), US states and counties are built (D-092) |
| Web fonts; free CSS | Nine font families incl. the host app's own (D-093); free CSS is excluded on purpose |

### Platform

| Missing | |
| --- | |
| Materialized extracts and incremental loads | Scheduled refresh warms the cache; data stays live (D-061) |
| Charts drawn in PDF reports | PDF reports carry KPIs and tables (D-096) |

## Not possible (from the codebase alone)

These cannot be closed by writing code in this repository. Each needs an account, a decision or a resource only
the owner has, or is excluded on purpose. Keep this list current.

| Item | Why not | What would unblock it |
| --- | --- | --- |
| Live verification of the Snowflake paths (hybrid-table store, Iceberg uploads, pushdown, custom SQL) | Needs a non-trial Snowflake account and credentials | Run the first-deploy smoke test in `DEPLOYMENT.md` |
| Live verification of SSO with your provider | Needs your Cognito/Okta/Entra tenant, a registered client and test users | Set `OIDC_*`, sign in once, check team and role |
| Live verification of the Claude ranker and assistant | Needs an Anthropic API key (and a spending decision) | Set `ANTHROPIC_API_KEY` |
| Live email (SES) and webhook delivery | Needs a verified SES domain and a receiving endpoint | Set `SMTP_URL`, create a subscription |
| Choosing the SSO provider, the warehouse model, the product name (`@yourorg`, `BI_*` rename) | Owner decisions | Decide; the code already supports per-team warehouses and any OIDC provider |
| Refreshing scheduled jobs' row-level attributes from the identity provider | OIDC gives attributes only at sign-in; reading them later needs a directory API (SCIM, Microsoft Graph, Okta API) and admin credentials for it | Pick the provider and grant a directory API client |
| Row-level security enforced inside Snowflake per user (row access policies) | Needs per-user Snowflake identity (Snowflake OAuth / external OAuth with your IdP) configured in your account | Set up external OAuth in Snowflake, then pass the user's token through |
| Custom SQL on uploads stored in Snowflake | Needs a separate Snowflake role per team for uploads, created by an admin | Create per-team upload roles; then the guard can allow it |
| Joins between a local upload and a Snowflake table | Two engines in two places; joining means copying one side, which defeats pushdown | Store uploads in Snowflake (`BI_UPLOADS=snowflake`), then join within Snowflake |
| Qlik's associative engine | A different in-memory engine model, not an extension of pushdown SQL | Out of scope by design (D-001) |
| Free CSS in dashboards | Excluded for safety in every host app | By design (D-030) |
| Making Llama 3.2 (3B) reliable at edits and styling | A model limitation, not code | Use a larger local model (`OLLAMA_MODEL`) or Claude |
| Global rate limits without any shared store | Counting across ECS tasks needs a shared counter | Use `REDIS_URL` (ElastiCache) |

## Roadmap proposal (most valuable first)

1. ~~SSO~~ built (D-074); refresh job owners' attributes from it (open question, D-063).
2. ~~Level-of-detail and row-level expressions~~ built (D-083, D-084); string row functions next.
3. ~~Row-level security on joined sources~~ built (D-079); cross-engine joins are not possible (see above).
4. **Materialized extracts** for hot dashboards (Snowflake-native, D-020).
5. ~~Forecast and trend lines~~ built (D-081); drill on series, show/hide containers.
6. ~~PDF in emails, alert snoozing, more map geographies~~ built (D-092, D-094, D-096); drill on series and show/hide built (D-088, D-089).

Each is an additive spec minor bump where it touches the document; the assistant learns new spec features
automatically (its reference is generated from the schemas), but new limits go in its "Not supported" list.
