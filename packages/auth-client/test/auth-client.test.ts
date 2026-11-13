// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { completeSignIn, decodeJwt, freshToken, pkceChallenge, type OidcClientConfig } from '../src';

// The PKCE flow against a fake provider (jsdom). Not verified against a live provider.
const ISSUER = 'https://idp.example.com';
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } };
}

function provider(tokenResponse: (body: URLSearchParams) => Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json({ authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` });
    const body = new URLSearchParams(String(init?.body));
    calls.push(body);
    return Response.json(tokenResponse(body));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('auth client', () => {
  it('computes the RFC 7636 S256 challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('exchanges the code with the verifier, checks state and nonce, and stores the session', async () => {
    const storage = memoryStorage();
    const { fetchImpl, calls } = provider(() => ({ id_token: idToken({ exp: 4_000_000_000, nonce: 'n1', email: 'ana@example.com' }), refresh_token: 'r1' }));
    const cfg: OidcClientConfig = { issuer: ISSUER, clientId: 'c', scopes: 'openid', redirectUri: 'https://app/cb', fetch: fetchImpl, storage };
    storage.setItem('sratchpad.sso.pending', JSON.stringify({ verifier: 'v1', state: 's1', nonce: 'n1', returnTo: '/#/d/x' }));
    const out = await completeSignIn(cfg, new URL('https://app/cb?code=abc&state=s1'));
    expect(out?.returnTo).toBe('/#/d/x');
    expect(out?.session.name).toBe('ana@example.com');
    expect(calls[0]!.get('code_verifier')).toBe('v1');
    expect(await freshToken(cfg)).toBe(out?.session.idToken);
    expect(decodeJwt(out!.session.idToken).nonce).toBe('n1');
  });

  it('rejects a callback whose state does not match this tab', async () => {
    const storage = memoryStorage();
    const { fetchImpl } = provider(() => ({}));
    storage.setItem('sratchpad.sso.pending', JSON.stringify({ verifier: 'v', state: 'mine', nonce: 'n', returnTo: '/' }));
    await expect(completeSignIn({ issuer: ISSUER, clientId: 'c', scopes: 'openid', redirectUri: 'x', fetch: fetchImpl, storage }, new URL('https://app/cb?code=1&state=theirs'))).rejects.toThrow(/did not match/);
  });

  it('refreshes an expiring token, and signs out when refresh fails', async () => {
    const storage = memoryStorage();
    let ok = true;
    const { fetchImpl } = provider(() => (ok ? { id_token: idToken({ exp: 4_000_000_000 }) } : { error: 'invalid_grant' }));
    const cfg: OidcClientConfig = { issuer: 'https://idp2.example.com', clientId: 'c', scopes: 'openid', redirectUri: 'x', fetch: fetchImpl, storage };
    storage.setItem('sratchpad.sso.session', JSON.stringify({ idToken: 'old', expiresAt: Date.now() - 1, refreshToken: 'r' }));
    expect(await freshToken(cfg)).not.toBe('old');
    ok = false;
    storage.setItem('sratchpad.sso.session', JSON.stringify({ idToken: 'old', expiresAt: Date.now() - 1, refreshToken: 'r' }));
    const failing = (async (url: string | URL) => (String(url).endsWith('configuration') ? Response.json({ authorization_endpoint: 'a', token_endpoint: 't' }) : new Response('{}', { status: 400 }))) as typeof fetch;
    expect(await freshToken({ ...cfg, issuer: 'https://idp3.example.com', fetch: failing })).toBeNull();
  });
});
