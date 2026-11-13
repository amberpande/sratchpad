# Sratchpad: the dashboard spec

Every dashboard is one JSON document. Authoring writes it, the store versions it, every host app and
the viewer render it, and teams' apps may parse it. Source of truth: `packages/spec`
(`validateDashboard`, `WIDGET_TYPES`, `SPEC_VERSION`). Why it looks like this: D-003, D-004, D-006 in
[`DECISIONS.md`](DECISIONS.md).

## Shape

```json
{
  "specVersion": "1.1",
  "id": "dash_9f2a",
  "title": "Sales overview",
  "dataSources": { "orders": { "type": "snowflake", "ref": "ANALYTICS.PUBLIC.ORDERS" } },
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
    "w_line": { "type": "line-chart", "query": "q_rev_by_month", "encoding": { "x": "order_date", "y": "revenue" }, "options": { "title": "Revenue by month" } }
  },
  "layout": [{ "i": "w_line", "x": 0, "y": 0, "w": 12, "h": 5 }],
  "params": { "dateRange": { "type": "daterange", "default": "last_90d", "bind": ["q_rev_by_month.filters"] } }
}
```

- `dataSources` types: `sample` (built-in), `file` (`file_<id>` upload), `snowflake` (`DB.SCHEMA.TABLE`).
- Widgets reference queries by id, so two widgets can share one query and one round trip.
- `layout` is a 12-column grid (react-grid-layout shape).
- `params` bind into queries via `"<queryId>.filters"`. A `daterange` filters `field`, or the bound
  query's first time dimension when `field` is omitted. A `select` filters `field` by one value (`null` = all).

## Versioning rules

- `specVersion` is `MAJOR.MINOR`. A reader on the same major and an older minor renders **degraded**:
  unknown widgets become placeholders, unknown fields are dropped, a banner explains. A different major
  is refused with a clear message. The store only accepts versions it fully understands.
- Adding optional fields or widget types is a minor bump; removing or re-typing a field is a major bump
  and needs a renderer release.
- Each widget type records its `since` version and each newer field its `fieldsSince`
  (`packages/spec/src/widgets.ts`). Using a 1.1 feature in a 1.0 document is an error
  (`widget_type_too_new`, `field_too_new`). `requiredSpecVersion(widgets)` gives the lowest version a document needs.
- Validation reports every problem in one pass with dotted paths (e.g. `widgets.w_line.encoding.y`).

## Styling (spec 1.2)

Optional and additive. Values are constrained so renderers can apply them safely as CSS custom properties.

```json
{
  "specVersion": "1.2",
  "theme": {
    "mode": "dark",
    "palette": ["#2dd4bf", "#f472b6", "#facc15"],
    "accent": "#2dd4bf",
    "background": "#0b1220",
    "cardBackground": "#111a2e",
    "cardStyle": "elevated",
    "density": "compact",
    "radius": 14,
    "font": "rounded"
  },
  "widgets": {
    "w_region": {
      "type": "bar-chart", "query": "q", "encoding": { "x": "region", "y": "revenue" },
      "options": { "title": "Revenue by region", "showGrid": false, "dataLabels": true, "axis": { "y": { "label": "Revenue", "min": 0 } } },
      "style": { "colors": ["#f472b6"], "emphasis": true, "titleAlign": "center" }
    }
  }
}
```

| Where | Field | Values |
| --- | --- | --- |
| `theme` | `mode` | `light` / `dark`: text and chrome; **wins over the host's theme** (set it whenever you set backgrounds) |
| | `palette` | up to 8 hex colors, in series order |
| | `accent` | hex: emphasized widgets, focus rings |
| | `background`, `cardBackground` | hex: page behind the cards, card surface |
| | `cardStyle` | `bordered` (default), `flat`, `elevated` |
| | `density` | `comfortable` (default), `compact` |
| | `radius` | 0–24 px |
| | `font` | `system`, `serif`, `mono`, `rounded` |
| widget `style` | `colors` | up to 8 hex colors for this widget's series |
| | `background`, `accent` | hex |
| | `emphasis` | accent edge on the card |
| | `titleAlign`, `hideTitle` | `left`/`center`; hide the title (still announced to screen readers) |
| line/bar/area options | `showGrid`, `dataLabels`, `axis` | gridlines (default on); value labels; `axis.x` / `axis.y`: `label`, `hide`, y `min`/`max` |
| scatter options | `showGrid`, `axis` | as above |

Hex colors only (`#rgb` or `#rrggbb`). Validation warns `low_contrast` when a background is dark but
`mode` is not `dark` (or the reverse). Author colors are not checked for color-vision safety.

## Widget types

| Type | Since | Notes |
| --- | --- | --- |
| `kpi` | 1.0 | One number: `field`, `reduce`, `label`, `format` |
| `line-chart`, `bar-chart` | 1.0 | `encoding.x`, `encoding.y` (one or several), `series` since 1.1 (long → wide, >8 values fold into "Other") |
| `table` | 1.0 | `columns`, `pageSize`; `pagination` (`auto`/`pages`/`scroll`) since 1.1; long tables virtualized |
| `area-chart` | 1.1 | Optionally stacked |
| `scatter` | 1.1 | Numeric x/y, optional size and label |
| `pie` | 1.1 | Donut, part-to-whole only (sum/count measure), max 6 slices, rest folded into "Other" |
| `pivot` | 1.1 | rows × columns × value; reshape only, never aggregates in the browser |
| `text` | 1.1 | Markdown-lite, **no query** |
| `map` | 1.3 | Choropleth (`region`, `value`) or symbol (`lat`, `lon`, `size?`, `label?`) over `basemap: world\|usa`. Countries by name or ISO numeric code; US states by name, FIPS or postal code |
| `heatmap` | 1.3 | `x` × `y` colored by `value`; query groups by exactly x and y |
| `treemap` | 1.3 | `category` (+ `group`) sized by an additive `value`; largest `maxNodes` shown |
| `boxplot` | 1.3 | Five statistic columns per `category` (e.g. min, p25, median, p75, max) |
| `waterfall` | 1.3 | Signed `value` steps per `category`, optional total |
| `funnel` | 1.3 | `stage`, `value` in query order with conversion % |
| `gauge` | 1.3 | One value (`options.field`) on min..max (`max` or `maxField`), `target`, color `bands` |
| `bullet` | 1.3 | `value` vs `target` over `ranges`, one row per `category` |
| `sankey` | 1.3 | Flows `source` → `target` sized by an additive `value`; no cycles |
| `combo` | 1.3 | `bars` and `lines` on one `x`, lines on a secondary axis by default |
| `image` | 1.3 | https `src`, required `alt`, optional https `href`; no query |

Since 1.2 every widget may carry `style`, and line/bar/area/scatter gain the chart options above. Since 1.3: the types above marked 1.3, the formatting options below, and the interactivity fields (`drill`, `drillThrough`, `interactions`) on any widget.

Formats: `number`, `integer`, `currency`, `percent`, `compact`, `date`, `month`, `text`.
See [`examples/dashboards/ops_mix.json`](../examples/dashboards/ops_mix.json) for every 1.1 type.

## Query semantics (every engine)

The in-memory sample engine is the reference; `services/api/test/conformance.test.ts` runs the same
cases through it and DuckDB and requires identical rows, order, columns and `truncated`. The Snowflake
compiler follows the same rules (tested against a fake driver).

- Output columns are named by `as`, else `<agg>_<field>`. Aggregations: `sum`, `avg`, `min`, `max`,
  `count`, `count_distinct`; `count` of `"*"` counts rows.
- Time grains (`day`, `week`, `month`, `quarter`, `year`) return `'YYYY-MM-DD'` strings (column type
  `time` + `grain`); ISO weeks start Monday. A grain on a non-date column is `invalid_grain`.
- Sorting: the query's `orderBy`, then every dimension ascending as a tie-break, so `LIMIT` cuts at the
  same row everywhere. **NULLs sort last in both directions.**
- `sum` / `avg` are rounded to 6 decimals and need a numeric column. `count` ignores NULLs. Ungrouped
  aggregates over no rows return one row.
- Filters (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `between`, `is_null`, `not_null`)
  follow SQL NULL rules: `neq` and `not_in` never match NULL; NULLs inside `in` / `not_in` lists are
  ignored; `between` with a NULL bound matches nothing. A value must fit the column type (numbers for
  numeric columns, ISO dates for date columns), else `invalid_filter`.
- `limit` defaults to 1,000, max 10,000; results report `truncated`.
- SQL is generated only from the spec: identifiers quoted, every value a bind parameter, the only
  inlined number the validated `LIMIT` (`limit + 1` to detect truncation). Custom SQL queries (1.4) are the
  exception and follow their own rules (below).

## Custom SQL queries (spec 1.4)

A query may be written as SQL instead of dimensions and measures (D-070):

```json
"q_paid_by_month": {
  "source": "orders",
  "sql": "SELECT date_trunc('month', order_date) AS order_date, SUM(amount) AS revenue\nFROM orders\nWHERE status = 'paid'\nGROUP BY 1",
  "columns": [
    { "name": "order_date", "role": "dimension", "type": "time" },
    { "name": "revenue", "role": "measure" }
  ],
  "orderBy": [{ "field": "order_date", "dir": "asc" }],
  "limit": 1000
}
```

| Field | Rules |
| --- | --- |
| `sql` | One `SELECT` (or `WITH … SELECT`), max 20,000 characters; one trailing `;` allowed. Not with `dimensions`, `measures`, `calcs`, `windows`, `topN`, `joins` or `metrics`. |
| `columns` | The result columns widgets, sort and filters use: `name` exactly as the SQL returns it (Snowflake upper-cases unquoted aliases), `role` `dimension` or `measure`, optional `type` `string` / `number` / `time` / `boolean` (measures are numbers). Without `columns` the query is valid (warning `missing_columns`) and returns every column, but widgets cannot bind to it. |
| `source` | Picks the engine. The SQL names the dashboard's data sources of that engine by id (`FROM orders`); on Snowflake also any table the team's role can read (`DB.SCHEMA.TABLE`). |
| `filters`, `orderBy`, `limit` | Apply to the SQL's result columns. Params bound to the query filter a declared column (a `daterange` without `field` uses the first `time` column); a param bound to an undeclared column, or a `measure` param, is a validation error. Cross-filters may use the query's declared dimension columns. |

Not available on SQL queries: drill-down, measure switches, catalog metrics. The SQL dialect is the engine's:
Snowflake SQL for Snowflake sources, DuckDB SQL for uploads and sample data. How the server runs it safely:
[`ARCHITECTURE.md`](ARCHITECTURE.md) (security model), D-071, D-072.

## Analysis additions (spec 1.4)

| Field | Shape | Notes |
| --- | --- | --- |
| query `fields` | `[{ as, expr }]` | Row-level numeric expressions over the row's columns (calc grammar without aggregations) plus `year/quarter/month/day/weekday(date_column)`; usable by name like a column (D-083) |
| query `detail` | `{ dimensions, measures }` | Level of detail: aggregate at the query's dimensions + these, then the query's measures aggregate the detail measures by name; filters on detail measures apply after (D-084) |
| window `calendar` | `true` | `difference` / `percent_change`: `offset` counts periods of the order dimension's grain by date (D-082) |
| dashboard `sets` | `{ id: { field, values, label?, otherLabel? } }` | Dimension `set` groups into label / "Other"; filter `set` with `in` / `not_in` (D-086) |
| SQL column `grain` | time grain | For a `time` column of a custom SQL query |
| custom SQL placeholders | `{{p}}`, `{{p.from}}`, `{{p.to}}`, `{{p.low}}`, `{{p.high}}` | Dashboard params as bind parameters (D-080); params may have `bind: []` |
| line `options.trend` | `{ type: linear \| moving_average, forecast?, window? }` | Trend line; linear forecasts with a 95% band (D-081) |
| scatter `options.cluster` | `{ k: 2–8 }` | Points colored by k-means cluster (D-085) |
| widget `drill.dimension` | 0–7 | Which query dimension drills (1 = series) (D-088) |
| widget `visibleWhen` | `{ param, is: set \| empty \| in, values? }` | Show the widget only when the control matches (D-089) |
| cross-filter `op: between` | two bucket starts + grain | A brushed time range (D-090) |
| map `options.basemap` | `usa-counties` | 5-digit FIPS or "County, ST"; world maps also take ISO alpha-2/3 (D-092) |
| theme `font` | `inherit`, `humanist`, `geometric`, `slab`, `condensed` | In addition to system, serif, mono, rounded (D-093) |

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

## Interactivity (spec 1.3)

| Where | Field | Meaning |
| --- | --- | --- |
| dashboard | `interactions: { crossFilter: true }` | Clicking a mark filters the other widgets on the same source by the clicked value |
| dashboard | `tabs: [{ id, title }]` + layout item `tab` | Pages; items without `tab` are on the first tab; only the open tab's widgets load |
| dashboard | `mobileLayout: [{ i, order?, h?, hide? }]` | Order, height and visibility when the grid stacks (narrow screens) |
| widget | `drill: { levels: [{ field, grain?, label? }, …] }` | Click goes one level down; `levels[0]` must be the query's first dimension; the output column keeps its name |
| widget | `drillThrough: { dashboardId, params?: { targetParam: column } }` | Click asks the host (`onNavigate`) to open another dashboard |
| widget | `interactions: { crossFilter: false }` | Opt out of cross-filtering |

Params (all bind like built-ins; values are checked against the declaration):

| type | Value | Filter |
| --- | --- | --- |
| `multiselect` (`field`, `options` or `optionsQuery: {query, field}`) | list (empty = no filter) | `in` |
| `range` (`field`, `kind`: number/date, `min?`, `max?`, `step?`) | `[low, high]`, either `null`; `null` = no filter | `between` / `gte` / `lte` |
| `search` (`field`, `match`: contains/starts_with/ends_with) | text ('' = no filter) | the match op |
| `measure` (`as`, `options: [{value, label?, field, agg}]`, binds to `"<q>.measures"`) | an option value | swaps the measure named `as` |

Cross-filter fields are the dimension fields of the dashboard's queries (and widget drill levels) on the same source. A click on a time bucket filters that bucket's date range.

## Formatting (spec 1.3)

All optional, version-gated, and constrained.

- `options.numberFormats` — `{ "<column>": { "decimals": 0–6, "prefix": "$", "suffix": " units", "scale": "none|k|M|B|auto", "percent": true, "thousands": true } }` on every widget that shows values; wins over the column's enum `format`.
- `options.conditionalFormats` (table, pivot) — `[{ "field", "rules": [{ "op": "gt|gte|lt|lte|eq|neq|between", "value": n | [lo, hi], "color"?, "background"? }] }]` or `[{ "field", "scale": { "from", "to", "mid"? } }]` (hex). First matching rule wins.
- KPI `thresholds` (same rules, colors the value) and `comparison: { "field", "label"?, "positiveIs": "up|down", "display": "percent|number" }` (reads the column from the last row).
- Line/bar/area (and combo): `referenceLines` (`{ "axis": "y|x", "value" | "field", "label"?, "color"?, "dashed"? }`), `referenceBands` (`{ "axis", "from", "to", "label"?, "color"? }`), `annotations` (`{ "x", "y"?, "text" }`), `tooltip: { "fields": [...] }`; scatter takes `referenceLines` and `tooltip`.
- `encoding.facet` on line/bar/area: one panel per value (max 12, shared value axis).
- Table: `sparkline: { "by", "value", "label"? }` (one row per remaining columns with a mini line), `sortable` (default true).
