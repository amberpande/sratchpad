import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import { parseAttributes, type Principal, type Role, type TokenVerifier } from './auth';

/**
 * Single sign-on (D-074): verifies OIDC JWTs from any standards-compliant identity provider
 * (Amazon Cognito, Okta, Microsoft Entra ID, Google, Auth0, Keycloak, …) and maps them to a
 * principal. No vendor SDK: discovery, JWKS and signature checks use node:crypto only.
 *
 *   OIDC_ISSUER        https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AbC  (exact `iss`)
 *   OIDC_CLIENT_ID     the app client id (accepted in `aud`, or `client_id` for Cognito access tokens)
 *   OIDC_GROUPS_CLAIM  claim holding group names (default "groups"; Cognito: "cognito:groups")
 *   OIDC_GROUP_MAP     {"bi-team-a-editors": {"team": "team-a", "role": "editor"}, …}
 *   OIDC_ATTRIBUTE_CLAIMS {"region": "custom:region"}: row-level security attributes from claims
 *
 * A token with no mapped group is rejected (no team, no access). When a user maps to several
 * teams, the first entry of OIDC_GROUP_MAP that matches wins; within a team, editor beats viewer.
 */

export interface OidcGroupMapping {
  team: string;
  role: Role;
}

export interface OidcOptions {
  issuer: string;
  clientId: string;
  groupsClaim?: string;
  groupMap: Record<string, OidcGroupMapping>;
  /** Principal attribute name → claim name. Claim values: a string ("EU|US" or "EU,US") or a list. */
  attributeClaims?: Record<string, string>;
  /** Seconds of clock skew tolerated on exp/nbf/iat. Default 60. */
  clockSkewSeconds?: number;
  /** How long fetched keys are trusted before a refetch. Default 1 hour. */
  jwksTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const ALGORITHMS: Record<string, { hash: string; kty: 'RSA' | 'EC'; pss?: boolean; dsa?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  PS384: { hash: 'sha384', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', dsa: 'ieee-p1363' },
  ES384: { hash: 'sha384', kty: 'EC', dsa: 'ieee-p1363' },
};

const TEAM = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Parses OIDC_GROUP_MAP; throws (server refuses to start) when malformed. */
export function parseGroupMap(raw: string | undefined): Record<string, OidcGroupMapping> {
  if (!raw?.trim()) throw new Error('OIDC_GROUP_MAP is required with OIDC_ISSUER: {"<idp group>": {"team": "team-a", "role": "editor"}}.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OIDC_GROUP_MAP must be JSON: {"<idp group>": {"team": "team-a", "role": "editor"}}.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OIDC_GROUP_MAP must be a JSON object keyed by group.');
  const out: Record<string, OidcGroupMapping> = {};
  for (const [group, v] of Object.entries(parsed as Record<string, unknown>)) {
    const m = v as Record<string, unknown> | null;
    if (!m || typeof m.team !== 'string' || !TEAM.test(m.team)) throw new Error(`OIDC_GROUP_MAP["${group}"].team must be a team id.`);
    const role = m.role ?? 'viewer';
    if (role !== 'editor' && role !== 'viewer') throw new Error(`OIDC_GROUP_MAP["${group}"].role must be "editor" or "viewer".`);
    out[group] = { team: m.team, role };
  }
  return out;
}

export function parseAttributeClaims(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === 'string')) {
    throw new Error('OIDC_ATTRIBUTE_CLAIMS must be JSON: {"<attribute>": "<claim name>"}.');
  }
  return parsed as Record<string, string>;
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(b64url(part).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class OidcVerifier implements TokenVerifier {
  private keys: { at: number; byKid: Map<string, { key: KeyObject; jwk: JsonWebKey }> } | null = null;
  private loading: Promise<void> | null = null;
  private discovery: Promise<{ jwks_uri: string; authorization_endpoint?: string; token_endpoint?: string; end_session_endpoint?: string }> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OidcOptions) {
    this.fetchImpl = options.fetch ?? ((...a) => globalThis.fetch(...a));
    if (!/^https:\/\//.test(options.issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${options.issuer}/`)) {
      throw new Error('OIDC_ISSUER must be an https URL (http only for localhost).');
    }
  }

  /** The provider's discovery document (cached). The Studio uses its endpoints for the browser sign-in. */
  metadata() {
    this.discovery ??= (async () => {
      const res = await this.fetchImpl(`${this.options.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const doc = (await res.json()) as Record<string, unknown>;
      if (doc.issuer !== this.options.issuer) throw new Error(`OIDC discovery issuer "${String(doc.issuer)}" does not match OIDC_ISSUER.`);
      if (typeof doc.jwks_uri !== 'string') throw new Error('OIDC discovery has no jwks_uri.');
      return doc as { jwks_uri: string };
    })();
    this.discovery.catch(() => (this.discovery = null));
    return this.discovery;
  }

  private async loadKeys(force = false): Promise<void> {
    const ttl = this.options.jwksTtlMs ?? 3_600_000;
    if (!force && this.keys && this.now() - this.keys.at < ttl) return;
    this.loading ??= (async () => {
      try {
        const { jwks_uri } = await this.metadata();
        const res = await this.fetchImpl(jwks_uri);
        if (!res.ok) throw new Error(`OIDC JWKS fetch failed: ${res.status}`);
        const { keys } = (await res.json()) as { keys?: JsonWebKey[] };
        const byKid = new Map<string, { key: KeyObject; jwk: JsonWebKey }>();
        for (const jwk of keys ?? []) {
          if (typeof jwk.kid !== 'string' || (jwk.use && jwk.use !== 'sig')) continue;
          try {
            byKid.set(jwk.kid, { key: createPublicKey({ key: jwk, format: 'jwk' }), jwk });
          } catch {
            /* unsupported key type: skip */
          }
        }
        this.keys = { at: this.now(), byKid };
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private now() {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  async verify(token: string): Promise<Principal | null> {
    const claims = await this.verifyClaims(token);
    return claims ? this.principal(claims) : null;
  }

  /** Signature, issuer, audience and time checks; null when any fails. */
  async verifyClaims(token: string): Promise<Record<string, unknown> | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = decodePart(parts[0]!);
    const claims = decodePart(parts[1]!);
    if (!header || !claims) return null;
    const alg = typeof header.alg === 'string' ? ALGORITHMS[header.alg] : undefined;
    if (!alg || typeof header.kid !== 'string') return null; // "none" and HMAC are never accepted
    let entry: { key: KeyObject; jwk: JsonWebKey } | undefined;
    try {
      await this.loadKeys();
      entry = this.keys?.byKid.get(header.kid);
      if (!entry) {
        // Key rotation: refetch once for an unknown kid.
        await this.loadKeys(true);
        entry = this.keys?.byKid.get(header.kid);
      }
    } catch {
      return null;
    }
    if (!entry || entry.jwk.kty !== alg.kty) return null;
    const ok = verifySignature(
      alg.hash,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      alg.pss ? { key: entry.key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: alg.hash === 'sha384' ? 48 : 32 } : alg.dsa ? { key: entry.key, dsaEncoding: alg.dsa } : entry.key,
      b64url(parts[2]!),
    );
    if (!ok) return null;
    const skew = (this.options.clockSkewSeconds ?? 60) * 1000;
    const t = this.now();
    if (claims.iss !== this.options.issuer) return null;
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.options.clientId) : aud === this.options.clientId || (aud === undefined && claims.client_id === this.options.clientId);
    if (!audOk) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 + skew < t) return null;
    if (typeof claims.nbf === 'number' && claims.nbf * 1000 - skew > t) return null;
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    return claims;
  }

  /** Team and role from groups; attributes from claims. Null when no group maps to a team. */
  principal(claims: Record<string, unknown>): Principal | null {
    const raw = claims[this.options.groupsClaim ?? 'groups'];
    const groups = new Set(Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : typeof raw === 'string' ? raw.split(/[ ,]+/).filter(Boolean) : []);
    let team: string | undefined;
    let role: Role = 'viewer';
    for (const [group, m] of Object.entries(this.options.groupMap)) {
      if (!groups.has(group)) continue;
      if (team === undefined) team = m.team;
      if (m.team === team && m.role === 'editor') role = 'editor';
    }
    if (!team) return null;
    let attributes: Record<string, string[]> | undefined;
    for (const [name, claim] of Object.entries(this.options.attributeClaims ?? {})) {
      const v = claims[claim];
      const values = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? v.split(/[|,]/).map((s) => s.trim()).filter(Boolean) : [];
      if (!values.length) continue;
      attributes = { ...(attributes ?? {}), ...parseAttributes(`${name}=${values.join('|')}`, `claim "${claim}"`) };
    }
    const subject = typeof claims.email === 'string' && claims.email ? claims.email : String(claims.sub);
    return { teamId: team, subject, role, ...(attributes ? { attributes } : {}) };
  }
}

/** Tries each verifier in order (static tokens for service accounts and local dev, then SSO). */
export class ChainVerifier implements TokenVerifier {
  constructor(private readonly verifiers: TokenVerifier[]) {}

  async verify(token: string): Promise<Principal | null> {
    for (const v of this.verifiers) {
      const p = await v.verify(token);
      if (p) return p;
    }
    return null;
  }
}
