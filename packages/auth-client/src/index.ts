/**
 * Browser single sign-on (D-074): the OIDC authorization code flow with PKCE, for a public client
 * (no secret in the browser). Works with any OIDC provider whose token endpoint allows browser
 * calls (Cognito, Okta, Entra ID "SPA" platform, Auth0, Keycloak).
 *
 * The ID token is what the API verifies (its `aud` is always the client id); it lives in
 * sessionStorage for this tab only. A refresh token, when the provider issues one, renews it.
 */

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  scopes: string;
  /** Where the provider sends the browser back (must be registered with the provider). */
  redirectUri: string;
  /** Storage key prefix, so the Studio and the viewer keep separate sessions. */
  storageKey?: string;
  fetch?: typeof fetch;
  storage?: Storage;
}

export interface OidcSession {
  idToken: string;
  /** Epoch ms. */
  expiresAt: number;
  refreshToken?: string;
  /** Display name or email from the ID token. */
  name?: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

const discoveries = new Map<string, Promise<Discovery>>();

function discover(cfg: OidcClientConfig): Promise<Discovery> {
  let d = discoveries.get(cfg.issuer);
  if (!d) {
    d = (async () => {
      const res = await (cfg.fetch ?? fetch)(`${cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`Sign-in is unavailable (discovery ${res.status}).`);
      return (await res.json()) as Discovery;
    })();
    d.catch(() => discoveries.delete(cfg.issuer));
    discoveries.set(cfg.issuer, d);
  }
  return d;
}

const store = (cfg: OidcClientConfig) => cfg.storage ?? sessionStorage;
const key = (cfg: OidcClientConfig, name: string) => `${cfg.storageKey ?? 'sratchpad.sso'}.${name}`;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Claims of a JWT without verifying it (the API verifies; the browser only reads expiry and name). */
export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
  return JSON.parse(decodeURIComponent([...json].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))) as Record<string, unknown>;
}

function toSession(json: Record<string, unknown>, previousRefresh?: string): OidcSession {
  const idToken = String(json.id_token ?? '');
  if (!idToken) throw new Error('The sign-in response had no ID token (request the "openid" scope).');
  const claims = decodeJwt(idToken);
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + 3_600_000;
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : previousRefresh;
  const name = typeof claims.name === 'string' ? claims.name : typeof claims.email === 'string' ? claims.email : undefined;
  return { idToken, expiresAt: exp, ...(refresh ? { refreshToken: refresh } : {}), ...(name ? { name } : {}) };
}

function save(cfg: OidcClientConfig, session: OidcSession | null) {
  try {
    if (session) store(cfg).setItem(key(cfg, 'session'), JSON.stringify(session));
    else store(cfg).removeItem(key(cfg, 'session'));
  } catch {
    /* storage blocked: the session lives only in memory for this page */
  }
}

/** The stored session, if any (it may be expired: call `freshToken`). */
export function currentSession(cfg: OidcClientConfig): OidcSession | null {
  try {
    const raw = store(cfg).getItem(key(cfg, 'session'));
    return raw ? (JSON.parse(raw) as OidcSession) : null;
  } catch {
    return null;
  }
}

/** Sends the browser to the provider's sign-in page. `returnTo` is restored after sign-in. */
export async function startSignIn(cfg: OidcClientConfig, returnTo: string = location.href): Promise<void> {
  const d = await discover(cfg);
  const verifier = randomString(48);
  const state = randomString(16);
  const nonce = randomString(16);
  store(cfg).setItem(key(cfg, 'pending'), JSON.stringify({ verifier, state, nonce, returnTo }));
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  location.assign(url.toString());
}

/**
 * Finishes a sign-in when the URL carries the provider's `code` and `state`. Returns the session and
 * where to go back to, or null when this page load is not a sign-in callback.
 */
export async function completeSignIn(cfg: OidcClientConfig, url: URL = new URL(location.href)): Promise<{ session: OidcSession; returnTo: string } | null> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (!code && !error) return null;
  const pendingRaw = store(cfg).getItem(key(cfg, 'pending'));
  store(cfg).removeItem(key(cfg, 'pending'));
  if (error) throw new Error(url.searchParams.get('error_description') ?? `Sign-in failed (${error}).`);
  const pending = pendingRaw ? (JSON.parse(pendingRaw) as { verifier: string; state: string; nonce: string; returnTo: string }) : null;
  if (!pending || pending.state !== state) throw new Error('Sign-in failed: the response did not match this browser tab. Try again.');
  const d = await discover(cfg);
  const res = await (cfg.fetch ?? fetch)(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, code_verifier: pending.verifier }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error_description ?? json.error ?? `Sign-in failed (${res.status}).`));
  const session = toSession(json);
  if (decodeJwt(session.idToken).nonce !== pending.nonce) throw new Error('Sign-in failed: the ID token was not issued for this sign-in.');
  save(cfg, session);
  return { session, returnTo: pending.returnTo };
}

/** A usable ID token: the stored one, renewed with the refresh token when it is about to expire. Null = sign in. */
export async function freshToken(cfg: OidcClientConfig, marginMs = 60_000): Promise<string | null> {
  const session = currentSession(cfg);
  if (!session) return null;
  if (session.expiresAt - marginMs > Date.now()) return session.idToken;
  if (!session.refreshToken) return null;
  try {
    const d = await discover(cfg);
    const res = await (cfg.fetch ?? fetch)(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: cfg.clientId, scope: cfg.scopes }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const next = toSession((await res.json()) as Record<string, unknown>, session.refreshToken);
    save(cfg, next);
    return next.idToken;
  } catch {
    save(cfg, null);
    return null;
  }
}

/** Clears the session and, when the provider supports it, signs out there too. */
export async function signOut(cfg: OidcClientConfig, returnTo: string = location.origin): Promise<void> {
  const session = currentSession(cfg);
  save(cfg, null);
  const d = await discover(cfg).catch(() => null);
  if (d?.end_session_endpoint && session) {
    const url = new URL(d.end_session_endpoint);
    url.search = new URLSearchParams({ id_token_hint: session.idToken, client_id: cfg.clientId, post_logout_redirect_uri: returnTo }).toString();
    location.assign(url.toString());
  }
}

/** GET /auth/config from the API. */
export type AuthInfo = { mode: 'token' } | { mode: 'oidc'; issuer: string; clientId: string; scopes: string; viewerLogin: boolean };

export async function loadAuthInfo(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<AuthInfo> {
  try {
    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/auth/config`);
    if (!res.ok) return { mode: 'token' };
    return (await res.json()) as AuthInfo;
  } catch {
    return { mode: 'token' };
  }
}
