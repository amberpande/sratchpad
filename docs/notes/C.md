# Workstream C: visualizations & formatting (spec 1.3) — notes for the lead

## 1. What was built

**New widget types** (all `since: "1.3"`, lazily loaded, in `CHART_TYPES` so they get "View as table" except `image`):

| Type | Encoding / options | Notes |
| --- | --- | --- |
| `map` | `region`+`value` (choropleth) or `lat`+`lon` (+`size`, `label`) (symbol); `basemap: world\|usa`, `kind`, `colors {from,to}`, `tooltip`, `numberFormats` | world-atlas 1:110m / us-atlas 1:10m + d3-geo. Countries match by name (aliases for "USA", "UK", "Dem. Rep. Congo"…) or ISO numeric; US states by name, FIPS or postal code. Unmatched rows counted in a note. |
| `heatmap` | `x`, `y`, `value`; `colors`, `showValues` | Query may group only by x and y (cell lookup, no aggregation). |
| `treemap` | `category`, `value`, `group?`; `maxNodes` (default 60) | d3-hierarchy. Additive value (sum/count). Largest shown; the rest left out with a note (never folded/summed). |
| `boxplot` | `category`, `min`, `q1`, `median`, `q3`, `max` | Statistics come from the query (A's `p25`/`median`/`p75`). |
| `waterfall` | `category`, `value`; `showTotal`, `totalLabel`, `colors {increase,decrease,total}` | Running total is a display offset (like stacking). |
| `funnel` | `stage`, `value`; `showConversion` | Stages in query order; % of previous stage. |
| `gauge` | options `field`, `reduce`, `min`, `max`/`maxField`, `target`/`targetField`, `bands[{to,color}]`, `label` | Half circle. |
| `bullet` | `value`, `target?`, `category?`; `ranges` (≤3), `max` | One row per category. |
| `sankey` | `source`, `target`, `value`; `nodeAlign` | d3-sankey; cycles → "Can't draw these flows". |
| `combo` | `x`, `bars` (1–4), `lines?` (1–4); `secondaryAxis` (default true), `y2Label`, `stacked`, chart chrome, references, tooltip | Recharts ComposedChart. |
| `image` | options `src` (https only), `alt` (required), `fit`, `href` (https), `caption`; no query | URL checked by schema **and** at render; `referrerPolicy=no-referrer`, links `noopener noreferrer`. |

**Formatting on existing types (1.3, all gated with `fieldsSince`):**
- `options.numberFormats: { [column]: { decimals, prefix, suffix, scale: none|k|M|B|auto, percent, thousands } }` on every type with values (KPI, line, bar, area, scatter, pie, table, pivot + all new types). Wins over the enum `format`.
- Line/bar/area: `encoding.facet` (small multiples, ≤12 panels, shared "nice" y domain except when stacked), `referenceLines` (constant, or a column's first-row value), `referenceBands`, `annotations`, `tooltip.fields`. Scatter: `referenceLines`, `tooltip`.
- Table: `conditionalFormats` (threshold rules or 2–3 color scale), `sparkline {by, value, label}` (rows collapse by the remaining columns, no summing), `sortable` (click-to-sort headers, default on; view-as-table tables are sortable too).
- Pivot: `conditionalFormats` on the value column.
- KPI: `thresholds` (value color), `comparison {field, label, positiveIs, display}` (▲/▼ + delta, green/red by direction; reads the column from the last row, e.g. A's `percent_change`).

**Interactions:** every chart (existing and new) reports mark clicks through `useWidgetInteractions()` via a shared `useMarks(field)` helper in `widgets/vizParts.tsx`: `select({ field, value }, { additive: shift/meta/ctrl })`, pointer cursor when `interactive`, dim (opacity 0.3) where `isSelected(...) === false`. Line/area show a vertical accent line at selected x; table rows select by the first non-numeric column; pie's "Other" slice is not selectable.

**Studio:** new types appear automatically. `VizEditors.tsx` adds structured editors for `referenceLines`, `conditionalFormats`, `thresholds` (others stay in the JSON view). B's `DrillEditor` is mounted in the widget inspector (data tab, query widgets only). `widgetTypes.ts`: 1.3 option lists are excluded from "column slot" probing (fixed bar charts defaulting to full width), and the Studio treats `map.region/value` and `bullet.category` as required so new widgets start valid.

**Example:** `examples/dashboards/viz_gallery.json` (seeded in dev) uses every new type except map/image (sample data has no geo columns, no stable image) — verified: saves, all 10 queries run on the sample engine, and it renders in Chrome (screenshots checked, light mode).

## 2. Decisions

**D-C1 Custom number formats are a new keyed option, not a widened `format`.** `options.numberFormats` keyed by result column, constrained object (no format strings). *Why:* the validator's version gate works on `options.<key>` presence; changing the type of an existing field (`format`) could not be gated and would break 1.2 readers. *Alternative:* `format: Format | object` (ungateable), ICU/Excel format strings (unbounded, unsafe to pass around).

**D-C2 New visuals reshape and lay out, never aggregate.** Heatmap/sankey/treemap/waterfall/funnel/bullet/box plot require queries grouped by exactly their dimensions (validation, like pivot); the browser only positions already-aggregated rows. Exceptions documented: waterfall running offsets and funnel conversion ratios (display arithmetic on aggregated rows, like stacking). Treemap drops the tail instead of folding it into "Other" (pie keeps its existing documented fold).

**D-C3 Author colors stay hex and reach CSS only as custom properties.** Conditional formats, KPI thresholds and map ramps set `--bi-cell-fg/--bi-cell-bg` / `--bi-ramp-*` from validated hex; SVG fills use validated hex attributes or theme variables. Default scales use the first series color at rising opacity, so they follow light/dark themes.

**D-C4 Maps bundle public-domain atlases (world 1:110m, US states 1:10m) in a lazy chunk.** ~220 KB raw, loaded only when a dashboard has a map. Matching by name/alias/ISO numeric (world) and name/FIPS/postal (US). *Not done:* ISO alpha-2/3 country codes (no local code table), counties, custom geographies.

**D-C5 Images are https-only, checked twice.** Schema refuses non-https `src`/`href`; the renderer re-checks and refuses anything else, never sends a referrer.

**D-C6 Interactions go through one helper.** All charts use `useMarks(field)` (wrapping B's `useWidgetInteractions`) so selection, additive clicks, cursor and dimming behave the same everywhere.

**D-C7 Studio-only "required" slots for option-dependent encodings.** The spec keeps `map.region/value` and `bullet.category` optional (they depend on `kind`/shape); the Studio fills them for the default so new widgets start valid. `combo.lines` became optional (bars-only combo is valid).

## 3. Changelog lines

- Spec 1.3 visuals: map (choropleth/symbol, world/US), heatmap, treemap, box plot, waterfall, funnel, gauge, bullet, sankey, combo/dual axis, image (https only) (D-C2, D-C4, D-C5).
- Spec 1.3 formatting: `numberFormats`, conditional formats (table/pivot), KPI thresholds and comparison, reference lines/bands, annotations, tooltip fields, small multiples (`facet`), table sparklines, click-to-sort tables (D-C1, D-C3).
- Every chart reports mark clicks to the interaction engine and dims unselected marks (D-C6).
- Studio: structured editors for reference lines, conditional formats and thresholds; DrillEditor mounted; new widgets of every type start valid (D-C7).
- New example `viz_gallery`.
- Fixed while verifying visually: gauge value arc (SVG large-arc flag), facet ticks (nice domain), bullet alignment, reference labels hidden behind bars.
- **Not verified:** maps were checked in jsdom only (region matching, counts, clicks) — not screenshotted (no geo columns in the sample); image widget not loaded from a real host; dark-mode rendering of the new visuals not screenshotted; performance of very large sankeys/treemaps; keyboard selection of marks (clicks only; the table view remains the keyboard path).

## 4. Text for the docs

### SPEC.md — add to "Widget types" table

| Type | Since | Notes |
| --- | --- | --- |
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

### SPEC.md — new section "Formatting (spec 1.3)"

All optional, version-gated, and constrained.

- `options.numberFormats` — `{ "<column>": { "decimals": 0–6, "prefix": "$", "suffix": " units", "scale": "none|k|M|B|auto", "percent": true, "thousands": true } }` on every widget that shows values; wins over the column's enum `format`.
- `options.conditionalFormats` (table, pivot) — `[{ "field", "rules": [{ "op": "gt|gte|lt|lte|eq|neq|between", "value": n | [lo, hi], "color"?, "background"? }] }]` or `[{ "field", "scale": { "from", "to", "mid"? } }]` (hex). First matching rule wins.
- KPI `thresholds` (same rules, colors the value) and `comparison: { "field", "label"?, "positiveIs": "up|down", "display": "percent|number" }` (reads the column from the last row).
- Line/bar/area (and combo): `referenceLines` (`{ "axis": "y|x", "value" | "field", "label"?, "color"?, "dashed"? }`), `referenceBands` (`{ "axis", "from", "to", "label"?, "color"? }`), `annotations` (`{ "x", "y"?, "text" }`), `tooltip: { "fields": [...] }`; scatter takes `referenceLines` and `tooltip`.
- `encoding.facet` on line/bar/area: one panel per value (max 12, shared value axis).
- Table: `sparkline: { "by", "value", "label"? }` (one row per remaining columns with a mini line), `sortable` (default true).

### GUIDE.md — add under "Styling a dashboard"

**More chart types and formatting (spec 1.3).** The palette now has maps, heatmaps, treemaps, box plots, waterfalls, funnels, gauges, bullet charts, sankeys, combo (bars + lines, two axes) and images. In the widget inspector's style tab you can add reference lines, conditional formats (color cells by rules or a color scale) and KPI thresholds; number formats, tooltips, annotations and small multiples are set in the JSON view or by asking the assistant ("show revenue in $M with one decimal", "split this chart by region"). Click column headers to sort tables. Clicking a bar, slice, region or row selects it when the dashboard has interactions turned on.

### ARCHITECTURE.md — renderer row addition

Widgets (`packages/renderer/src/widgets`): Recharts for cartesian/pie/combo, hand-built SVG for heatmap, treemap (d3-hierarchy), box plot, waterfall, gauge, sankey (d3-sankey) and map (d3-geo + bundled world/US atlases in a lazy chunk). Shared helpers in `vizParts.tsx` (sizing, color scales, threshold matching, facets, reference marks, `useMarks` → interaction contract). Author colors reach CSS only as custom properties.

### CAPABILITIES.md — remove from gaps / add to "What you can build"

Remove from gaps: maps (filled and symbol), heatmap, treemap, box plot, waterfall, funnel, gauge, bullet, sankey, combo/dual-axis, small multiples, conditional formatting/color scales, reference lines and bands, annotations, sparklines in tables, rich tooltips, custom number formats/decimals per field, images/logos, click-to-sort tables.
Keep as gaps: custom geographies/counties and ISO alpha country codes, sets/groups, forecasting/trend lines, custom fonts beyond the four families, free CSS (by design).

## 5. Assistant "Not supported" list (services/api/src/ai/spec-reference.ts)

Remove: `maps, heatmaps, treemaps, histograms/binning` (keep "histograms/binning" only if A's bins don't cover it), `box plots, waterfall, funnel, gauge, combo/dual-axis charts`, `conditional formatting`, `reference lines`, `images`. Keep: arbitrary CSS, custom fonts beyond the theme options. Also: `describe()` in spec-reference.ts renders `z.array(z.number()).length(2)` fine, but nested `ZodEffects` objects (threshold rules, reference lines) print as plain objects without their refine rules — acceptable, mention "between takes [low, high]" if the assistant trips on it.

## 6. Requests / notes for the lead

- I changed three assertions in tests I don't own because they used `sankey` as an *unknown* widget type or pinned exact `fieldsSince` maps: `packages/spec/test/validate.test.ts` (`'sankey'` → `'chord-diagram'`), `packages/renderer/test/render.test.tsx` (same), `packages/spec/test/v1_2.test.ts` (`toEqual` → `toMatchObject` for scatter `fieldsSince`).
- `apps/studio/test/reducer.test.ts` failures were fixed by making new-widget defaults valid (D-C7), not by changing expectations.
- One run of the full suite showed a load-related flake in `packages/renderer/test/v1_1.test.tsx` ("renders every new type from ops_mix", lazy chart chunks under heavy parallel load, 3.1 s); it passed alone 3× and in two later full runs. If it recurs, raise that test's `waitFor` timeout.
- `VizEditors.tsx` uses inline layout styles because `apps/studio/src/styles.css` isn't mine; move to classes if preferred.
- Docs (SPEC/GUIDE/ARCHITECTURE/CAPABILITIES/DECISIONS/CHANGELOG) not edited by me — text above.
