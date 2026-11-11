# Workstream B: interactivity and row-level security (spec 1.3)

## 1. What was built

**Spec (`packages/spec`)**
- `params-ext.ts`: four new param types, version-gated at 1.3:
  - `multiselect`: filter `in`. Choices come from a fixed `options` list, or from `optionsQuery: {query, field}`, which reads a saved query's column. Binding that query to another param gives cascading choices.
  - `range`: number or date `[low, high]`, either end open. Compiles to `between` / `gte` / `lte`.
  - `search`: `contains` / `starts_with` / `ends_with`, using workstream A's text filter ops.
  - `measure`: swaps the measure aliased `as` in the bound queries (`"<q>.measures"`) among author-declared options. The output column keeps its name, so widgets don't change.
- `params.ts`: covers the new types in `coerceParamValue` (every value is checked against the declared config), `paramFilters`, `applyParams` (measure swap) and `bindQueryId` (also strips `.measures`). `ParamValue` now allows lists.
- `dashboard-ext.ts`:
  - New dashboard fields: `interactions: {crossFilter}`, `tabs: [{id, title}]`, `tab` on layout items (validated, must name a tab), and `mobileLayout: [{i, order?, h?, hide?}]`.
  - `layoutItemTab()`.
  - The server contract for cross-filters: `crossFilterFields()`, `runtimeFilters()`, `bucketFilters()` and `nextBucket()`.
- `widget-ext.ts`:
  - New widget fields, valid on any widget type: `drill: {levels}` (the first level must equal the query's first dimension), `drillThrough: {dashboardId, params?}`, and `interactions: {crossFilter: false}` (opt-out).
  - `drillQuery()` derives the drill variant, keeping the first dimension's output name.
- `schema.ts`: `tab` on `LayoutItemSchema` (layout section). One edit outside my sections: `drill`, `drillThrough` and `interactions` declared as `unknown` on `WidgetSchema`. Without it zod stripped them before the widget-extension hook ran. See requests.

**Server (`services/api`)**
- `auth.ts`: `Principal.attributes`. `BI_TOKENS` entries now take a fifth part: `token:team:subject:role:region=EU|US;country=FR`, with `*` meaning all values. Added `parseAttributes()`.
- `rls.ts` (new): reads `BI_RLS_POLICIES`, computes per-principal row filters with `rowAccess()` (fail closed), and checks share attributes with `attributesWithin()`.
- `data/run.ts`: `RunContext.principal` and `RunContext.variant` (`{key, filters, drill}`). The order of application is: params, then drill, then cross-filters, then RLS (a denial returns a `rls_denied` line), then the metric catalog, then the cache. A malformed policy returns `rls_misconfigured` and no data. The lead's join guard and `attachJoinSources` come after RLS and are kept.
- `app.ts`:
  - RLS policies are parsed at startup (`options.rls`, or `BI_RLS_POLICIES`); a malformed value stops the app.
  - The data and preview routes accept variant entries: `{query, key, filters?, drill?: {widget, level, path}}`. Both are validated against declared config, and the principal is passed through.
  - The gateway gives share principals their stored attributes.
  - Share creation takes `attributes` (an object or `"region=EU"`). They must be a subset of the creator's attributes (403 otherwise) and default to the creator's own.
- `sharing/store.ts`: `ShareRecord.attributes` is kept in memory and in Postgres, where it **needs the migration listed in the requests**.

**Renderer (`packages/renderer`)**
- `interactionEngine.ts` (new) implements the `interactions.ts` contract. A click drills down (if the widget has `drill` and isn't at the bottom level), else drills through (`onNavigate`), else cross-filters. Shift-click adds values; clicking the same value again clears. Time buckets become grain filters. `runtimeFor(widgetId)` produces the request variant.
- `interactions.ts`: added optional `InteractionEngine.state()` and the `WidgetInteractionState` type. The existing exports are unchanged.
- `interactions-ui.tsx`: `InteractionBadge` (drill breadcrumb with All / ↑, and a filter chip with ×) plus the CSS for tabs and chips.
- `data/client.ts`: `QueryRequest.runtime`. Variants are batched under `requestKey()` (`<q>~<hash>`), sent as objects, and cached separately.
- `DashboardView.tsx`:
  - Requests are made per widget variant.
  - Tabs: a tab bar; only the active tab's widgets render and query.
  - `onNavigate` prop and `InteractionContext` provider.
  - `<DashboardToolbar>` and `widgetId` are kept.
- `Dashboard.tsx`: `onNavigate` prop.
- `layout/Grid.tsx`: a `mobile` prop (order, height, hide when stacked).

**Viewer (`apps/viewer`)**: controls for multiselect (including options loaded from the query, so cascading works), range (number or date inputs), search (debounced by 300 ms) and measure. No `onNavigate`: viewer links stay on one dashboard.

**Studio (`apps/studio`)**
- `components/InteractivityEditors.tsx` (new):
  - `InteractionsSection` (cross-filter toggle) and `TabsSection` (add, rename and remove tabs; assign widgets to tabs).
  - `AddParamButtons` and `ExtraParamEditor` (the four new types, including measure alternatives and choosing an options query).
  - `DrillEditor` (drill levels, drill-through, cross-filter opt-out). **Mounting it in WidgetInspector is a request.**
- Mounted in `DashboardInspector.tsx`. `ParamControls.tsx` has preview inputs for the new types. `Canvas.tsx` has a tab bar and shows only the active tab. `draft/layout.ts`: `compactLayout` compacts each tab on its own.
- Every edit goes through `replace` and raises `specVersion` to 1.3.

**Tests (new):**
- `packages/spec/test/interactivity.test.ts` (6)
- `services/api/test/interactivity.test.ts` (10: cross-filter bypass attempts, cache separation, drill, params, RLS fail-closed, preview, share-attribute subsetting, cross-filters that can't widen RLS)
- `packages/renderer/test/interactions.test.tsx` (8)
- `apps/viewer/test/params.test.tsx` (1)
- `apps/studio/test/interactivity.test.tsx` (5)

## 2. Decisions

**D-B1 Cross-filters are request variants checked against the declared surface.**
- *Context:* clicking a chart must filter the others, yet clients may only run saved queries.
- *Decision:* the client sends `{query, key, filters}`. The server accepts only `in`/`eq` on dimension fields (source columns) of the dashboard's saved queries, or widget drill levels, on the same source. It allows up to 10 filters with 100 bounded scalar values each, and a time bucket only with a grain the dashboard uses. Cross-filtering must be enabled with `interactions.crossFilter`. The filters are appended to the resolved query before the cache, so the cache key includes them.
- *Alternatives:* free-form filters (unsafe); pre-declared filter params for every pair of widgets (unwieldy).
- *Consequences:* clicks can only narrow to values on declared dimensions; measures, undeclared columns and other ops are refused with a 400.

**D-B2 Drill-down keeps the output column name.**
- *Decision:* `drill.levels[0]` must equal the query's first dimension. Level k replaces that dimension with `levels[k]` aliased to the original output name, and adds a filter (equality, or a bucket range) per clicked value above it. The server derives the variant from the saved levels using `{widget, level, path}`.
- *Consequences:* widget encodings keep working at every level. A drill from a time column to a non-time column changes the column type, and the chart formats it accordingly.

**D-B3 Drill-through is a host callback.**
- *Decision:* `drillThrough` asks the host, through `<Dashboard onNavigate>`, to open another dashboard with mapped params.
- *Consequences:* share tokens are confined to one dashboard, so viewer links can't follow drill-throughs, and the viewer doesn't pass `onNavigate`.

**D-B4 The measure-switch param swaps among declared alternatives only.**
- *Decision:* the param names the output column it swaps (`as`) and the options `{value, field, agg}`. Clients send only an option value. The swapped measure keeps the alias.

**D-B5 Cascading choices come from a saved query.**
- *Decision:* a multiselect's `optionsQuery` reads a column of a saved query through the normal data route. Binding that query to another param narrows the choices.
- *Consequences:* no new API is needed. A param may not read its options from a query it filters itself.

**D-B6 Tabs are a `tab` on layout items.**
- *Decision:* items without a `tab` go on the first tab. Only the active tab's widgets render and query, in both the renderer and the Studio canvas. Overlap is meaningful only within one tab (see requests: validate.ts still warns across tabs).

**D-B7 Row-level security is enforced in `runQuery` and fails closed.**
- *Context:* every path that runs queries must be secured, including previews, exports, alerts and subscriptions.
- *Decision:* a team policy (`BI_RLS_POLICIES`) maps a source column to a principal attribute. It is applied inside `runQuery` after the params, drill and cross-filters, and before the cache. A principal without the attribute gets a `rls_denied` error and no rows. `*` means all rows. A malformed policy stops the server at startup, and returns `rls_misconfigured` if it is only loaded lazily. Callers that pass no principal (background jobs) are denied on governed sources.
- *Alternatives:* filtering in each route (easy to miss a path); Snowflake row access policies (only for Snowflake, and they require a role per user).
- *Consequences:* background jobs must run as a principal (for example the subscription owner). **Profiles bypass RLS:** they are editor-only, but they show category labels and min/max across all rows.

**D-B8 Share links carry a subset of the creator's attributes.**
- *Decision:* a share stores the attributes it was granted: the creator's own by default, or a narrower set they choose. Never more (403).
- *Consequences:* a link shows what its creator could see, or less, and keeps doing so after the creator's own access changes until it is revoked.

**D-B9 Mobile layout is an optional per-widget override.**
- *Decision:* `mobileLayout` sets order, height and hiding for widgets when the grid stacks below 640 px. The default is reading order, as before.

## 3. Changelog lines
- Spec 1.3 interactivity: cross-filtering (`interactions`), drill-down and drill-through (`drill`, `drillThrough`), per-widget opt-out, tabs, mobile layout, and params `multiselect` (including cascading `optionsQuery`), `range`, `search` and `measure` (D-B1 to D-B6, D-B9).
- Row-level security: `BI_RLS_POLICIES`, token attributes, share attributes (subset of the creator's), enforced in `runQuery` and failing closed (D-B7, D-B8).
- Data route: query entries may be variants `{query, key, filters?, drill?}`, and response lines use `key`.
- Renderer: interaction engine, filter and drill chips, tabs, `onNavigate`. Viewer: controls for the new params. Studio: editors for interactions, tabs, the new params and drill.
- **Not verified:**
  - Chart clicks: charts must call `useWidgetInteractions()` (workstream C). The engine is tested through a harness, not through real chart clicks.
  - Postgres persistence of share attributes: needs the migration below, and the Postgres suites weren't run.
  - Snowflake persistence of share attributes: not implemented.
  - RLS against Snowflake or DuckDB-on-Snowflake sources: tested only on the sample engine.

## 4. Text for the docs

### SPEC.md (new section "Interactivity (spec 1.3)")
```markdown
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
```

### API.md (data route and shares)
```markdown
`queries` entries may be variants: `{"query": "q_cat", "key": "q_cat~1", "filters"?: [{"field", "op": "in" | "eq", "values", "grain"?}], "drill"?: {"widget", "level", "path"}}`. Response lines use `key`. Cross-filters need `interactions.crossFilter` and may only use the dashboard's declared dimensions on the same source (max 10 filters × 100 values); drills must follow the widget's saved `drill.levels`. Otherwise `400 invalid_filters` / `invalid_drill`. Row-level security errors are per line: `rls_denied`, `rls_misconfigured`.

`POST /v1/dashboards/:id/shares` also takes `attributes` (`{"region": ["EU"]}` or `"region=EU"`): the row-level security attributes the share sees. Default: the creator's own; never more than the creator has (`403`). Shares list `attributes`.

SDK: `<Dashboard onNavigate={({ dashboardId, params }) => …} />` handles drill-through.
```

### GUIDE.md
```markdown
## Interactivity

- **Click to filter:** turn on "Click a chart to filter the others" in the dashboard inspector. Viewers click a bar, slice or point; the other widgets on the same data filter to it (shift-click adds values; click again or × clears). Opt a widget out in its inspector.
- **Drill-down:** in a widget's inspector add drill levels (e.g. Year → Month, Region → Channel). Clicking drills one level; the breadcrumb in the widget header goes back up.
- **Drill-through:** set a dashboard to open on click; host apps decide how to navigate. Viewer links stay on one dashboard.
- **Tabs:** add tabs in the dashboard inspector and assign widgets to them.
- **More controls:** multi-select (choices fixed or from a query, so one control can narrow another), range, search, and a measure switch (e.g. Revenue ↔ Orders).
```

### ARCHITECTURE.md (security model, new bullets)
```markdown
- **Row-level security:** `BI_RLS_POLICIES` maps a source column to a principal attribute per team (attributes from the token/IdP; shares carry a subset of their creator's). Enforced inside `runQuery`, so dashboard data, previews, exports, alerts and subscriptions all apply it, before the result cache (keys include the row filters). Fails closed: a missing attribute shows no rows (`rls_denied`); a malformed policy stops the server. Profiles (editor-only) are summaries computed over all rows and are not row-filtered.
- **Interactions never widen what runs:** cross-filters and drill variants are derived from author-declared dimensions and drill levels and re-validated on the server; params are checked against their declarations (measure switches only among declared options).
```
Flow addition: "A click on a chart → interaction engine (renderer) → request variant `{query, key, filters | drill}` → server validates against the dashboard → applyParams → drill → cross-filters → RLS → metrics → cache → engine."

### DEPLOYMENT.md (configuration reference)
```markdown
| `BI_RLS_POLICIES` | – | Row-level security per team: `{"team-a": [{"field": "region", "attribute": "region", "source": {"type": "snowflake", "ref": "DB.S.ORDERS"}}]}`. Malformed = the server won't start. |
| `BI_TOKENS` | dev tokens | `token:team:subject[:role[:attributes]]`; attributes `region=EU|US;country=FR`, `*` = all values |
```
In the first-deploy smoke test, add: a token with and without the attribute sees filtered rows or `rls_denied`.

### CAPABILITIES.md (move to supported)
Closed: cross-filtering, drill-down, drill-through, multi-select, range, search and cascading filters, a parameter that switches measures, tabs/multi-page, mobile layouts, row-level security per end user.
Remaining in this area: click-to-sort on tables (charts/tables are workstream C), show/hide containers, drill on a series value (only the first dimension drills), multi-bucket time selections.

## 5. Remove from the assistant's "Not supported" list (`spec-reference.ts`)
`click-to-filter, drill-down, tabs`. Keep `drill-through` described as needing the host.

**Request:** `spec-reference.ts` lists only the `daterange` and `select` params explicitly. Add the four new param schemas (`MultiSelectParamSchema`, `RangeParamSchema`, `SearchParamSchema`, `MeasureParamSchema`; note that measure params bind to `"<q>.measures"`) and the extension fields (`InteractionsSchema`, `TabSchema`, `MobileLayoutItemSchema`, `DrillSchema`, `DrillThroughSchema`, plus `tab` on layout items), so the assistant can write them.

## 6. Requests to the lead and other workstreams
1. **Mount `DrillEditor`** (`apps/studio/src/components/InteractivityEditors.tsx`) in `WidgetInspector.tsx` (workstream C):
   `<DrillEditor draft={draft} widgetId={widgetId} dispatch={dispatch} fields={fields} />`.
2. **Migrations for share attributes:**
   - Postgres (`store/migrations.ts`): `{ id: '00x_share_attributes', sql: 'ALTER TABLE dashboard_shares ADD COLUMN attributes jsonb;' }`. `PostgresShareStore` already writes and reads the column, so share creation on Postgres fails until this lands.
   - Snowflake (`store/snowflake/schema.ts` 003, not yet deployed): add `attributes VARCHAR` to `dashboard_shares`. In `store/snowflake/stores.ts`, add it to `SHARE_COLUMNS`, write `JSON.stringify(r.attributes)`, and read it with `JSON.parse`. Until then Snowflake shares carry no attributes, so they're denied on governed sources (fail closed).
3. **Reducer `setLayout`** (`apps/studio/src/draft/reducer.ts`) rebuilds layout items as `{i, x, y, w, h}` and **drops `tab`** on every drag. Change it to `{ ...it, x: n.x, y: n.y, w: n.w, h: n.h }`. New widgets also land on the first tab, since `placeWidget` doesn't know the canvas's active tab. Acceptable for now.
4. **validate.ts:** skip `overlap` warnings between layout items on different tabs (use `layoutItemTab` from `dashboard-ext.ts`).
5. **schema.ts `WidgetSchema`:** I declared `drill`, `drillThrough` and `interactions` as `z.unknown().optional()` so they survive parsing. Keep that, or have `validate.ts` pass the raw input widget to `validateWidgetExtension` instead.
6. **Renderer `index.ts`:** export `requestKey`, `QueryRuntime` (from `./data/client`), `useInteractionEngine`, `NavigateRequest` (from `./interactionEngine`) and `WidgetInteractionState` (from `./interactions`).
7. **config.ts / server.ts:** optionally read `BI_RLS_POLICIES` in config and pass `rls` to `createApp` (it already loads from the environment at startup, so this is optional).
8. **Workstream C:** charts call `const { interactive, select, isSelected } = useWidgetInteractions()`. Report `select({ field: <result column of the clicked category/x>, value }, { additive: event.shiftKey })`, show a pointer cursor when `interactive`, and dim marks where `isSelected(...) === false`.
9. **Workstream D:** background jobs (exports, alerts, subscriptions) must pass a `principal` (for example the owner's) to `runQuery`; without one, RLS-governed sources return `rls_denied`.
10. **studio previewClient** (not mine) ignores `runtime`, so cross-filter clicks have no effect in the Studio canvas preview. That's acceptable; the Canvas renders single-widget dashboards.
