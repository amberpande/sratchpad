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

Since 1.2 every widget may carry `style`, and line/bar/area/scatter gain the chart options above.

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
  inlined number the validated `LIMIT` (`limit + 1` to detect truncation).
