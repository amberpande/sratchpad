import {
  DashboardThemeSchema,
  DateRangeParamSchema,
  FORMATS,
  DrillSchema,
  DrillThroughSchema,
  InteractionsSchema,
  MeasureParamSchema,
  MobileLayoutItemSchema,
  MultiSelectParamSchema,
  RangeParamSchema,
  SearchParamSchema,
  TabSchema,
  GRID_COLUMNS,
  QuerySchema,
  SelectParamSchema,
  SPEC_VERSION,
  WIDGET_TYPES,
  WidgetStyleSchema,
} from '@yourorg/bi-spec';
import { z } from 'zod';

/**
 * A compact, human-readable reference of the dashboard spec, generated from the live zod schemas so
 * the assistant's knowledge of what it may write can never drift from what the validator accepts.
 */

function unwrap(t: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; dflt?: unknown } {
  let optional = false;
  let dflt: unknown;
  let inner = t;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
      optional = true;
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodDefault) {
      optional = true;
      dflt = inner._def.defaultValue();
      inner = inner._def.innerType;
    } else if (inner instanceof z.ZodEffects) {
      inner = inner.innerType();
    } else break;
  }
  return { inner, optional, dflt };
}

export function describe(t: z.ZodTypeAny, depth = 0): string {
  const { inner } = unwrap(t);
  if (inner instanceof z.ZodString) {
    const regex = inner._def.checks.find((c) => c.kind === 'regex');
    return regex && 'regex' in regex && String(regex.regex).includes('0-9a-fA-F') ? 'hex color' : 'string';
  }
  if (inner instanceof z.ZodNumber) {
    const isInt = inner._def.checks.some((c) => c.kind === 'int');
    const min = inner._def.checks.find((c) => c.kind === 'min');
    const max = inner._def.checks.find((c) => c.kind === 'max');
    const range = min && 'value' in min && max && 'value' in max ? ` ${min.value}–${max.value}` : '';
    return `${isInt ? 'integer' : 'number'}${range}`;
  }
  if (inner instanceof z.ZodBoolean) return 'boolean';
  if (inner instanceof z.ZodNull) return 'null';
  if (inner instanceof z.ZodEnum) return (inner.options as string[]).map((o) => `"${o}"`).join('|');
  if (inner instanceof z.ZodLiteral) return JSON.stringify(inner.value);
  if (inner instanceof z.ZodArray) {
    const max = inner._def.maxLength?.value;
    return `${describe(inner.element, depth)}[]${max ? ` (max ${max})` : ''}`;
  }
  if (inner instanceof z.ZodUnion) return (inner.options as z.ZodTypeAny[]).map((o) => describe(o, depth)).join(' | ');
  if (inner instanceof z.ZodRecord) return `{ [key]: ${describe(inner.valueSchema, depth)} }`;
  if (inner instanceof z.ZodObject) {
    if (depth > 3) return 'object';
    const fields = Object.entries(inner.shape as Record<string, z.ZodTypeAny>).map(([k, v]) => {
      const u = unwrap(v);
      const d = u.dflt !== undefined ? ` = ${JSON.stringify(u.dflt)}` : '';
      return `${k}${u.optional ? '?' : ''}: ${describe(v, depth + 1)}${d}`;
    });
    return `{ ${fields.join('; ')} }`;
  }
  if (inner instanceof z.ZodUnknown || inner instanceof z.ZodAny) return 'any';
  return 'value';
}

let cached: string | undefined;

export function specReference(): string {
  if (cached) return cached;
  const widgets = Object.entries(WIDGET_TYPES)
    .map(([type, def]) => {
      const lines = [`- "${type}" (since ${def.since}${def.query === 'none' ? ', no query' : ', needs a query'})`];
      if (def.encoding) lines.push(`    encoding: ${describe(def.encoding)}`);
      lines.push(`    options: ${describe(def.options)}`);
      if (def.fieldsSince && Object.keys(def.fieldsSince).length) {
        lines.push(`    newer fields: ${Object.entries(def.fieldsSince).map(([p, v]) => `${p} (${v})`).join(', ')}`);
      }
      return lines.join('\n');
    })
    .join('\n');
  cached = `Spec version this build writes: "${SPEC_VERSION}" (older documents stay valid; specVersion is raised automatically when you use newer features).

Document: { specVersion; id; title; description?; dataSources: { [id]: { type: "sample"|"file"|"snowflake"; ref } }; queries: { [id]: Query }; widgets: { [id]: Widget }; layout: LayoutItem[]; params: { [id]: Param }; theme?: Theme }
Ids: start with a letter; letters, digits, "_" or "-"; max 64. Convention: widgets "w_…", queries "q_…".

Query: ${describe(QuerySchema)}
- Queries are semantic, never SQL. A measure's output column is named by "as", else "<agg>_<field>". count of "*" counts rows.
- dimensions with a grain on a date column bucket time; orderBy fields must be output columns.
- Widget encodings and options refer to the query's OUTPUT columns (dimension fields and measure aliases).

Widget: { type; query? (id of a query); encoding?; options; style? }
${widgets}
Formats: ${FORMATS.map((f) => `"${f}"`).join(', ')}.
Rules: pie needs one category dimension and one additive (sum/count) measure. kpi shows one column of a one-row query ("reduce" collapses several rows). line/bar/area "series" splits a single y by a column. text widgets take no query.

Widget style (since 1.2, any widget): ${describe(WidgetStyleSchema)}
Dashboard theme (since 1.2): ${describe(DashboardThemeSchema)}

LayoutItem: { i: widget id; x: 0–${GRID_COLUMNS - 1}; y: integer row; w: 1–${GRID_COLUMNS}; h: rows } on a ${GRID_COLUMNS}-column grid, rows of 72 px. x + w ≤ ${GRID_COLUMNS}; items must not overlap; every widget needs exactly one layout item. Typical sizes: kpi w3 h2, charts w6 h5, wide charts/tables w12 h5–6.

Params (dashboard controls bound into queries):
- daterange: ${describe(DateRangeParamSchema)}
- select: ${describe(SelectParamSchema)}
- multiselect (since 1.3; options fixed or from optionsQuery): ${describe(MultiSelectParamSchema)}
- range (since 1.3): ${describe(RangeParamSchema)}
- search (since 1.3): ${describe(SearchParamSchema)}
- measure (since 1.3; swaps the measure aliased "as" among declared options; binds to "<queryId>.measures"): ${describe(MeasureParamSchema)}
bind targets look like "<queryId>.filters" (measure params: "<queryId>.measures").

Interactivity (since 1.3):
- dashboard interactions: ${describe(InteractionsSchema)} (clicking a mark filters the other widgets on the same source)
- dashboard tabs: ${describe(TabSchema)}[]; layout items take "tab": <tab id> (items without one are on the first tab)
- dashboard mobileLayout: ${describe(MobileLayoutItemSchema)}[] (order/height/hide when stacked on narrow screens)
- widget drill: ${describe(DrillSchema)} (levels[0] must equal the query's first dimension)
- widget drillThrough: ${describe(DrillThroughSchema)} (needs the host app; viewer links can't follow it)
- widget interactions: { crossFilter: false } opts a widget out of cross-filtering

Not supported by the spec today (say so; offer the closest alternative): row-level expressions over columns before aggregation (other than bins/buckets); level-of-detail expressions; joins across different engines (e.g. an upload with a Snowflake table) and joining a row-secured source; calendar-aware period offsets (window offsets count rows); forecasting and trend lines; drill on a series value (only the first dimension drills); show/hide containers; map geographies other than world countries (names/ISO numeric) and US states, ISO alpha country codes, counties; arbitrary CSS and custom fonts beyond the theme options.

Custom SQL queries (query "sql" + "columns") are written by developers themselves in the Studio's SQL mode: never add or edit "sql" or "columns"; build queries from dimensions, measures and calcs. If the developer asks for SQL, tell them to switch the widget's query to SQL in the inspector.`;
  return cached;
}
