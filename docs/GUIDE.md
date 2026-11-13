# Sratchpad: user guide

For developers who build dashboards and the people they share them with.

## Signing in

Open Sratchpad (`https://<your host>/`, or http://localhost:5175 in development). With single sign-on
configured, click **Sign in with your company account**; your team and role come from your company groups.
Without it (or for service accounts) paste an **access token** from your Sratchpad admin. Either way the
sign-in is kept for that browser tab only, and you are sent back to sign in when it expires or is revoked.
**Sign out** is at the top of the dashboard list. If your admin requires it, viewer links also ask you to sign in.

## Building a dashboard

1. **New dashboard** on the list page, or open an existing one.
2. **Pick or upload a source** in the Data panel: the sample `orders` data, your team's uploads, or
   Snowflake tables your team's role can see (type in the filter box above a long list; **↻** re-lists so a new table
   shows up at once). Upload CSV (UTF-8) or Excel (.xlsx, first sheet, row 1 =
   headers), up to 50 MB. Fields appear grouped as time, measures and dimensions.
3. **Add widgets** from the palette or by clicking/dragging a field. Edit the selected widget in the
   inspector (fields, aggregation, filters, sort, formatting). Drag and resize on the grid.
4. **Params**: add a date range or select control in the dashboard inspector and bind it to queries;
   one control re-filters every bound widget.
5. The canvas previews your **unsaved** draft with live data. Validation runs on every change; errors
   point at the field to fix and block saving.
6. **Save** (⌘S): every save is a new version. If someone else saved meanwhile, you can reload theirs or
   save yours on top. **History** opens any earlier version as a draft; nothing is ever overwritten.
7. **JSON** shows the document; edits there apply to the canvas (invalid JSON is ignored until fixed).
8. Undo/redo with ⌘Z / ⇧⌘Z.

**Calculations.** In a widget's query, **+ Calc** adds an expression over its measures (e.g. `revenue / orders`,
`sum(profit) / sum(amount)`). A numeric dimension takes a **bin width** for histograms. Under "Table calcs, top N,
joins, catalog metrics" a small JSON box adds running totals, % of total, rank, moving averages, differences and
year-over-year change, top-N with "Other", joins to another source of the same kind, and team catalog metrics.
Buckets (e.g. amount < 100 → "Small") are written in the JSON view.

**Row fields, level of detail, sets.** **Row fields** (in the query editor) are per-row formulas such as
`amount * fx_rate` or `year(order_date)`; use the name like any column. **Level of detail** (`detail` in the advanced
box) answers "average of each customer's total, by region": detail dimension `customer_id`, detail measure
`sum(amount) as customer_total`, then the widget's measure is `avg` of `customer_total`. Add `"calendar": true` to a
year-over-year window to compare by date when periods are missing. **Sets** (JSON view, top-level `sets`) name a
list of values once ("top customers") and group or filter by it in any widget. Line charts have a **trend** option
(straight line or moving average, with an optional forecast and its range); scatter plots can **cluster** points.

**More interactivity.** Drag across a line chart's dates to filter other widgets by that whole range. A widget's
drill can start on its series (`"dimension": 1`), so clicking a channel's line drills into it. A widget can show only
when a control has a value (`visibleWhen` in the JSON view). Charts are keyboard-operable: Tab to a chart, use the
arrow keys and press Enter to select. Click-to-filter now also works in the Studio canvas. Maps accept ISO country
codes (`DE`, `DEU`) and a US counties basemap. Theme fonts include **inherit** (use your app's font when embedded).

**Custom SQL (developers).** In a widget's **Data** tab, switch the query from **Visual builder** to **SQL**. The
Studio writes a starting SELECT from the current query; edit it, then click **Run and detect columns**. The result
columns appear below it: numbers become measures, the rest dimensions (change the role or type if needed), and the
chart picks them up. Name this dashboard's data sources by their id (`FROM orders`); on Snowflake you can also use
any table your team's role can read (`DB.SCHEMA.TABLE`). Use the engine's SQL (Snowflake SQL on Snowflake, DuckDB
SQL on uploads and sample data); one SELECT only. To filter before aggregating, use a control by its id:
`WHERE order_date BETWEEN {{range.from}} AND {{range.to}} AND region IN ({{regions}})` (values are bound safely; an
empty control is NULL, so write `({{ch}} IS NULL OR channel = {{ch}})` for "all"). Dashboard filters apply to the result, so a date range filter on
`order_date` needs the SQL to return `order_date` (e.g. `date_trunc('month', order_date) AS order_date`); the
Studio flags filters it cannot apply. Not available: drill-down, measure switches, catalog metrics, and SQL on
uploads stored in Snowflake or where row-level security applies to your team. Switching back to the visual builder
removes the SQL. The assistant does not write SQL.

## Styling a dashboard

Every dashboard can have a theme (light or dark mode, series colors, accent, page and card backgrounds,
card style, density, corner radius, font), and every widget its own colors, background, emphasis and
title alignment. Charts can hide gridlines, show data labels, name and hide axes, and fix the y-axis range.
Ask the assistant ("give it a dark navy theme with teal accents"), or edit the **JSON** view (see
[`SPEC.md`](SPEC.md#styling-spec-12)). If you set dark backgrounds, set the mode to dark too; the
validator warns otherwise.

**More chart types and formatting (spec 1.3).** The palette now has maps, heatmaps, treemaps, box plots, waterfalls, funnels, gauges, bullet charts, sankeys, combo (bars + lines, two axes) and images. In the widget inspector's style tab you can add reference lines, conditional formats (color cells by rules or a color scale) and KPI thresholds; number formats, tooltips, annotations and small multiples are set in the JSON view or by asking the assistant ("show revenue in $M with one decimal", "split this chart by region"). Click column headers to sort tables. Clicking a bar, slice, region or row selects it when the dashboard has interactions turned on.

## Interactivity

- **Click to filter:** turn on "Click a chart to filter the others" in the dashboard inspector. Viewers click a bar, slice or point; the other widgets on the same data filter to it (shift-click adds values; click again or × clears). Opt a widget out in its inspector.
- **Drill-down:** in a widget's inspector add drill levels (e.g. Year → Month, Region → Channel). Clicking drills one level; the breadcrumb in the widget header goes back up.
- **Drill-through:** set a dashboard to open on click; host apps decide how to navigate. Viewer links stay on one dashboard.
- **Tabs:** add tabs in the dashboard inspector and assign widgets to them.
- **More controls:** multi-select (choices fixed or from a query, so one control can narrow another), range, search, and a measure switch (e.g. Revenue ↔ Orders).

## Comments, exports, schedules and alerts

**Comments, favorites and views.** *Comments* in the Studio top bar: discuss a dashboard or one widget; edit or delete
your own. Star dashboards in the list (favorites come first), see 30-day views, sort by what you viewed recently.

**Exporting.** Each widget's **⋯** menu downloads its data as CSV or the chart as PNG. **Print / PDF** in the
dashboard header prints, or saves as PDF from the print dialog.

**Schedules (editors).** *Schedule*: email a summary daily, weekly or monthly at a time in your time zone, with KPI
values, a link to the dashboard (valid a few days; each email has a new one) and CSV files of chosen widgets. Emails
show the dashboard as **you** see it. Tick **Attach a PDF report** for a PDF with the KPIs and the chosen tables.
*Scheduled refresh* keeps a busy dashboard's results freshly cached.

**Alerts (editors).** Watch a number (e.g. sum of revenue) and get an email or a webhook when it crosses a threshold
or changes by more than a percentage. You are notified when it starts firing, not on every check. **Snooze** silences
an alert for an hour to a week; **Escalate to** emails another list if it is still firing after a while.

**Usage.** The **Usage** button shows views over 30 days and, per widget, how often its data loaded and how often people
clicked into it (filters, drills).

**Metric catalog.** Define metrics like `revenue` once for the team; queries can reference them by name. **History**
shows every change (who and when) with **Restore**. Your admin can limit changes to named metric owners.

## The assistant (chat)

Open the **Assistant** tab next to the inspector and describe what you want, in your own words:

- "Add KPIs for total revenue and orders across the top"
- "Show revenue by month as a line chart, and make it full width"
- "Make this chart pink and turn on data labels" (*this chart* = the selected widget)
- "Give the dashboard a dark theme with teal accents and compact cards"
- "Add a date range filter for all charts"

It edits your **draft**: the change appears on the canvas, listed under its reply, and **Undo this change**
(or ⌘Z) reverts it in one step. Nothing is saved until you click **Save**. If you edit while it is working,
it won't overwrite you; send the request again. It only uses fields your data actually has (it reads the
source's profile, never the rows). When you ask for something Sratchpad can't do yet, such as forecasts or
level-of-detail calculations (see [`CAPABILITIES.md`](CAPABILITIES.md)), it says so and offers the closest option.
If the panel says the assistant isn't enabled, your admin needs to turn it on. For local testing it can run on a
local model (Llama 3.2 via Ollama, `BI_LLM_PROVIDER=ollama`): good for adding simple charts, much weaker than Claude
at edits and styling.
If the assistant panel or the inspector ever says it "hit an error", click **Try again**; your draft
and the canvas are not affected.

## Suggest a dashboard (AI)

With a source selected, **Suggest a dashboard** profiles it and loads a starter dashboard as an
editable draft (undo restores your previous canvas). The other suggested charts are listed so you can
add them one at a time. The charts themselves are built by fixed rules from your data's profile; when
AI is enabled, Claude orders them and writes the titles. It never sees your rows. If AI is off or
unavailable you get the rule-based suggestion and a note saying so.

## Sharing

Save first; shares show saved versions. Click **Share** and choose:

| Option | For | You get |
| --- | --- | --- |
| **Business viewers** | People who just look | A link that opens the dashboard read-only in the browser (`…/view/#token=…`). They can change the date range and filters. |
| **Applications (JSON)** | Another team's app that renders or parses the dashboard itself | A token for the API, plus copy-paste examples (curl, TypeScript with `validateDashboard`, the React SDK) |

Options: a **label** (who it is for), **version** (follow the latest save, or pin the current one), and
**expiry** (7, 30, 90, 365 days or never). The link or token is **shown once**: copy it then. If it is
lost, revoke it and create another.

The dialog lists every share with who created it, when it expires and when it was last used.
**Revoke** cuts access immediately.

Good practice: anyone holding a viewer link can view that dashboard, so prefer expiring links, give each
audience its own share, and revoke what you no longer need.

For team members who should see everything but change nothing, ask your admin for a **viewer** token
instead of sharing dashboards one by one.

## Embedding in your own app

```tsx
import { Dashboard } from '@yourorg/bi-renderer';

<Dashboard id="dash_9f2a" token={authToken} params={{ dateRange: 'last_30d' }} />
```

See [`API.md`](API.md#embedding-with-the-sdk) for options and for reading the JSON directly.
