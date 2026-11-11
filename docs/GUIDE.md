# Sratchpad: user guide

For developers who build dashboards and the people they share them with.

## Signing in

Open Sratchpad (`https://<your host>/`, or http://localhost:5175 in development). In production the
Studio asks for an **access token** from your Sratchpad admin; it is checked and kept for that browser
tab only. If it expires or is revoked you are sent back to sign in. (Single sign-on will replace tokens.)

## Building a dashboard

1. **New dashboard** on the list page, or open an existing one.
2. **Pick or upload a source** in the Data panel: the sample `orders` data, your team's uploads, or
   Snowflake tables your team's role can see. Upload CSV (UTF-8) or Excel (.xlsx, first sheet, row 1 =
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

## Styling a dashboard

Every dashboard can have a theme (light or dark mode, series colors, accent, page and card backgrounds,
card style, density, corner radius, font), and every widget its own colors, background, emphasis and
title alignment. Charts can hide gridlines, show data labels, name and hide axes, and fix the y-axis range.
Ask the assistant ("give it a dark navy theme with teal accents"), or edit the **JSON** view (see
[`SPEC.md`](SPEC.md#styling-spec-12)). If you set dark backgrounds, set the mode to dark too; the
validator warns otherwise.

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
source's profile, never the rows). When you ask for something Sratchpad can't do yet, such as maps or
click-to-filter (see [`CAPABILITIES.md`](CAPABILITIES.md)), it says so and offers the closest option.
If the panel says the assistant isn't enabled, your admin needs to turn it on.

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
