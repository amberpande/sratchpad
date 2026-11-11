import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateShareResponse } from '@yourorg/bi-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import salesOverview from '../../../examples/dashboards/dash_9f2a.json';
import { createApp, defaultEngines, DEV_TOKENS, MemoryDashboardStore, MemoryShareStore, StaticTokenVerifier, type AppOptions } from '../src';
import { createWebApp } from '../src/web';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sratchpad-web-'));
  for (const [app, title] of [['studio', 'Studio'], ['viewer', 'Viewer']] as const) {
    await mkdir(join(dir, app, 'assets'), { recursive: true });
    await writeFile(join(dir, app, 'index.html'), `<!doctype html><title>${title}</title>`);
    await writeFile(join(dir, app, 'assets', 'app-abc123.js'), `console.log('${app}')`);
  }
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function apiApp(extra: Partial<AppOptions> = {}) {
  return createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: defaultEngines(),
    shares: new MemoryShareStore(),
    ...extra,
  });
}

describe('single-container web app', () => {
  it('routes /bi-api to the API, /view/ to the viewer and everything else to the Studio', async () => {
    const web = createWebApp({ api: apiApp({ pathPrefix: '/bi-api' }), staticDir: dir });
    const auth = { Authorization: 'Bearer dev-token-team-a' };
    expect(await (await web.request('/bi-api/v1/dashboards', { headers: auth })).json()).toEqual({ dashboards: [] });
    expect((await web.request('/bi-api/v1/dashboards')).status).toBe(401);
    expect((await web.request('/healthz')).status).toBe(200);

    const studio = await web.request('/');
    expect(await studio.text()).toContain('<title>Studio</title>');
    expect(studio.headers.get('X-Frame-Options')).toBe('DENY');
    expect(studio.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(studio.headers.get('Cache-Control')).toBe('no-cache');
    expect(await (await web.request('/some/deep/link')).text()).toContain('Studio');

    const viewer = await web.request('/view/');
    expect(await viewer.text()).toContain('<title>Viewer</title>');
    expect(viewer.headers.get('X-Frame-Options')).toBeNull(); // embeddable in teams' portals
    expect(viewer.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect((await web.request('/view')).status).toBe(301);

    const asset = await web.request('/view/assets/app-abc123.js');
    expect(await asset.text()).toContain("console.log('viewer')");
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('fails fast when the frontends were not built', () => {
    expect(() => createWebApp({ api: apiApp(), staticDir: join(dir, 'missing') })).toThrow(/build the frontends/);
  });
});

describe('share links from the app hostname', () => {
  async function viewerUrl(app: ReturnType<typeof apiApp>, headers: Record<string, string> = {}) {
    const auth = { Authorization: 'Bearer dev-token-team-a', 'Content-Type': 'application/json' };
    await app.request('/v1/dashboards/dash_9f2a', { method: 'PUT', headers: auth, body: JSON.stringify({ spec: salesOverview }) });
    const res = await app.request('/v1/dashboards/dash_9f2a/shares', { method: 'POST', headers: { ...auth, ...headers }, body: JSON.stringify({ audience: 'viewer' }) });
    return ((await res.json()) as CreateShareResponse).viewerUrl;
  }

  it('uses an allowlisted request host and the forwarded scheme', async () => {
    const app = apiApp({ publicHosts: ['Sratchpad.Example.com'] });
    const url = await viewerUrl(app, { Host: 'sratchpad.example.com', 'X-Forwarded-Proto': 'https' });
    expect(url).toMatch(/^https:\/\/sratchpad\.example\.com\/view\/#token=bis_/);
  });

  it('never builds a link from a host that is not on the list', async () => {
    const app = apiApp({ publicHosts: ['sratchpad.example.com'] });
    expect(await viewerUrl(app, { Host: 'evil.example' })).toBeUndefined();
    expect(await viewerUrl(app, { Host: 'sratchpad.example.com', 'X-Forwarded-Host': 'evil.example' })).toBeUndefined();
  });

  it('an explicit BI_VIEWER_URL wins', async () => {
    const app = apiApp({ publicHosts: ['sratchpad.example.com'], viewerUrl: 'https://view.example.com/v' });
    expect(await viewerUrl(app, { Host: 'sratchpad.example.com' })).toMatch(/^https:\/\/view\.example\.com\/v\/#token=/);
  });
});
