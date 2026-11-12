import type Anthropic from '@anthropic-ai/sdk';
import { validateDashboard } from '@yourorg/bi-spec';
import { describe, expect, it, vi } from 'vitest';
import { DashboardAssistant, fromOllamaResponse, generateCandidates, OllamaAssistantClient, OllamaRanker, toOllamaMessages } from '../src';
import { loadConfig } from '../src/config';
import { SampleEngine, SampleSources } from '../src/data/sample/engine';
import { generateOrders } from '../src/data/sample/orders';
import type { SourceCatalog } from '../src/data/sources';

const NOW = new Date('2026-11-12T10:00:00Z');
const sources: SourceCatalog = { providers: [new SampleSources(new SampleEngine({ orders: generateOrders }, () => NOW), () => NOW)] };
const profile = async () => (await sources.providers[0]!.profile('team-a', 'orders'))!;

/** A fake Ollama /api/chat answering scripted replies and recording request bodies. */
function fakeOllama(replies: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('http://localhost:11434/api/chat');
    bodies.push(JSON.parse(String(init!.body)));
    const next = replies.shift();
    if (!next) return new Response(JSON.stringify({ error: 'no more replies' }), { status: 500 });
    return new Response(JSON.stringify(next), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, bodies };
}

describe('message translation', () => {
  it('maps text, tool_use and tool_result blocks to Ollama roles and drops thinking', () => {
    const params = {
      model: 'x',
      max_tokens: 10,
      system: [{ type: 'text', text: 'SYS' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: '<dashboard>{}</dashboard>' }, { type: 'text', text: 'add a chart' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'tu1', name: 'get_source_profile', input: { type: 'sample', ref: 'orders' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'PROFILE', is_error: true }] },
      ],
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;
    expect(toOllamaMessages(params)).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '<dashboard>{}</dashboard>\n\nadd a chart' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_source_profile', arguments: { type: 'sample', ref: 'orders' } } }] },
      { role: 'tool', tool_name: 'get_source_profile', content: 'ERROR: PROFILE' },
    ]);
  });

  it('maps tool calls (object or JSON-string arguments) back to tool_use blocks', () => {
    const m = fromOllamaResponse(
      { message: { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'a', arguments: { x: 1 } } }, { function: { name: 'b', arguments: '{"y":2}' } }] }, done_reason: 'stop' },
      'llama3.2',
      'id',
    );
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'ok' }),
      { type: 'tool_use', id: 'id_0', name: 'a', input: { x: 1 } },
      { type: 'tool_use', id: 'id_1', name: 'b', input: { y: 2 } },
    ]);
    expect(fromOllamaResponse({ message: { role: 'assistant', content: 'done' }, done_reason: 'stop' }, 'm', 'i').stop_reason).toBe('end_turn');
    expect(fromOllamaResponse({ message: { role: 'assistant', content: 'cut' }, done_reason: 'length' }, 'm', 'i').stop_reason).toBe('max_tokens');
  });
});

describe('OllamaRanker', () => {
  it('asks for structured JSON with the compact profile (never rows) and sanitizes the answer', async () => {
    const p = await profile();
    const candidates = generateCandidates(p);
    const { fetch, bodies } = fakeOllama([
      { message: { role: 'assistant', content: JSON.stringify({ dashboardTitle: 'Orders', dashboardDescription: 'd', ranked: [{ id: candidates[2]!.id, title: 'T', rationale: 'R' }, { id: 'c_bogus', title: 'x', rationale: 'y' }] }) } },
    ]);
    const result = await new OllamaRanker({ fetch }).rank({ sourceName: 'orders', profile: p, candidates }, new AbortController().signal);
    expect(result.ranked).toEqual([{ id: candidates[2]!.id, title: 'T', rationale: 'R' }]);
    expect(bodies[0]).toMatchObject({ model: 'llama3.2', stream: false, format: { type: 'object' }, options: { num_ctx: 16384 } });
    const sent = JSON.stringify(bodies[0]);
    expect(sent).not.toContain('ord_000001');
    expect(sent).not.toContain('cus_');
  });
});

describe('DashboardAssistant on Ollama', () => {
  it('runs the same validated tool loop through the adapter', async () => {
    const ops = [
      { op: 'add', path: '/dataSources/o', value: { type: 'sample', ref: 'orders' } },
      { op: 'add', path: '/queries/q_rev', value: { source: 'o', dimensions: [{ field: 'region' }], measures: [{ field: 'amount', agg: 'sum', as: 'revenue' }] } },
      { op: 'add', path: '/widgets/w_rev', value: { type: 'bar-chart', query: 'q_rev', encoding: { x: 'region', y: 'revenue' }, options: { title: 'Revenue by region' } } },
      { op: 'add', path: '/layout/-', value: { i: 'w_rev', x: 0, y: 0, w: 6, h: 5 } },
    ];
    const { fetch, bodies } = fakeOllama([
      // A typical small-model slip first: a widget pointing at a query that doesn't exist.
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'update_dashboard', arguments: { summary: 'x', operations: [ops[2]] } } }] } },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'update_dashboard', arguments: { summary: 'Added revenue by region', operations: ops } } }] } },
      { message: { role: 'assistant', content: 'Added a revenue by region bar chart.' }, done_reason: 'stop' },
    ]);
    const assistant = new DashboardAssistant({ sources, client: new OllamaAssistantClient({ fetch }), model: 'llama3.2 (ollama)' });
    const draft = { specVersion: '1.3', id: 'd', title: 'D', dataSources: {}, queries: {}, widgets: {}, layout: [], params: {} };
    const res = await assistant.chat({ teamId: 'team-a', draft, messages: [{ role: 'user', content: 'revenue by region' }] });

    expect(res.changed).toBe(true);
    expect(res.changes).toEqual(['Added revenue by region']);
    expect(res.reply).toBe('Added a revenue by region bar chart.');
    expect(validateDashboard(res.draft, { allowNewerMinor: false }).ok).toBe(true);
    expect(assistant.modelName).toBe('llama3.2 (ollama)');
    // The rejection went back to the model as a tool message; tools were offered in Ollama's format.
    const second = bodies[1]!.messages as Array<{ role: string; content: string }>;
    expect(second.at(-1)).toMatchObject({ role: 'tool', content: expect.stringMatching(/^ERROR: Not applied/) });
    expect((bodies[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort()).toEqual(['add_chart', 'get_dashboard', 'get_source_profile', 'list_sources', 'update_dashboard']);
  });
});

describe('config', () => {
  it('turns AI on with a local Ollama and refuses it in production', () => {
    const c = loadConfig({ BI_LLM_PROVIDER: 'ollama' });
    expect(c.llm).toEqual({ provider: 'ollama', ollamaUrl: 'http://localhost:11434', ollamaModel: 'llama3.2', ollamaNumCtx: 16384 });
    expect(c.ai.enabled).toBe(true);
    expect(c.assistant.enabled).toBe(true);
    expect(loadConfig({}).ai.enabled).toBe(false);
    expect(() => loadConfig({ BI_LLM_PROVIDER: 'ollama', NODE_ENV: 'production', BI_TOKENS: 't:team', BI_STORE: 'postgres', DATABASE_URL: 'postgres://x' })).toThrow(/local testing only/);
  });
});

describe('tool calls written as text (small Llama models)', () => {
  it('recovers {"name", "parameters"} JSON (fenced or listed) for known tools only', async () => {
    const { textToolCalls } = await import('../src/ai/ollama');
    const names = new Set(['update_dashboard', 'get_dashboard']);
    expect(textToolCalls('{"name":"update_dashboard","parameters":{"summary":"s","operations":[]}}', names)).toEqual([
      { function: { name: 'update_dashboard', arguments: { summary: 's', operations: [] } } },
    ]);
    expect(textToolCalls('```json\n[{"name":"get_dashboard","arguments":{}}]\n```', names)).toEqual([{ function: { name: 'get_dashboard', arguments: {} } }]);
    expect(textToolCalls('{"name":"delete_everything","parameters":{}}', names)).toBeNull();
    expect(textToolCalls('Added a chart.', names)).toBeNull();
    expect(textToolCalls('{"title":"just json"}', names)).toBeNull();
    const m = fromOllamaResponse({ message: { role: 'assistant', content: '{"name":"get_dashboard","parameters":{}}' }, done_reason: 'stop' }, 'm', 'i', names);
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([{ type: 'tool_use', id: 'i_0', name: 'get_dashboard', input: {} }]);
  });
});

describe('add_chart (simple charts, any provider)', () => {
  it('builds a valid query, widget and layout, placed below existing widgets', async () => {
    const { chartOps, applyPatch } = await import('../src/ai/assistant');
    const draft = { specVersion: '1.3', id: 'd', title: 'D', dataSources: { orders: { type: 'sample', ref: 'orders' } }, queries: {}, widgets: {}, layout: [{ i: 'w_x', x: 0, y: 0, w: 3, h: 2 }], params: {} };
    const built = chartOps(draft, { type: 'bar-chart', dimension: 'region', measure: 'amount', agg: 'sum', title: 'Revenue by region' });
    if (typeof built === 'string') throw new Error(built);
    const next = applyPatch({ ...draft, layout: [] }, built.ops);
    expect(validateDashboard(next, { allowNewerMinor: false }).ok).toBe(true);
    expect(built.ops[2]).toMatchObject({ value: { i: 'w_revenue_by_region', x: 0, y: 2, w: 6, h: 5 } });
    const kpi = chartOps(draft, { type: 'kpi', measure: '*', agg: 'count', title: 'Orders' });
    if (typeof kpi === 'string') throw new Error(kpi);
    expect(validateDashboard(applyPatch({ ...draft, layout: [] }, kpi.ops), { allowNewerMinor: false }).ok).toBe(true);
    expect(chartOps(draft, { type: 'pie', measure: 'amount', agg: 'sum' })).toMatch(/needs a "dimension"/);
    expect(chartOps({ ...draft, dataSources: {} }, { type: 'kpi', measure: 'amount', agg: 'sum' })).toMatch(/no data source/);
  });

  it('recovers a tool call written after a short lead-in sentence', async () => {
    const { textToolCalls } = await import('../src/ai/ollama');
    const calls = textToolCalls('I\'ll fix the path. Here is the call: {"name":"get_dashboard","parameters":{}} Hope that helps.', new Set(['get_dashboard']));
    expect(calls).toEqual([{ function: { name: 'get_dashboard', arguments: {} } }]);
  });
});

describe('assistant loop with small-model habits', () => {
  it('ends the turn on empty edits after a change, and never shows a JSON tool call as the reply', async () => {
    const { fetch } = fakeOllama([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add_chart', arguments: { type: 'kpi', measure: '*', agg: 'count', title: 'Orders' } } }] } },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'update_dashboard', arguments: { operations: [], summary: '' } } }] } },
      { message: { role: 'assistant', content: 'unreachable' } },
    ]);
    const assistant = new DashboardAssistant({ sources, client: new OllamaAssistantClient({ fetch }), promptMode: 'compact' });
    const draft = { specVersion: '1.3', id: 'd', title: 'D', dataSources: { orders: { type: 'sample', ref: 'orders' } }, queries: {}, widgets: {}, layout: [], params: {} };
    const res = await assistant.chat({ teamId: 'team-a', draft, messages: [{ role: 'user', content: 'add an orders KPI' }] });
    expect(res.changed).toBe(true);
    expect(res.reply).toBe('Added Orders.');

    const { looksLikeToolCallText } = await import('../src/ai/assistant');
    expect(looksLikeToolCallText('{"name": "update_dashboard", "parameters": {}}')).toBe(true);
    expect(looksLikeToolCallText('```json\n{"operations": []}')).toBe(true);
    expect(looksLikeToolCallText('Added a chart.')).toBe(false);
  });

  it('compact mode lists the source columns inline and uses the short instructions', async () => {
    const { fetch, bodies } = fakeOllama([{ message: { role: 'assistant', content: 'Nothing to do.' }, done_reason: 'stop' }]);
    const assistant = new DashboardAssistant({ sources, client: new OllamaAssistantClient({ fetch }), promptMode: 'compact' });
    await assistant.chat({ teamId: 'team-a', draft: { specVersion: '1.3', id: 'd', title: 'D', dataSources: { orders: { type: 'sample', ref: 'orders' } }, queries: {}, widgets: {}, layout: [], params: {} }, messages: [{ role: 'user', content: 'hi' }] });
    const msgs = bodies[0]!.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]!.content).toMatch(/^You edit a dashboard/);
    expect(msgs[0]!.content.length).toBeLessThan(2500);
    expect(msgs[1]!.content).toContain('<columns source="orders">');
    expect(msgs[1]!.content).toContain('amount (measure)');
    expect(msgs[1]!.content).not.toContain('ord_000001');
  });
});
