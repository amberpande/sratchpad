/**
 * Gateway identity. Every request resolves to a team; every store read and query is scoped
 * by that team, so one shared backend can serve every team without cross-team leaks.
 *
 * Phase 1 uses static tokens. In production, implement TokenVerifier against the org's IdP
 * (OIDC JWT verification) and map a claim to teamId.
 */

export type Role = 'editor' | 'viewer';

export interface Principal {
  teamId: string;
  subject: string;
  /**
   * editor: builds, saves, shares and previews dashboards, uploads data.
   * viewer: read-only member of the team (lists, opens and runs saved dashboards).
   * Defaults to editor when a verifier does not set it.
   */
  role?: Role;
  /** Set when the caller authenticated with a share token: read-only access to one dashboard. */
  share?: { id: string; dashboardId: string; version?: number };
  /**
   * Since 1.3: attributes for row-level security, e.g. { region: ["EU", "US"] }. "*" means all values.
   * RLS policies (rls.ts) filter governed sources by them; a missing attribute sees no rows.
   */
  attributes?: Record<string, string[]>;
}

const ATTR_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Parses "region=EU|US;country=FR" into { region: ["EU","US"], country: ["FR"] }. */
export function parseAttributes(spec: string, where: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const pair of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    const name = eq > 0 ? pair.slice(0, eq) : '';
    const values = eq > 0 ? pair.slice(eq + 1).split('|').map((v) => v.trim()).filter(Boolean) : [];
    if (!ATTR_NAME.test(name) || !values.length) throw new Error(`Bad attribute "${pair}" in ${where}; expected name=value1|value2.`);
    out[name] = [...new Set([...(out[name] ?? []), ...values])];
  }
  return out;
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal | null>;
}

/**
 * Local development tokens: "token:team[:subject[:role[:attributes]]]" entries, comma-separated.
 * attributes: "region=EU|US;country=FR" (row-level security; see rls.ts).
 */
export const DEV_TOKENS = 'dev-token-team-a:team-a:dev-a,dev-token-team-b:team-b:dev-b,dev-token-team-a-viewer:team-a:viewer-a:viewer';

export class StaticTokenVerifier implements TokenVerifier {
  private readonly tokens: Map<string, Principal>;

  constructor(entries: Record<string, Principal>) {
    this.tokens = new Map(Object.entries(entries));
  }

  static parse(spec: string): StaticTokenVerifier {
    const entries: Record<string, Principal> = {};
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [token, teamId, subject, rawRole, ...rest] = part.split(':');
      const role = rawRole || 'editor';
      if (!token || !teamId) throw new Error(`Bad token entry for team "${teamId ?? '?'}"; expected "token:team[:subject[:role[:attributes]]]".`);
      if (role !== 'editor' && role !== 'viewer') throw new Error(`Bad role "${role}" in token entry for team "${teamId}"; expected editor or viewer.`);
      const attrSpec = rest.join(':');
      const attributes = attrSpec ? parseAttributes(attrSpec, `the token entry for team "${teamId}"`) : undefined;
      entries[token] = { teamId, subject: subject || teamId, role, ...(attributes ? { attributes } : {}) };
    }
    return new StaticTokenVerifier(entries);
  }

  async verify(token: string): Promise<Principal | null> {
    return this.tokens.get(token) ?? null;
  }
}
