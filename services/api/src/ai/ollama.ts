import type Anthropic from '@anthropic-ai/sdk';
import type { AssistantModelClient } from './assistant';
import { compactCandidates, compactProfile, OUTPUT_SCHEMA, sanitizeRanking, SYSTEM_PROMPT, type Ranker, type RankInput, type RankResult } from './ranker';

/**
 * Local models through Ollama (e.g. Llama 3.2), for LOCAL TESTING ONLY (`BI_LLM_PROVIDER=ollama`; refused
 * in production). Both AI features keep their guarantees because only the model call changes:
 *
 * - OllamaRanker: same prompt, same compact profile (never rows), structured JSON output, same sanitizing,
 *   same fallback to rules on any failure.
 * - OllamaAssistantClient: an adapter that speaks the Anthropic Messages shape the assistant uses and
 *   translates it to Ollama's /api/chat (tools ↔ tool_calls). The assistant loop, JSON Patch validation and
 *   "draft only, never saves" rules are unchanged.
 *
 * Small local models are much weaker than Claude at multi-step tool use; expect more rejected edits and
 * simpler results. That is the point of local testing: exercising the flow without an API key.
 */

export interface OllamaOptions {
  /** Default http://localhost:11434 */
  url?: string;
  /** Default "llama3.2" */
  model?: string;
  /** Context window to request (tokens). The assistant's prompt is several thousand tokens. */
  numCtx?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done_reason?: string;
  error?: string;
}

class OllamaHttp {
  readonly url: string;
  readonly model: string;
  private readonly numCtx: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaOptions = {}) {
    this.url = (options.url ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.model = options.model ?? 'llama3.2';
    this.numCtx = options.numCtx ?? 16_384;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  async chat(body: { messages: OllamaMessage[]; tools?: unknown[]; format?: unknown; temperature?: number }, signal?: AbortSignal): Promise<OllamaChatResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(`${this.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: body.messages,
        ...(body.tools?.length ? { tools: body.tools } : {}),
        ...(body.format ? { format: body.format } : {}),
        options: { temperature: body.temperature ?? 0.2, num_ctx: this.numCtx },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const json = (await res.json().catch(() => ({}))) as OllamaChatResponse;
    if (!res.ok || json.error) throw new Error(`Ollama ${res.status}: ${json.error ?? 'request failed'}`);
    return json;
  }
}

/** Suggestion ranking with a local model. Any failure falls back to rules in the Recommender. */
export class OllamaRanker implements Ranker {
  readonly name = 'ollama';
  private readonly http: OllamaHttp;

  constructor(options: OllamaOptions = {}) {
    this.http = new OllamaHttp(options);
  }

  get model(): string {
    return this.http.model;
  }

  async rank(input: RankInput, signal: AbortSignal): Promise<RankResult> {
    const payload = { source: input.sourceName, profile: compactProfile(input.profile), candidates: compactCandidates(input.candidates) };
    const res = await this.http.chat(
      {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `<data>\n${JSON.stringify(payload)}\n</data>\nAnswer with JSON matching the schema.` },
        ],
        format: OUTPUT_SCHEMA, // Ollama structured outputs: the reply is JSON for this schema
      },
      signal,
    );
    return sanitizeRanking(JSON.parse(res.message?.content ?? '{}'), input.candidates);
  }
}

// ── assistant adapter: Anthropic Messages shape ⇄ Ollama /api/chat ────────────

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Block = Anthropic.Beta.BetaContentBlock;

function systemText(system: Params['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => ('text' in b ? b.text : '')).join('\n');
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return '';
}

/** Converts the assistant's conversation (text, tool_use, tool_result, thinking blocks) to Ollama messages. */
export function toOllamaMessages(params: Params): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const sys = systemText(params.system);
  if (sys) out.push({ role: 'system', content: sys });
  const toolNames = new Map<string, string>();
  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text: string[] = [];
      const calls: OllamaToolCall[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text.push(b.text);
        else if (b.type === 'tool_use') {
          toolNames.set(b.id, b.name);
          calls.push({ function: { name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> } });
        }
        // thinking / other blocks: not meaningful to a local model
      }
      out.push({ role: 'assistant', content: text.join('\n'), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const text: string[] = [];
    for (const b of m.content ?? []) {
      if (b.type === 'text') text.push(b.text);
      else if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_name: toolNames.get(b.tool_use_id) ?? 'tool', content: `${b.is_error ? 'ERROR: ' : ''}${blockText(b.content)}` });
      }
    }
    if (text.length) out.push({ role: 'user', content: text.join('\n\n') });
  }
  return out;
}

/**
 * Small Llama models often write a tool call as plain JSON text instead of using tool_calls, e.g.
 * `{"name": "update_dashboard", "parameters": {...}}` (sometimes in a ```json fence, or a list of them).
 * When the whole reply is such JSON and names a known tool, treat it as the tool call(s). The call still
 * goes through the assistant's normal validation; anything else stays plain text.
 */
export function textToolCalls(text: string, toolNames: ReadonlySet<string>): OllamaToolCall[] | null {
  let body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // A short lead-in ("I'll fix the path. Here is …") before the JSON: use the JSON part.
  if (!body.startsWith('{') && !body.startsWith('[')) {
    const start = body.search(/[[{]/);
    if (start < 0 || start > 200) return null;
    body = body.slice(start).replace(/```[\s\S]*$/, '').trim();
    body = body.slice(0, Math.max(body.lastIndexOf('}'), body.lastIndexOf(']')) + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls: OllamaToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const { name, parameters, arguments: args } = item as { name?: unknown; parameters?: unknown; arguments?: unknown };
    if (typeof name !== 'string' || !toolNames.has(name)) return null;
    const input = parameters ?? args ?? {};
    if (typeof input !== 'object' || input === null) return null;
    calls.push({ function: { name, arguments: input as Record<string, unknown> } });
  }
  return calls.length ? calls : null;
}

/** Converts Ollama's reply to the Messages-API shape the assistant loop reads. */
export function fromOllamaResponse(res: OllamaChatResponse, model: string, idPrefix: string, toolNames: ReadonlySet<string> = new Set()): Anthropic.Beta.BetaMessage {
  const content: Block[] = [];
  const msg = res.message ? { ...res.message } : undefined;
  if (msg && !msg.tool_calls?.length && msg.content) {
    const recovered = textToolCalls(msg.content, toolNames);
    if (recovered) msg.tool_calls = recovered;
    if (recovered) msg.content = '';
  }
  if (msg?.content?.trim()) content.push({ type: 'text', text: msg.content, citations: null } as unknown as Block);
  (msg?.tool_calls ?? []).forEach((call, i) => {
    let input: unknown = call.function.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = {};
      }
    }
    content.push({ type: 'tool_use', id: `${idPrefix}_${i}`, name: call.function.name, input } as unknown as Block);
  });
  const hasCalls = (msg?.tool_calls ?? []).length > 0;
  return {
    id: idPrefix,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasCalls ? 'tool_use' : res.done_reason === 'length' ? 'max_tokens' : 'end_turn',
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** Drop-in client for DashboardAssistant that runs the conversation on a local Ollama model. */
export class OllamaAssistantClient implements AssistantModelClient {
  private readonly http: OllamaHttp;
  private turn = 0;

  constructor(options: OllamaOptions = {}) {
    this.http = new OllamaHttp(options);
  }

  get model(): string {
    return this.http.model;
  }

  readonly beta = {
    messages: {
      create: async (params: Params, options?: { signal?: AbortSignal }): Promise<Anthropic.Beta.BetaMessage> => {
        const tools = (params.tools ?? []).map((t) => {
          const tool = t as Anthropic.Beta.BetaTool;
          return { type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema } };
        });
        const res = await this.http.chat({ messages: toOllamaMessages(params), tools }, options?.signal);
        this.turn += 1;
        const names = new Set(tools.map((t) => t.function.name));
        return fromOllamaResponse(res, this.http.model, `ollama_${Date.now().toString(36)}_${this.turn}`, names);
      },
    },
  };
}
