/**
 * First-deploy smoke test, scripted (docs/DEPLOYMENT.md §5). Runs the API paths that are only tested
 * with fakes against a real deployment and prints PASS/FAIL per step. Read-mostly: it creates one
 * dashboard (smoke_<time>), one upload and one share, revokes the share, and leaves the rest.
 *
 *   SMOKE_URL=https://sratchpad.example.com/bi-api SMOKE_TOKEN=<editor token or SSO ID token> \
 *   SMOKE_TABLE=SALES.PUBLIC.ORDERS npm run smoke -w @yourorg/bi-api
 */

const base = (process.env.SMOKE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const token = process.env.SMOKE_TOKEN ?? 'dev-token-team-a';
const table = process.env.SMOKE_TABLE;
let failures = 0;

async function call(method: string, path: string, body?: unknown, auth = token) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth}`, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* NDJSON or text */
  }
  return { status: res.status, json, text };
}

async function step(name: string, fn: () => Promise<string | void>) {
  const started = Date.now();
  try {
    const note = await fn();
    console.log(`PASS  ${name} (${Date.now() - started} ms)${note ? `: ${note}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}: ${(error as Error).message}`);
  }
}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const id = `smoke_${Date.now().toString(36)}`;

await step('health and sign-in settings', async () => {
  const h = await fetch(`${base}/healthz`);
  expect(h.ok, `healthz ${h.status}`);
  const a = (await (await fetch(`${base}/auth/config`)).json()) as { mode: string };
  return `auth mode ${a.mode}`;
});

await step('list dashboards (store reachable)', async () => {
  const r = await call('GET', '/v1/dashboards');
  expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
});

let sourceRef = table;
await step('list sources (Snowflake listing under the team role)', async () => {
  const r = await call('GET', '/v1/sources?refresh=1');
  expect(r.status === 200, `status ${r.status}`);
  const list = (r.json as { sources: Array<{ source: { type: string; ref: string } }> }).sources;
  const sf = list.filter((s) => s.source.type === 'snowflake');
  sourceRef ??= sf[0]?.source.ref;
  return `${list.length} sources, ${sf.length} Snowflake`;
});

if (sourceRef) {
  await step(`profile ${sourceRef} (sampled)`, async () => {
    const r = await call('GET', `/v1/sources/profile?type=snowflake&ref=${encodeURIComponent(sourceRef!)}`);
    expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
    return `${(r.json as { columns: unknown[] }).columns.length} columns`;
  });
  await step('suggest a dashboard (pushdown queries compile)', async () => {
    const r = await call('POST', '/v1/recommendations', { source: { type: 'snowflake', ref: sourceRef } });
    expect(r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
    const dash = (r.json as { dashboard: Record<string, unknown>; generatedBy: string }).dashboard;
    const preview = await call('POST', '/v1/preview/data', { spec: dash, queries: Object.keys(dash.queries as object) });
    const lines = preview.text.trim().split('\n').map((l) => JSON.parse(l) as { ok: boolean; error?: { message: string } });
    const bad = lines.filter((l) => !l.ok);
    expect(!bad.length, `${bad.length}/${lines.length} queries failed: ${bad[0]?.error?.message}`);
    return `${lines.length} queries ran (${(r.json as { generatedBy: string }).generatedBy})`;
  });
} else console.log('SKIP  Snowflake table steps (no table visible; set SMOKE_TABLE)');

await step('upload a CSV (Iceberg PUT when BI_UPLOADS=snowflake)', async () => {
  const form = new FormData();
  form.append('file', new Blob(['region,amount\nEU,10\nNA,7\n'], { type: 'text/csv' }), `${id}.csv`);
  const r = await call('POST', '/v1/sources/files', form);
  expect(r.status === 201, `status ${r.status}: ${r.text.slice(0, 200)}`);
  return (r.json as { summary: { source: { ref: string } } }).summary.source.ref;
});

await step('save a dashboard, then a conflicting save is refused', async () => {
  const spec = { specVersion: '1.0', id, title: 'Smoke test', dataSources: { o: { type: 'sample', ref: 'orders' } }, queries: { q: { source: 'o', measures: [{ field: 'amount', agg: 'sum' }] } }, widgets: { w: { type: 'kpi', query: 'q', options: { field: 'sum_amount', label: 'Revenue' } } }, layout: [{ i: 'w', x: 0, y: 0, w: 3, h: 2 }] };
  const first = await call('PUT', `/v1/dashboards/${id}`, { spec });
  expect(first.status < 300, `save ${first.status}: ${first.text.slice(0, 200)}`);
  const stale = await call('PUT', `/v1/dashboards/${id}`, { spec, expectedVersion: 0 });
  expect(stale.status === 409, `stale save returned ${stale.status}, expected 409`);
});

await step('share as a viewer link, read with it, revoke', async () => {
  const created = await call('POST', `/v1/dashboards/${id}/shares`, { audience: 'viewer', expiresInDays: 1 });
  expect(created.status === 201, `create ${created.status}`);
  const { token: shareToken, share } = created.json as { token: string; share: { id: string } };
  const read = await call('GET', `/v1/dashboards/${id}`, undefined, shareToken);
  expect(read.status === 200 || read.status === 401, `read ${read.status}`);
  const revoked = await call('DELETE', `/v1/dashboards/${id}/shares/${share.id}`);
  expect(revoked.status === 204, `revoke ${revoked.status}`);
  const after = await call('GET', `/v1/dashboards/${id}`, undefined, shareToken);
  expect(after.status === 401, `revoked token still works (${after.status})`);
  return read.status === 401 ? 'viewer login required (BI_VIEWER_LOGIN=on)' : undefined;
});

console.log(failures ? `\n${failures} step(s) failed.` : '\nAll steps passed.');
process.exit(failures ? 1 : 0);

export {};
