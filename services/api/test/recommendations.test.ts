import type Anthropic from '@anthropic-ai/sdk';
import { validateDashboard, type DataResponseLine, type RecommendationResponse, type SourceProfile } from '@yourorg/bi-spec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseGrain,
  ClaudeRanker,
  compactProfile,
  createApp,
  defaultEngines,
  DEV_TOKENS,
  generateCandidates,
  MemoryDashboardStore,
  Recommender,
  RankerRefusedError,
  sanitizeRanking,
  StaticTokenVerifier,
  type App,
  type Ranker,
} from '../src';
import { SampleEngine, SampleSources } from '../src/data/sample/engine';
import { generateOrders } from '../src/data/sample/orders';

const NOW = new Date('2026-11-09T15:30:00Z');
const TEAM_A = 'dev-token-team-a';

async function sampleProfile(): Promise<SourceProfile> {
  const engine = new SampleEngine({ orders: generateOrders }, () => NOW);
  return (await new SampleSources(engine, () => NOW).profile('team-a', 'orders'))!;
}

function makeApp(recommender?: Recommender): App {
  return createApp({
    store: new MemoryDashboardStore(),
    auth: StaticTokenVerifier.parse(DEV_TOKENS),
    engines: defaultEngines(() => NOW),
    now: () => NOW,
    recommender,
  });
}

async function recommend(app: App, body: unknown, token = TEAM_A) {
  return app.request('/v1/recommendations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ORDERS = { source: { type: 'sample', ref: 'orders' } };

describe('candidate rules', () => {
  let profile: SourceProfile;
  beforeEach(async () => {
    profile = await sampleProfile();
  });

  it('is deterministic and leads with the trend of the main currency measure', () => {
    const a = generateCandidates(profile);
    expect(generateCandidates(profile)).toEqual(a);
    expect(a[0]).toMatchObject({ pattern: 'measure_over_time', widget: { type: 'line-chart', encoding: { x: 'order_date', y: 'total_amount' } } });
    expect(a[0]!.query).toMatchObject({ dimensions: [{ field: 'order_date', grain: 'month' }], measures: [{ field: 'amount', agg: 'sum' }] });
    const patterns = new Set(a.map((c) => c.pattern));
    for (const p of ['total', 'record_count', 'measure_by_dimension', 'part_to_whole', 'measure_over_time_by_dimension', 'dimension_matrix', 'breakdown_table', 'measure_vs_measure']) {
      expect(patterns, p).toContain(p);
    }
    // The workflow status column is a filter, not the headline breakdown.
    expect(a.find((c) => c.pattern === 'measure_by_dimension')!.fields).not.toContain('status');
    // Ids are valid spec ids and unique.
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    for (const c of a) expect(c.id).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
  });

  it('averages durations and scores instead of summing them', () => {
    const col = (name: string, distinct = 500) => ({
      name, physicalType: 'number' as const, semanticType: 'numeric' as const, role: 'measure' as const,
      nullRate: 0, distinctCount: distinct, cardinality: 'medium' as const, sampleValues: [], min: 0, max: 100,
    });
    const tickets: SourceProfile = {
      ...profile,
      columns: [profile.columns.find((c) => c.name === 'order_date')!, profile.columns.find((c) => c.name === 'region')!, col('resolution_hours'), col('first_response_min'), col('csat_score', 5)],
      measureCandidates: ['resolution_hours', 'first_response_min', 'csat_score'],
      dimensionCandidates: ['region'],
      keyCandidates: [],
    };
    const cs = generateCandidates(tickets);
    const aggs = cs.flatMap((c) => c.query.measures ?? []).filter((m) => m.field !== '*');
    expect(aggs.length).toBeGreaterThan(0);
    expect(aggs.every((m) => m.agg === 'avg')).toBe(true);
    expect(cs.find((c) => c.pattern === 'total')!.title).toBe('Average resolution hours');
    // Part-to-whole needs an additive measure, so it falls back to counting records.
    expect(cs.find((c) => c.pattern === 'part_to_whole')!.query.measures).toEqual([{ field: '*', agg: 'count', as: 'records' }]);
  });

  it('picks a grain that gives a readable number of points', () => {
    expect(chooseGrain('2026-11-01', '2026-11-20')).toBe('day');
    expect(chooseGrain('2026-06-01', '2026-11-20')).toBe('week');
    expect(chooseGrain('2024-11-01', '2026-11-09')).toBe('month');
    expect(chooseGrain('2020-01-01', '2026-11-09')).toBe('quarter');
    expect(chooseGrain('2001-01-01', '2026-11-09')).toBe('year');
    expect(chooseGrain(null, undefined)).toBe('month');
  });

  it('copes with a source that has no measures and no dates', () => {
    const bare: SourceProfile = {
      ...profile,
      columns: profile.columns.filter((c) => c.name === 'region' || c.name === 'channel'),
      timeColumns: [],
      measureCandidates: [],
      dimensionCandidates: ['region', 'channel'],
      keyCandidates: [],
    };
    const cs = generateCandidates(bare);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) expect(JSON.stringify(c.query)).not.toContain('amount');
    expect(cs.find((c) => c.pattern === 'measure_by_dimension')!.query.measures).toEqual([{ field: '*', agg: 'count', as: 'records' }]);
  });
});

describe('POST /v1/recommendations (rules only)', () => {
  let app: App;
  beforeEach(() => {
    app = makeApp();
  });

  it('returns ranked candidates and a valid starter dashboard whose every query runs', async () => {
    const res = await recommend(app, ORDERS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecommendationResponse;
    expect(body.generatedBy).toBe('rules');
    expect(body.profile.rowCount).toBeGreaterThan(1000);
    expect(body.candidates.length).toBeGreaterThan(5);
    expect(body.candidates.map((c) => c.score)).toEqual([...body.candidates.map((c) => c.score)].sort((a, b) => b - a));

    const result = validateDashboard(body.dashboard, { allowNewerMinor: false });
    expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
    const d = body.dashboard;
    expect(d.dataSources).toEqual({ src: { type: 'sample', ref: 'orders' } });
    expect(Object.keys(d.widgets).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(d.widgets).length).toBeLessThanOrEqual(8);
    // KPIs across the top, nothing overlapping, everything on the 12-column grid.
    const kpis = d.layout.filter((l) => d.widgets[l.i]!.type === 'kpi');
    expect(kpis.every((l) => l.y === 0)).toBe(true);
    const cells = new Set<string>();
    for (const l of d.layout) {
      expect(l.x + l.w).toBeLessThanOrEqual(12);
      for (let x = l.x; x < l.x + l.w; x++) for (let y = l.y; y < l.y + l.h; y++) {
        expect(cells.has(`${x},${y}`), `${l.i} overlaps at ${x},${y}`).toBe(false);
        cells.add(`${x},${y}`);
      }
    }
    // A date-range control bound to every query.
    expect(d.params!.dateRange).toMatchObject({ type: 'daterange', field: 'order_date', bind: Object.keys(d.queries).map((q) => `${q}.filters`) });

    // Run every query of the unsaved suggestion through the preview route.
    const preview = await app.request('/v1/preview/data', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEAM_A}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: d, queries: Object.keys(d.queries), params: { dateRange: 'last_90d' } }),
    });
    expect(preview.status).toBe(200);
    const lines = (await preview.text()).trim().split('\n').map((l) => JSON.parse(l) as DataResponseLine);
    expect(lines).toHaveLength(Object.keys(d.queries).length);
    for (const line of lines) expect(line.ok, JSON.stringify(line)).toBe(true);
  });

  it('every candidate (not just the chosen ones) is a runnable widget', async () => {
    const body = (await (await recommend(app, ORDERS)).json()) as RecommendationResponse;
    const queries = Object.fromEntries(body.candidates.map((c) => [c.widget.query!, c.query]));
    const widgets = Object.fromEntries(body.candidates.map((c) => [c.id.replace(/^c_/, 'w_'), c.widget]));
    const spec = { specVersion: '1.1', id: 'all', title: 'All', dataSources: { src: ORDERS.source }, queries, widgets, layout: [] };
    const result = validateDashboard(spec, { allowNewerMinor: false });
    expect(result.ok, JSON.stringify(!result.ok && result.errors)).toBe(true);
  });

  it('validates the body and hides sources the team cannot see', async () => {
    expect((await recommend(app, {})).status).toBe(400);
    expect((await recommend(app, { source: { type: 'nope', ref: 'x' } })).status).toBe(400);
    const missing = await recommend(app, { source: { type: 'sample', ref: 'missing' } });
    expect(missing.status).toBe(404);
    expect((await recommend(app, { source: { type: 'file', ref: 'file_abc' } })).status).toBe(404);
    expect((await recommend(app, ORDERS, 'bad-token')).status).toBe(401);
  });
});

describe('ranking', () => {
  const fakeRanker = (impl: Ranker['rank']): Ranker => ({ name: 'fake', rank: impl });

  it('applies the ranker’s order and wording, and marks the response rules+llm', async () => {
    const ranker = fakeRanker(async ({ candidates }) => {
      const pie = candidates.find((c) => c.pattern === 'part_to_whole')!;
      const total = candidates.find((c) => c.pattern === 'total')!;
      return {
        ranked: [
          { id: pie.id, title: 'Revenue mix by region', rationale: 'Where the money comes from.' },
          { id: total.id, title: 'Revenue', rationale: 'The headline.' },
        ],
        dashboardTitle: 'Orders at a glance',
      };
    });
    const body = (await (await recommend(makeApp(new Recommender({ ranker })), ORDERS)).json()) as RecommendationResponse;
    expect(body.generatedBy).toBe('rules+llm');
    expect(body.warnings).toEqual([]);
    expect(body.candidates.slice(0, 2).map((c) => c.title)).toEqual(['Revenue mix by region', 'Revenue']);
    expect(body.dashboard.title).toBe('Orders at a glance');
    // Only the chosen candidates go on the dashboard, with the new wording on the widgets.
    expect(Object.values(body.dashboard.widgets).map((w) => w.type).sort()).toEqual(['kpi', 'pie']);
    const pie = Object.values(body.dashboard.widgets).find((w) => w.type === 'pie')!;
    expect(pie.options).toMatchObject({ title: 'Revenue mix by region' });
    const kpi = Object.values(body.dashboard.widgets).find((w) => w.type === 'kpi')!;
    expect(kpi.options).toMatchObject({ label: 'Revenue' });
    // Unchosen candidates are still offered, after the chosen ones.
    expect(body.candidates.length).toBeGreaterThan(2);
  });

  it('falls back to rules when the ranker fails, refuses or is too slow', async () => {
    const onRankerError = vi.fn();
    for (const [ranker, warning] of [
      [fakeRanker(async () => Promise.reject(new Error('503 overloaded'))), /unavailable/],
      [fakeRanker(async () => Promise.reject(new RankerRefusedError('no'))), /declined/],
      [fakeRanker((_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))), /too long/],
      [fakeRanker(async () => ({ ranked: [] })), /no usable choices/],
    ] as const) {
      const recommender = new Recommender({ ranker, rankTimeoutMs: 50, onRankerError });
      const body = (await (await recommend(makeApp(recommender), ORDERS)).json()) as RecommendationResponse;
      expect(body.generatedBy).toBe('rules');
      expect(body.warnings.join(' ')).toMatch(warning);
      expect(validateDashboard(body.dashboard, { allowNewerMinor: false }).ok).toBe(true);
      expect(Object.keys(body.dashboard.widgets).length).toBeGreaterThanOrEqual(5);
    }
    expect(onRankerError).toHaveBeenCalledTimes(3);
  });

  it('sanitizes ranker output: unknown ids, duplicates, blank and overlong text', async () => {
    const candidates = generateCandidates(await sampleProfile());
    const [a, b] = candidates;
    const out = sanitizeRanking(
      {
        ranked: [
          { id: 'c_made_up', title: 'x', rationale: 'y' },
          { id: a!.id, title: '  ', rationale: 'r'.repeat(500) },
          { id: a!.id, title: 'dup', rationale: 'dup' },
          { id: b!.id, title: 'Line\nbreak   title', rationale: 'ok' },
          'garbage',
        ],
        dashboardTitle: 42,
      },
      candidates,
    );
    expect(out.ranked.map((r) => r.id)).toEqual([a!.id, b!.id]);
    expect(out.ranked[0]!.title).toBe(a!.title);
    expect(out.ranked[0]!.rationale.length).toBeLessThanOrEqual(160);
    expect(out.ranked[1]!.title).toBe('Line break title');
    expect(out.dashboardTitle).toBeUndefined();
    expect(sanitizeRanking(null, candidates).ranked).toEqual([]);
  });
});

describe('ClaudeRanker', () => {
  function fakeClient(response: unknown) {
    const create = vi.fn(async () => response);
    return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
  }

  it('sends the compact profile (never rows or id/measure samples) and parses structured output', async () => {
    const profile = await sampleProfile();
    const candidates = generateCandidates(profile);
    const { client, create } = fakeClient({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: JSON.stringify({ dashboardTitle: 'Sales', dashboardDescription: 'd', ranked: [{ id: candidates[1]!.id, title: 'T', rationale: 'R' }] }) },
      ],
    });
    const ranker = new ClaudeRanker({ client });
    const result = await ranker.rank({ sourceName: 'orders', profile, candidates }, new AbortController().signal);
    expect(result).toEqual({ ranked: [{ id: candidates[1]!.id, title: 'T', rationale: 'R' }], dashboardTitle: 'Sales', dashboardDescription: 'd' });

    const [params] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('temperature');
    const prompt = JSON.stringify(params.messages);
    // No identifiers or raw measure values leak; category labels may.
    expect(prompt).not.toContain('ord_000001');
    expect(prompt).not.toContain('cus_');
    expect(prompt).not.toContain('388.84');
    expect(prompt).toContain('North America');
  });

  it('turns a refusal into RankerRefusedError', async () => {
    const profile = await sampleProfile();
    const { client } = fakeClient({ stop_reason: 'refusal', content: [] });
    await expect(new ClaudeRanker({ client }).rank({ sourceName: 'x', profile, candidates: generateCandidates(profile) }, new AbortController().signal)).rejects.toBeInstanceOf(
      RankerRefusedError,
    );
  });

  it('compactProfile keeps summaries only', async () => {
    const compact = compactProfile(await sampleProfile());
    const byName = Object.fromEntries(compact.columns.map((c) => [c.name, c as Record<string, unknown>]));
    expect(byName.order_id).not.toHaveProperty('examples');
    expect(byName.customer_id).not.toHaveProperty('examples');
    expect(byName.amount).not.toHaveProperty('examples');
    expect(byName.amount).toHaveProperty('max');
    expect(byName.region!.examples).toEqual(expect.arrayContaining(['Europe']));
  });
});
