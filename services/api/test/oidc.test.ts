import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp, defaultEngines, MemoryDashboardStore, StaticTokenVerifier } from '../src';
import { ChainVerifier, OidcVerifier, parseGroupMap } from '../src/oidc';
import { MemoryShareStore } from '../src/sharing/store';

// SSO (D-074, D-075) against a fake identity provider: real RSA/EC keys and signatures, discovery
// and JWKS served by a stubbed fetch. Not verified against a live Cognito/Okta/Entra tenant.
const ISSUER = 'https://idp.example.com/tenant';
const CLIENT = 'sratchpad-client';
const NOW = new Date('2026-11-13T10:00:00Z');
const t = Math.floor(NOW.getTime() / 1000);

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function jwt(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: KeyObject } = {}) {
  const alg = opts.alg ?? 'RS256';
  const head = b64({ alg, kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = b64({ iss: ISSUER, aud: CLIENT, sub: 'u-1', email: 'ana@example.com', exp: t + 3600, iat: t, ...claims });
  const data = Buffer.from(`${head}.${body}`);
  const sig =
    alg === 'none'
      ? Buffer.alloc(0)
      : alg === 'ES256'
        ? sign('sha256', data, { key: opts.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' })
        : sign('sha256', data, opts.key ?? rsa.privateKey);
  return `${head}.${body}.${sig.toString('base64url')}`;
}

function idp(keys: Array<{ kid: string; key: KeyObject }>) {
  let jwksCalls = 0;
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` });
    }
    if (u === `${ISSUER}/jwks`) {
      jwksCalls += 1;
      return Response.json({ keys: keys.map(({ kid, key }) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig' })) });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, keys, calls: () => jwksCalls };
}

const groupMap = parseGroupMap(
  JSON.stringify({ 'bi-a-editors': { team: 'team-a', role: 'editor' }, 'bi-a-viewers': { team: 'team-a', role: 'viewer' }, 'bi-b-viewers': { team: 'team-b', role: 'viewer' } }),
);

function verifier(server = idp([{ kid: 'k1', key: rsa.publicKey }, { kid: 'e1', key: ec.publicKey }])) {
  return new OidcVerifier({ issuer: ISSUER, clientId: CLIENT, groupMap, attributeClaims: { region: 'custom:region' }, fetch: server.fetchImpl, now: () => NOW });
}

describe('OIDC verifier', () => {
  it('maps a valid token to team, role, subject and row-level attributes', async () => {
    const p = await verifier().verify(jwt({ groups: ['bi-a-viewers', 'bi-a-editors'], 'custom:region': 'EU|US' }));
    expect(p).toEqual({ teamId: 'team-a', subject: 'ana@example.com', role: 'editor', attributes: { region: ['EU', 'US'] } });
  });

  it('accepts ES256 and Cognito access tokens (client_id instead of aud)', async () => {
    expect(await verifier().verify(jwt({ groups: ['bi-b-viewers'] }, { alg: 'ES256', kid: 'e1' }))).toMatchObject({ teamId: 'team-b', role: 'viewer' });
    expect(await verifier().verify(jwt({ aud: undefined, client_id: CLIENT, groups: ['bi-a-viewers'] }))).toMatchObject({ teamId: 'team-a' });
  });

  it('rejects wrong issuer, audience, expired, not-yet-valid, unmapped groups, tampering, alg none and foreign keys', async () => {
    const v = verifier();
    const bad = [
      jwt({ iss: 'https://evil.example.com', groups: ['bi-a-editors'] }),
      jwt({ aud: 'someone-else', groups: ['bi-a-editors'] }),
      jwt({ exp: t - 3600, groups: ['bi-a-editors'] }),
      jwt({ nbf: t + 3600, groups: ['bi-a-editors'] }),
      jwt({ groups: ['unrelated'] }),
      jwt({ groups: ['bi-a-editors'] }, { alg: 'none' }),
      jwt({ groups: ['bi-a-editors'] }, { key: other.privateKey }),
      'not.a.jwt',
    ];
    const tampered = jwt({ groups: ['bi-a-viewers'] }).split('.');
    tampered[1] = b64({ iss: ISSUER, aud: CLIENT, sub: 'u-1', exp: t + 3600, groups: ['bi-a-editors'] });
    bad.push(tampered.join('.'));
    for (const token of bad) expect(await v.verify(token)).toBeNull();
  });

  it('refetches keys once for an unknown kid (rotation), and caches otherwise', async () => {
    const server = idp([{ kid: 'k1', key: rsa.publicKey }]);
    const v = verifier(server);
    await v.verify(jwt({ groups: ['bi-a-editors'] }));
    await v.verify(jwt({ groups: ['bi-a-editors'] }));
    expect(server.calls()).toBe(1);
    server.keys.push({ kid: 'k2', key: other.publicKey });
    expect(await v.verify(jwt({ groups: ['bi-a-editors'] }, { kid: 'k2', key: other.privateKey }))).toMatchObject({ teamId: 'team-a' });
    expect(server.calls()).toBe(2);
  });

  it('refuses a malformed group map at startup', () => {
    expect(() => parseGroupMap('{"g": {"team": "bad team!"}}')).toThrow();
    expect(() => parseGroupMap(undefined)).toThrow();
  });
});

describe('SSO through the API', () => {
  const v = verifier();
  const shares = new MemoryShareStore();
  const make = (viewerLogin: boolean) =>
    createApp({
      store: new MemoryDashboardStore(),
      engines: defaultEngines(() => NOW),
      auth: new ChainVerifier([StaticTokenVerifier.parse('svc:team-a:svc'), v]),
      authInfo: { mode: 'oidc', issuer: ISSUER, clientId: CLIENT, scopes: 'openid', viewerLogin },
      viewerLogin: viewerLogin ? v : undefined,
      shares,
      now: () => NOW,
    });

  it('serves public sign-in settings and accepts SSO and service tokens', async () => {
    const app = make(false);
    expect(await (await app.request('/auth/config')).json()).toMatchObject({ mode: 'oidc', issuer: ISSUER, clientId: CLIENT });
    const sso = await app.request('/v1/dashboards', { headers: { Authorization: `Bearer ${jwt({ groups: ['bi-a-viewers'] })}` } });
    expect(sso.status).toBe(200);
    expect((await app.request('/v1/dashboards', { headers: { Authorization: 'Bearer svc' } })).status).toBe(200);
    expect((await app.request('/v1/dashboards', { headers: { Authorization: `Bearer ${jwt({ groups: ['nope'] })}` } })).status).toBe(401);
  });

  it('with BI_VIEWER_LOGIN, a share token needs a signed-in viewer of the same team', async () => {
    const app = make(true);
    const editor = `Bearer ${jwt({ groups: ['bi-a-editors'] })}`;
    const save = await app.request('/v1/dashboards/d1', {
      method: 'PUT',
      headers: { Authorization: editor, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: { specVersion: '1.0', id: 'd1', title: 'D', dataSources: {}, queries: {}, widgets: {}, layout: [] } }),
    });
    expect(save.status).toBeLessThan(300);
    const created = await app.request('/v1/dashboards/d1/shares', { method: 'POST', headers: { Authorization: editor, 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: 'viewer' }) });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };
    const get = (user?: string) => app.request('/v1/dashboards/d1', { headers: { Authorization: `Bearer ${token}`, ...(user ? { 'X-BI-User': `Bearer ${user}` } : {}) } });
    expect((await get()).status).toBe(401);
    expect((await get(jwt({ groups: ['bi-b-viewers'] }))).status).toBe(401);
    expect((await get(jwt({ groups: ['bi-a-viewers'] }))).status).toBe(200);
  });
});
