import type { DataSource, Filter } from '@yourorg/bi-spec';
import type { Principal } from './auth';

/**
 * Row-level security (spec 1.3, workstream B). A team policy says which source column is filtered by
 * which principal attribute:
 *
 *   BI_RLS_POLICIES='{"team-a": [{"field": "region", "attribute": "region", "source": {"type": "sample", "ref": "orders"}}]}'
 *
 * A rule without `source` applies to every source of the team that has the column (the query layer
 * reports an unknown column, so scope rules to sources when columns differ). Applied inside runQuery,
 * so every path that runs queries (dashboard data, previews, exports, alerts, subscriptions) enforces
 * it, and before the result cache, so cache keys include the effective row filters.
 *
 * Fails closed: a principal without the attribute (or with no values) gets an error and no rows,
 * never unfiltered data. "*" as an attribute value means "all rows" (admins). A malformed policy
 * throws at startup.
 */

export interface RlsRule {
  field: string;
  attribute: string;
  /** Limit the rule to one source (type and/or ref). Omit to apply to every source of the team. */
  source?: { type?: string; ref?: string };
}

export type RlsPolicies = Record<string, RlsRule[]>;

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function parseRlsPolicies(raw: string | undefined): RlsPolicies {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BI_RLS_POLICIES must be JSON: {"<team>": [{"field": "...", "attribute": "...", "source"?: {"type", "ref"}}]}.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('BI_RLS_POLICIES must be a JSON object keyed by team.');
  const out: RlsPolicies = {};
  for (const [team, rules] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(rules)) throw new Error(`BI_RLS_POLICIES["${team}"] must be a list of rules.`);
    out[team] = rules.map((r, i) => {
      const rule = r as Record<string, unknown>;
      const where = `BI_RLS_POLICIES["${team}"][${i}]`;
      if (typeof rule?.field !== 'string' || !rule.field || rule.field.length > 128) throw new Error(`${where}.field must be a column name.`);
      if (typeof rule.attribute !== 'string' || !NAME.test(rule.attribute)) throw new Error(`${where}.attribute must be an attribute name.`);
      const source = rule.source as Record<string, unknown> | undefined;
      if (source !== undefined && (typeof source !== 'object' || source === null)) throw new Error(`${where}.source must be {"type", "ref"}.`);
      return {
        field: rule.field,
        attribute: rule.attribute,
        ...(source ? { source: { ...(typeof source.type === 'string' ? { type: source.type } : {}), ...(typeof source.ref === 'string' ? { ref: source.ref } : {}) } } : {}),
      };
    });
  }
  return out;
}

let envPolicies: RlsPolicies | undefined;
/** Policies from BI_RLS_POLICIES, parsed once (throws on a malformed value: fail closed). */
export function loadRlsPolicies(env: NodeJS.ProcessEnv = process.env): RlsPolicies {
  if (env === process.env) return (envPolicies ??= parseRlsPolicies(env.BI_RLS_POLICIES));
  return parseRlsPolicies(env.BI_RLS_POLICIES);
}

export type RowAccess = { ok: true; filters: Filter[] } | { ok: false; message: string };

/** The row filters a principal gets on a source, or a denial. */
export function rowAccess(policies: RlsPolicies, teamId: string, principal: Principal | undefined, source: DataSource): RowAccess {
  const rules = (policies[teamId] ?? []).filter(
    (r) => (r.source?.type === undefined || r.source.type === source.type) && (r.source?.ref === undefined || r.source.ref === source.ref),
  );
  const filters: Filter[] = [];
  for (const rule of rules) {
    const values = principal?.attributes?.[rule.attribute];
    if (!values?.length) {
      return { ok: false, message: `Row-level security: your access has no "${rule.attribute}" attribute, so this source shows no rows.` };
    }
    if (values.includes('*')) continue;
    filters.push({ field: rule.field, op: 'in', value: values });
  }
  return { ok: true, filters };
}

/** Whether `narrow` grants no more than `broad` (for share attributes). */
export function attributesWithin(narrow: Record<string, string[]>, broad: Record<string, string[]> | undefined): string | null {
  for (const [name, values] of Object.entries(narrow)) {
    const allowed = broad?.[name];
    if (!allowed?.length) return `You don't have the "${name}" attribute, so you can't grant it.`;
    if (allowed.includes('*')) continue;
    const extra = values.filter((v) => !allowed.includes(v));
    if (extra.length) return `You can't grant ${name}=${extra.join('|')}: your own access doesn't include it.`;
  }
  return null;
}
