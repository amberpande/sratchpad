import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import type { App } from './app';

/**
 * The single-container deployment: one process serves everything on one hostname.
 *
 *   /bi-api/*  → the API (the same routes as /v1/*, mounted under the prefix the frontends call)
 *   /view/*    → the hosted viewer for business users (share links: /view/#token=…)
 *   /*         → the Studio
 *   /healthz   → load-balancer health check
 *
 * One origin means no CORS, no separate frontend hosting, and share links that simply use the
 * app's own hostname. Hashed build assets are cached for a year; HTML is never cached, so a deploy
 * is live on the next page load.
 */

export interface WebOptions {
  api: App;
  /** Directory with `studio/` and `viewer/` builds (each containing index.html). */
  staticDir: string;
  viewerPath?: string;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

function indexHtml(dir: string): string {
  const file = join(dir, 'index.html');
  if (!existsSync(file)) throw new Error(`Missing ${file}: build the frontends before starting with BI_STATIC_DIR.`);
  return readFileSync(file, 'utf8');
}

export function createWebApp({ api, staticDir, viewerPath = '/view/' }: WebOptions) {
  const root = resolve(staticDir);
  const studioDir = join(root, 'studio');
  const viewerDir = join(root, 'viewer');
  const studioHtml = indexHtml(studioDir);
  const viewerHtml = indexHtml(viewerDir);
  const base = `/${viewerPath.replace(/^\/+|\/+$/g, '')}`;
  const web = new Hono();

  web.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  web.get('/healthz', (c) => c.json({ ok: true }));
  // The original request goes through untouched (no re-built Request); the API strips the prefix.
  web.all('/bi-api', (c) => api.fetch(c.req.raw, c.env));
  web.all('/bi-api/*', (c) => api.fetch(c.req.raw, c.env));

  // The Studio must not be framed (clickjacking); viewers may be embedded in teams' own portals.
  const noFraming = (c: Context) => {
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
  };
  const html = (c: Context, body: string, frameable: boolean) => {
    c.header('Cache-Control', 'no-cache');
    if (!frameable) noFraming(c);
    return c.html(body);
  };
  // Static files only: HTML always goes through html() above, so its security headers are never
  // skipped (serveStatic applies onFound headers after building the response, so they are set here,
  // before it runs). Hashed assets are immutable; anything else revalidates.
  const assets = (dir: string, prefix: string) => {
    const files = serveStatic({
      root: relative(process.cwd(), dir) || '.',
      rewriteRequestPath: (p) => {
        const rel = p.slice(prefix.length) || '/';
        return rel.endsWith('/') || rel.endsWith('.html') ? '/.html-is-served-by-the-app' : rel;
      },
    });
    return async (c: Context, next: () => Promise<void>) => {
      c.header('Cache-Control', c.req.path.includes('/assets/') ? IMMUTABLE : 'no-cache');
      return files(c, next);
    };
  };

  // Viewer: static files first, then its index.html for any other path under the prefix.
  web.get(base, (c) => c.redirect(`${base}/`, 301));
  web.get(`${base}/*`, assets(viewerDir, base), (c) => html(c, viewerHtml, true));
  // Studio: static files, then index.html (the Studio routes with #hashes, so any path is the app).
  web.get('/*', assets(studioDir, ''), (c) => html(c, studioHtml, false));

  return web;
}
