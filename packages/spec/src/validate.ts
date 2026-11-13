import { z } from 'zod';
import { bindQueryId, dateRangeField } from './params';
import { outputColumns, type OutputColumn } from './query';
import {
  DATA_SOURCE_TYPES,
  DataSourceSchema,
  GRID_COLUMNS,
  ID_PATTERN,
  idSchema,
  LayoutItemSchema,
  PARAM_SCHEMAS,
  QuerySchema,
  WidgetSchema,
  type DataSource,
  type LayoutItem,
  type Param,
  type Query,
} from './schema';
import { DashboardThemeSchema, STYLE_SINCE, themeContrastProblems, WidgetStyleSchema, type DashboardTheme, type WidgetStyle } from './style';
import type { Issue, ValidDashboard } from './types';
import type { ExtContext } from './ext';
import { validateQueryExtension } from './query-ext';
import { paramTypeSince, validateParamExtension } from './params-ext';
import { layoutItemTab, validateDashboardExtension, type DashboardTab } from './dashboard-ext';
import { validateWidgetExtension } from './widget-ext';
import {
  checkCompatibility,
  compareSpecVersions,
  formatSpecVersion,
  parseSpecVersion,
  SUPPORTED_SPEC,
  type Compatibility,
  type SpecVersion,
} from './version';
import { isWidgetTypeSupported, readWidgetPath, WIDGET_TYPES, widgetNeedsQuery, type RenderableWidget, type Widget } from './widgets';

export interface ValidateOptions {
  /** Highest spec version the caller understands. Defaults to this package's version. */
  supported?: SpecVersion;
  /**
   * Accept documents from a newer minor version and render what is understood (renderers: true).
   * The store passes false: it never saves a document it cannot fully check.
   */
  allowNewerMinor?: boolean;
}

export type ValidationResult =
  | { ok: true; dashboard: ValidDashboard; compatibility: Compatibility; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[]; compatibility?: Compatibility };

/** Top-level shape only; each entry is checked separately so one bad entry doesn't hide the rest. */
const TopLevelSchema = z.object({
  specVersion: z.string(),
  id: idSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  dataSources: z.record(z.unknown()),
  queries: z.record(z.unknown()),
  widgets: z.record(z.unknown()),
  layout: z.array(z.unknown()).max(200),
  params: z.record(z.unknown()).default({}),
  theme: z.unknown().optional(),
});

const ParamHeaderSchema = z.object({ type: z.string().min(1) }).passthrough();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function zodIssues(error: z.ZodError, prefix = ''): Issue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    code: issue.code === 'custom' ? 'invalid_value' : issue.code,
    message: issue.message,
  }));
}

/**
 * Structural + semantic validation of a dashboard document.
 *
 * Checks every reference (query → data source, widget → query, encoding → result column,
 * layout → widget, param → query) so a document that validates is one every renderer can draw.
 * All problems are reported in one pass; an entry that is present but malformed reports its own
 * errors without cascading "not defined" errors into the entries that reference it.
 */
export function validateDashboard(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const supported = options.supported ?? SUPPORTED_SPEC;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '', code: 'invalid_type', message: 'A dashboard must be a JSON object.' }], warnings };
  }
  if (typeof input.specVersion !== 'string') {
    return {
      ok: false,
      errors: [{ path: 'specVersion', code: 'missing_spec_version', message: 'specVersion is required, e.g. "1.0".' }],
      warnings,
    };
  }

  // Version gate first: a document from another major may have a different shape entirely.
  const compatibility = checkCompatibility(input.specVersion, supported);
  if (compatibility.level === 'unsupported') {
    return { ok: false, errors: [{ path: 'specVersion', code: 'unsupported_version', message: compatibility.message! }], warnings, compatibility };
  }
  if (compatibility.level === 'degraded' && options.allowNewerMinor === false) {
    return {
      ok: false,
      errors: [
        {
          path: 'specVersion',
          code: 'version_too_new',
          message: `Spec ${input.specVersion} is newer than this service understands (${compatibility.supported}).`,
        },
      ],
      warnings,
      compatibility,
    };
  }
  const strict = compatibility.level === 'full';
  // Unknown types and keys are errors when we fully understand the version, warnings otherwise.
  const unknown = (issue: Issue) => (strict ? errors : warnings).push(issue);
  const docVersion = parseSpecVersion(input.specVersion)!;

  const top = TopLevelSchema.safeParse(input);
  if (!top.success) return { ok: false, errors: zodIssues(top.error), warnings, compatibility };
  const raw = top.data;

  /**
   * A field added in a later minor: an error in a document claiming an older version; ignored with a
   * warning by a reader that predates it. Returns whether the field should be parsed.
   */
  const gate = (path: string, since: string): boolean => {
    const v = parseSpecVersion(since)!;
    if (compareSpecVersions(v, supported) > 0) {
      warnings.push({ path, code: 'unknown_field', message: `"${path}" needs spec ${since}; it is ignored.` });
      return false;
    }
    if (compareSpecVersions(v, docVersion) > 0) {
      errors.push({ path, code: 'field_too_new', message: `"${path}" arrived in spec ${since}; raise specVersion to use it.` });
      return false;
    }
    return true;
  };

  /** Passed to every extension hook (see ext.ts). */
  const ext: ExtContext = { errors, warnings, strict, gate };

  // ── theme (1.2) ──
  let theme: DashboardTheme | undefined;
  if (raw.theme !== undefined && gate('theme', STYLE_SINCE)) {
    const parsed = (strict ? DashboardThemeSchema : DashboardThemeSchema.passthrough()).safeParse(raw.theme);
    if (parsed.success) {
      theme = parsed.data as DashboardTheme;
      for (const p of themeContrastProblems(theme)) warnings.push({ path: p.path, code: 'low_contrast', message: p.message });
    } else errors.push(...zodIssues(parsed.error, 'theme'));
  }

  function parseEntries<S extends z.ZodTypeAny>(section: string, record: Record<string, unknown>, schema: S) {
    const valid: Record<string, z.infer<S>> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!ID_PATTERN.test(key)) {
        errors.push({ path: `${section}.${key}`, code: 'invalid_id', message: `"${key}" is not a valid id (start with a letter; letters, digits, "_" or "-").` });
        continue;
      }
      const result = schema.safeParse(value);
      if (result.success) valid[key] = result.data;
      else errors.push(...zodIssues(result.error, `${section}.${key}`));
    }
    return valid;
  }
  // "Present" = written by the author, even if malformed. References check presence.
  const present = {
    dataSources: new Set(Object.keys(raw.dataSources)),
    queries: new Set(Object.keys(raw.queries)),
    widgets: new Set(Object.keys(raw.widgets)),
  };

  // ── data sources ──
  const dataSources: Record<string, DataSource> = parseEntries('dataSources', raw.dataSources, DataSourceSchema);
  for (const [id, ds] of Object.entries(dataSources)) {
    if (!(DATA_SOURCE_TYPES as readonly string[]).includes(ds.type)) {
      unknown({
        path: `dataSources.${id}.type`,
        code: 'unknown_data_source_type',
        message: `Data source type "${ds.type}" is not one of ${DATA_SOURCE_TYPES.join(', ')}.`,
      });
    }
  }

  // ── queries ──
  const queries: Record<string, Query> = parseEntries('queries', raw.queries, QuerySchema);
  const columnsByQuery = new Map<string, Set<string>>();
  for (const [qid, q] of Object.entries(queries)) {
    const base = `queries.${qid}`;
    if (!present.dataSources.has(q.source)) {
      errors.push({ path: `${base}.source`, code: 'unknown_reference', message: `Data source "${q.source}" is not defined in dataSources.` });
    }
    // Output columns, not just dimensions/measures: a query of catalog metrics or calcs alone is valid.
    if (outputColumns(q).length === 0 && q.sql === undefined) {
      errors.push({ path: base, code: 'empty_query', message: 'A query needs at least one dimension or measure.' });
    }
    q.measures.forEach((m, i) => {
      if (m.field === '*' && m.agg !== 'count') {
        errors.push({ path: `${base}.measures.${i}.field`, code: 'invalid_value', message: '"*" is only valid with agg "count".' });
      }
    });
    const names = new Set<string>();
    for (const col of outputColumns(q)) {
      if (names.has(col.name)) {
        errors.push({ path: base, code: 'duplicate_column', message: `Output column "${col.name}" appears twice; give one an "as" alias.` });
      }
      names.add(col.name);
    }
    q.orderBy.forEach((o, i) => {
      if (!names.has(o.field)) {
        errors.push({
          path: `${base}.orderBy.${i}.field`,
          code: 'unknown_column',
          message: `"${o.field}" is not an output column of this query (${[...names].join(', ')}).`,
        });
      }
    });
    columnsByQuery.set(qid, names);
    const rawQuery = (raw.queries as Record<string, unknown>)[qid];
    validateQueryExtension(qid, q, { ...ext, base, dataSourceIds: present.dataSources, raw: isRecord(rawQuery) ? rawQuery : undefined });
  }

  // ── widgets ──
  const widgets: Record<string, RenderableWidget> = {};
  const queryColumns = new Map<string, OutputColumn[]>();
  for (const [qid, q] of Object.entries(queries)) queryColumns.set(qid, outputColumns(q));
  for (const [wid, w] of Object.entries(parseEntries('widgets', raw.widgets, WidgetSchema))) {
    const base = `widgets.${wid}`;
    // "Known" is relative to the reader: a type newer than `supported` is unknown to it, exactly
    // as it would be to an older SDK build, so it degrades to a placeholder.
    if (!isWidgetTypeSupported(w.type, supported)) {
      unknown({
        path: `${base}.type`,
        code: 'unknown_widget_type',
        message: `Widget type "${w.type}" is not part of spec ${formatSpecVersion(supported)}.`,
      });
      widgets[wid] = {
        type: '__unsupported__',
        originalType: w.type,
        ...(w.query ? { query: w.query } : {}),
        ...(typeof w.options?.title === 'string' ? { title: w.options.title } : {}),
        reason: `"${w.type}" widgets need a newer renderer.`,
      };
      continue;
    }
    const def = WIDGET_TYPES[w.type];
    if (compareSpecVersions(parseSpecVersion(def.since)!, docVersion) > 0) {
      errors.push({ path: `${base}.type`, code: 'widget_type_too_new', message: `"${w.type}" arrived in spec ${def.since}; raise specVersion to use it.` });
      continue;
    }
    // Fields added in a later minor: an error in a document that claims an older version, and
    // dropped (with a warning) when the reader itself predates them.
    const rawWidget = w as Record<string, unknown>;
    const laterFields: string[] = [];
    for (const [path, since] of Object.entries(def.fieldsSince ?? {})) {
      if (readWidgetPath(rawWidget, path) === undefined) continue;
      const v = parseSpecVersion(since)!;
      if (compareSpecVersions(v, supported) > 0) {
        warnings.push({ path: `${base}.${path}`, code: 'unknown_field', message: `"${path}" needs spec ${since}; it is ignored.` });
        laterFields.push(path);
      } else if (compareSpecVersions(v, docVersion) > 0) {
        errors.push({ path: `${base}.${path}`, code: 'field_too_new', message: `"${path}" arrived in spec ${since}; raise specVersion to use it.` });
      }
    }
    if (laterFields.length) {
      for (const path of laterFields) {
        const [section, key] = path.split('.') as ['encoding' | 'options', string];
        const { [key]: _dropped, ...rest } = (w[section] ?? {}) as Record<string, unknown>;
        w[section] = rest;
      }
    }
    let style: WidgetStyle | undefined;
    if (w.style !== undefined && gate(`${base}.style`, STYLE_SINCE)) {
      const parsed = (strict ? WidgetStyleSchema : WidgetStyleSchema.passthrough()).safeParse(w.style);
      if (parsed.success) style = parsed.data as WidgetStyle;
      else {
        errors.push(...zodIssues(parsed.error, `${base}.style`));
        continue;
      }
    }
    const extFields = validateWidgetExtension(rawWidget, { ...ext, base, queryId: typeof w.query === 'string' ? w.query : undefined, queries });
    if (extFields === null) continue;
    const styled = { ...(style ? { style } : {}), ...extFields };
    const needsQuery = widgetNeedsQuery(w.type);
    if (!needsQuery) {
      if (w.query) unknown({ path: `${base}.query`, code: 'unexpected_query', message: `"${w.type}" widgets take no query.` });
    } else if (!w.query) {
      errors.push({ path: `${base}.query`, code: 'missing_query', message: `"${w.type}" widgets need a query.` });
      continue;
    } else if (!present.queries.has(w.query)) {
      errors.push({ path: `${base}.query`, code: 'unknown_reference', message: `Query "${w.query}" is not defined in queries.` });
      continue;
    }
    let encoding: Record<string, unknown> | undefined;
    let shapeOk = true;
    if (def.encoding) {
      const result = (strict ? def.encoding.strict() : def.encoding).safeParse(w.encoding ?? {});
      if (result.success) encoding = result.data;
      else {
        errors.push(...zodIssues(result.error, `${base}.encoding`));
        shapeOk = false;
      }
    } else if (w.encoding && Object.keys(w.encoding).length > 0) {
      unknown({ path: `${base}.encoding`, code: 'unexpected_encoding', message: `"${w.type}" widgets take no encoding.` });
    }
    const opts = (strict ? def.options.strict() : def.options).safeParse(w.options ?? {});
    if (!opts.success) {
      errors.push(...zodIssues(opts.error, `${base}.options`));
      shapeOk = false;
    }
    if (!shapeOk || !opts.success) continue;

    if (!needsQuery) {
      widgets[wid] = { type: w.type, options: opts.data, ...styled } as Widget;
      continue;
    }
    const queryId = w.query!;
    // Column checks need the query's output; a malformed query already reported its own errors.
    const columns = columnsByQuery.get(queryId);
    if (columns) {
      for (const ref of def.fieldRefs({ encoding, options: opts.data })) {
        if (!columns.has(ref.field)) {
          errors.push({
            path: `${base}.${ref.path}`,
            code: 'unknown_column',
            message: `"${ref.field}" is not an output column of query "${queryId}" (${[...columns].join(', ')}).`,
          });
        }
      }
    }
    if (def.check) {
      const issues = def.check({ encoding, options: opts.data }, { columns: queryColumns.get(queryId), query: queries[queryId] });
      for (const issue of issues) errors.push({ ...issue, path: `${base}.${issue.path}` });
    }
    widgets[wid] = { type: w.type, query: queryId, ...(encoding ? { encoding } : {}), options: opts.data, ...styled } as Widget;
  }

  // ── layout ──
  const layout: LayoutItem[] = [];
  const layoutIndex: number[] = []; // original position of each parsed item, for issue paths
  const placed = new Set<string>();
  raw.layout.forEach((value, i) => {
    const base = `layout.${i}`;
    const result = LayoutItemSchema.safeParse(value);
    if (!result.success) {
      errors.push(...zodIssues(result.error, base));
      // Still count it as placed so it isn't also reported as unplaced.
      if (isRecord(value) && typeof value.i === 'string') placed.add(value.i);
      return;
    }
    const item = result.data;
    if (!present.widgets.has(item.i)) {
      errors.push({ path: `${base}.i`, code: 'unknown_reference', message: `Widget "${item.i}" is not defined in widgets.` });
    }
    if (placed.has(item.i)) {
      errors.push({ path: `${base}.i`, code: 'duplicate_layout_item', message: `Widget "${item.i}" is placed more than once.` });
    }
    placed.add(item.i);
    if (item.x + item.w > GRID_COLUMNS) {
      errors.push({ path: base, code: 'out_of_bounds', message: `x + w must be at most ${GRID_COLUMNS} (got ${item.x} + ${item.w}).` });
    }
    layout.push(item);
    layoutIndex.push(i);
  });
  // Items on different tabs (1.3) never share the screen, so they cannot overlap.
  const tabs = Array.isArray(input.tabs) ? (input.tabs as DashboardTab[]) : undefined;
  for (let a = 0; a < layout.length; a++) {
    for (let b = a + 1; b < layout.length; b++) {
      const A = layout[a]!;
      const B = layout[b]!;
      if (layoutItemTab(A, tabs) !== layoutItemTab(B, tabs)) continue;
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) {
        warnings.push({ path: `layout.${layoutIndex[b]}`, code: 'overlap', message: `"${B.i}" overlaps "${A.i}".` });
      }
    }
  }
  for (const wid of present.widgets) {
    if (!placed.has(wid)) {
      warnings.push({ path: `widgets.${wid}`, code: 'unplaced_widget', message: `Widget "${wid}" is not in the layout and will not render.` });
    }
  }

  // ── params ──
  const params: Record<string, Param> = {};
  for (const [pid, p] of Object.entries(parseEntries('params', raw.params, ParamHeaderSchema))) {
    const base = `params.${pid}`;
    const schema = (PARAM_SCHEMAS as Record<string, z.AnyZodObject | undefined>)[p.type];
    const paramSince = paramTypeSince(p.type);
    if (schema && paramSince && !gate(`${base}.type`, paramSince)) continue;
    if (!schema) {
      unknown({ path: `${base}.type`, code: 'unknown_param_type', message: `Param type "${p.type}" is not supported; it is ignored.` });
      continue;
    }
    const result = (strict ? schema.strict() : schema).safeParse(p);
    if (!result.success) {
      errors.push(...zodIssues(result.error, base));
      continue;
    }
    const param = result.data as Param;
    param.bind.forEach((target, i) => {
      const qid = bindQueryId(target);
      if (!present.queries.has(qid)) {
        errors.push({ path: `${base}.bind.${i}`, code: 'unknown_reference', message: `Query "${qid}" is not defined in queries.` });
        return;
      }
      const q = queries[qid];
      // Custom SQL (1.4): a bound filter applies to the SQL's result, so its column must be declared there.
      if (q && typeof q.sql === 'string') {
        const declared = new Set((q.columns ?? []).map((c) => c.name));
        const field = param.type === 'daterange' ? dateRangeField(param, q) : (param as { field?: unknown }).field;
        if (param.type === 'measure') {
          errors.push({ path: `${base}.bind.${i}`, code: 'invalid_value', message: `Query "${qid}" is custom SQL; a measure switch cannot change it. Unbind it from this query.` });
        } else if (typeof field === 'string' && !declared.has(field)) {
          errors.push({
            path: `${base}.bind.${i}`,
            code: 'unknown_column',
            message: `Query "${qid}" is custom SQL and returns no "${field}" column for this filter. Return it from the SQL (e.g. "... AS ${field}"), declare it, or unbind the filter from this query.`,
          });
        } else if (field === undefined && param.type === 'daterange') {
          errors.push({ path: `${base}.bind.${i}`, code: 'unresolvable_field', message: `Query "${qid}" is custom SQL with no declared time column; set "field" on the param or declare a column with type "time".` });
        }
        return;
      }
      if (q && param.type === 'daterange' && !dateRangeField(param, q)) {
        errors.push({
          path: `${base}.bind.${i}`,
          code: 'unresolvable_field',
          message: `Query "${qid}" has no time dimension; set "field" on the param to name the date column it filters.`,
        });
      }
    });
    if (param.type === 'select' && param.options && param.default !== null && !param.options.includes(param.default)) {
      errors.push({ path: `${base}.default`, code: 'invalid_value', message: 'default must be null or one of options.' });
    }
    if (param.type !== 'select' && param.type !== 'daterange') validateParamExtension(pid, param as unknown as Record<string, unknown>, { ...ext, base, queries });
    params[pid] = param;
  }

  // Dashboard-level extensions (workstream B), read from the raw input's top-level keys.
  const dashboardExtension = validateDashboardExtension(input, { ...ext, widgets, queries, layout });
  if (errors.length) return { ok: false, errors, warnings, compatibility };

  return {
    ok: true,
    compatibility,
    warnings,
    dashboard: {
      specVersion: raw.specVersion,
      id: raw.id,
      title: raw.title,
      ...(raw.description ? { description: raw.description } : {}),
      dataSources,
      queries,
      widgets,
      layout,
      params,
      ...(theme ? { theme } : {}),
      ...dashboardExtension,
    },
  };
}
