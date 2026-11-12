import type Anthropic from '@anthropic-ai/sdk';
import { validateDashboard, WIDGET_TYPES } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  createApp,
  DashboardAssistant,
  defaultEngines,
  DEV_TOKENS,
  MemoryDashboardStore,
  MemoryShareStore,
  specReference,
  StaticTokenVerifier,
  type AssistantModelClient,
} from '../src';
import { SampleEngine, SampleSources } from '../src/data/sample/engine';
import { generateOrders } from '../src/data/sample/orders';
import type { SourceCatalog } from '../src/data/sources';

const NOW = new Date('2026-11-09T15:30:00Z');
const sources: SourceCatalog = { providers: [new SampleSources(new SampleEngine({ orders: generateOrders }, () => NOW), () => NOW)] };

type Block = Anthropic.Beta.BetaContentBlock;
const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as unknown as Block;
const tool = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input }) as unknown as Block;
const thinking = (): Block => ({ type: 'thinking', thinking: '', signature: 'sig-1' }) as unknown as Block;

/** Answers with scripted responses in order and records every request. */
function scripted(responses: Array<{ content: Block[]; stop_reason: string }>) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client: AssistantModelClient = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error('no more scripted responses');
          return { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: params.model, content: next.content, stop_reason: next.stop_reason } as unknown as Anthropic.Beta.BetaMessage;
        },
      },
    },
  };
  return { client, calls };
}

const emptyDraft = () => ({ specVersion: '1.0', id: 'dash_new', title: 'New', dataSources: {}, queries: {}, widgets: {}, layout: [], params: {} });

const goodOps = [
  { op: 'add', path: '/dataSources/orders', value: { type: 'sample', ref: 'orders' } },
  {
    op: 'add',
    path: '/queries/q_rev_region',
    value: { source: 'orders', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }], orderBy: [{ field: 'revenue', dir: 'desc' }] },
  },
  {
    op: 'add',
    path: '/widgets/w_rev_region',
    value: {
      type: 'bar-chart',
      query: 'q_rev_region',
      encoding: { x: 'region', y: 'revenue' },
      options: { title: 'Revenue by region', dataLabels: true, showGrid: false, format: { y: 'currency' } },
      style: { colors: ['#58a6ff'] },
    },
  },
  { op: 'add', path: '/layout/-', value: { i: 'w_rev_region', x: 0, y: 0, w: 12, h: 5 } },
  { op: 'add', path: '/theme', value: { background: '#0d1117', cardBackground: '#161b22', accent: '#58a6ff', cardStyle: 'flat' } },
];

describe('DashboardAssistant', () => {
  it('builds from a chat: reads the profile, fixes a rejected edit, returns a valid styled draft', async () => {
    const { client, calls } = scripted([
      { content: [thinking(), tool('t1', 'get_source_profile', { type: 'sample', ref: 'orders' })], stop_reason: 'tool_use' },
      {
        // First attempt references a column the query does not output: must be rejected.
        content: [
          tool('t2', 'update_dashboard', {
            summary: 'Added a chart',
            operations: [...goodOps.slice(0, 2), { ...goodOps[2], value: { ...(goodOps[2] as { value: object }).value, encoding: { x: 'region', y: 'total' } } }, goodOps[3]],
          }),
        ],
        stop_reason: 'tool_use',
      },
      { content: [tool('t3', 'update_dashboard', { summary: 'Added a revenue-by-region bar chart with a dark theme', operations: goodOps })], stop_reason: 'tool_use' },
      { content: [text('Added a revenue-by-region bar chart with data labels and a dark theme.')], stop_reason: 'end_turn' },
    ]);
    const assistant = new DashboardAssistant({ sources, client });
    const res = await assistant.chat({ teamId: 'team-a', draft: emptyDraft(), messages: [{ role: 'user', content: 'Revenue by region as bars, dark theme' }] });

    expect(res.changed).toBe(true);
    expect(res.changes).toEqual(['Added a revenue-by-region bar chart with a dark theme']);
    expect(res.reply).toMatch(/dark theme/);
    expect(res.issues).toEqual([]);
    expect(res.draft.specVersion).toBe('1.2'); // raised automatically for theme/style/chrome
    const v = validateDashboard(res.draft, { allowNewerMinor: false });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.dashboard.theme).toMatchObject({ background: '#0d1117' });

    // The rejected edit came back as an error naming the problem; the draft stayed unchanged.
    const afterBad = calls[2]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(afterBad[0]).toMatchObject({ tool_use_id: 't2', is_error: true });
    expect(String(afterBad[0]!.content)).toMatch(/Not applied.*widgets\.w_rev_region\.encoding\.y/s);

    // Request shape: model, effort, cached static prefix, refusal fallbacks, the four tools.
    const first = calls[0]!;
    expect(first).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect((first.system as Anthropic.Beta.BetaTextBlockParam[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.tools!.map((t) => (t as { name: string }).name).sort()).toEqual(['add_chart', 'get_dashboard', 'get_source_profile', 'list_sources', 'update_dashboard']);
    expect(first).not.toHaveProperty('thinking');
    expect(first).not.toHaveProperty('tool_choice');
    // The draft travels in the user turn; the thinking block is passed back unchanged.
    expect(JSON.stringify(first.messages)).toContain('<dashboard>');
    expect(JSON.stringify(calls[1]!.messages)).toContain('"signature":"sig-1"');
    // Profiles only: no row-level identifiers or raw measure values ever reach the model.
    const everything = JSON.stringify(calls);
    expect(everything).not.toContain('ord_000001');
    expect(everything).not.toContain('cus_');
  });

  it('accepts edits on a draft that already has problems, as long as they add none', async () => {
    const draft = { ...emptyDraft(), widgets: { w_broken: { type: 'kpi', query: 'q_missing', options: { field: 'x' } } }, layout: [{ i: 'w_broken', x: 0, y: 0, w: 3, h: 2 }] };
    const { client, calls } = scripted([
      { content: [tool('t1', 'update_dashboard', { summary: 'Renamed the dashboard', operations: [{ op: 'replace', path: '/title', value: 'Sales cockpit' }] })], stop_reason: 'tool_use' },
      { content: [text('Renamed it to "Sales cockpit".')], stop_reason: 'end_turn' },
    ]);
    const res = await new DashboardAssistant({ sources, client }).chat({ teamId: 'team-a', draft, messages: [{ role: 'user', content: 'rename to Sales cockpit' }] });
    expect(res.draft.title).toBe('Sales cockpit');
    expect(res.issues.map((i) => i.path)).toContain('widgets.w_broken.query');
    expect(JSON.stringify(calls[0]!.messages)).toContain('existing_problems');
  });

  it('stops after the step budget and reports what it managed', async () => {
    const loop = Array.from({ length: 5 }, (_, i) => ({ content: [tool(`t${i}`, 'get_dashboard', {})], stop_reason: 'tool_use' }));
    const { client, calls } = scripted(loop);
    const res = await new DashboardAssistant({ sources, client, maxSteps: 3 }).chat({ teamId: 'team-a', draft: emptyDraft(), messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toHaveLength(3);
    expect(res.changed).toBe(false);
    expect(res.reply).toMatch(/stopped/);
  });

  it('describes every widget type, the styling layer and the limits from the live schemas', () => {
    const ref = specReference();
    for (const type of Object.keys(WIDGET_TYPES)) expect(ref).toContain(`"${type}"`);
    expect(ref).toMatch(/Dashboard theme \(since 1\.2\): \{ mode\?: "light"\|"dark"; palette\?: hex color\[\]/);
    expect(ref).toContain('dataLabels?: boolean');
    expect(ref).toContain('Not supported by the spec today');
  });
});

describe('applyPatch', () => {
  const doc = { a: { 'x/y': 1, 'm~n': 2 }, list: [1, 2, 3] };
  it('applies add, replace, remove, move and copy with JSON Pointer escaping', () => {
    const out = applyPatch(doc, [
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'add', path: '/list/0', value: 0 },
      { op: 'replace', path: '/a/x~1y', value: 10 },
      { op: 'remove', path: '/a/m~0n' },
      { op: 'copy', from: '/list/1', path: '/a/copied' },
      { op: 'move', from: '/a/copied', path: '/moved' },
    ]);
    expect(out).toEqual({ a: { 'x/y': 10 }, list: [0, 1, 2, 3, 4], moved: 1 });
    expect(doc.list).toEqual([1, 2, 3]); // input untouched
  });
  it('is all-or-nothing and refuses dangerous or invalid paths', () => {
    expect(() => applyPatch(doc, [{ op: 'replace', path: '/a/x~1y', value: 5 }, { op: 'remove', path: '/nope' }])).toThrow(/Operation 1/);
    expect(() => applyPatch(doc, [{ op: 'add', path: '/__proto__/polluted', value: true }])).toThrow(/not allowed/);
    expect(() => applyPatch(doc, [{ op: 'replace', path: '', value: {} }])).toThrow(/whole document/);
    expect(() => applyPatch(doc, [{ op: 'replace', path: '/missing', value: 1 }])).toThrow(/use "add"/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('POST /v1/assistant/chat', () => {
  function app(assistant: DashboardAssistant | null) {
    return createApp({
      store: new MemoryDashboardStore(),
      auth: StaticTokenVerifier.parse(DEV_TOKENS),
      engines: defaultEngines(() => NOW),
      shares: new MemoryShareStore(),
      assistant,
    });
  }
  const post = (a: ReturnType<typeof app>, body: unknown, token = 'dev-token-team-a') =>
    a.request('/v1/assistant/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('reports availability and answers 503 when off', async () => {
    const off = app(null);
    expect(await (await off.request('/v1/assistant', { headers: { Authorization: 'Bearer dev-token-team-a' } })).json()).toEqual({ enabled: false });
    expect((await post(off, { draft: emptyDraft(), messages: [{ role: 'user', content: 'hi' }] })).status).toBe(503);
  });

  it('is editor-only, validates the body, and maps refusals', async () => {
    const { client } = scripted([{ content: [], stop_reason: 'refusal' }]);
    const a = app(new DashboardAssistant({ sources, client }));
    expect(await (await a.request('/v1/assistant', { headers: { Authorization: 'Bearer dev-token-team-a' } })).json()).toEqual({ enabled: true, model: 'claude-opus-5-5' });
    expect((await post(a, { draft: emptyDraft(), messages: [{ role: 'user', content: 'hi' }] }, 'dev-token-team-a-viewer')).status).toBe(403);
    expect((await post(a, { draft: emptyDraft(), messages: [] })).status).toBe(400);
    expect((await post(a, { draft: emptyDraft(), messages: [{ role: 'assistant', content: 'hi' }] })).status).toBe(400);
    expect((await post(a, { draft: emptyDraft(), messages: [{ role: 'user', content: 'hi' }], selectedWidgetId: 'bad id' })).status).toBe(400);
    const declined = await post(a, { draft: emptyDraft(), messages: [{ role: 'user', content: 'hi' }] });
    expect(declined.status).toBe(422);
    expect(await declined.json()).toMatchObject({ error: { code: 'assistant_declined' } });
  });

  it('returns the edited draft without saving anything', async () => {
    const { client } = scripted([
      { content: [tool('t1', 'update_dashboard', { summary: 'Renamed', operations: [{ op: 'replace', path: '/title', value: 'Renamed' }] })], stop_reason: 'tool_use' },
      { content: [text('Renamed.')], stop_reason: 'end_turn' },
    ]);
    const a = app(new DashboardAssistant({ sources, client }));
    const res = await post(a, { draft: emptyDraft(), messages: [{ role: 'user', content: 'rename it' }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, draft: { title: 'Renamed' }, changes: ['Renamed'], reply: 'Renamed.' });
    expect(await (await a.request('/v1/dashboards', { headers: { Authorization: 'Bearer dev-token-team-a' } })).json()).toEqual({ dashboards: [] });
  });
});
