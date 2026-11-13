import type { DataSource, Recommendation, RecommendationResponse, SourceProfile } from '@yourorg/bi-spec';
import { assembleDashboard } from './assemble';
import { classify, generateCandidates, type Candidate } from './candidates';
import { RankerRefusedError, RuleRanker, type Ranker, type RankResult } from './ranker';

/**
 * profile → classify → generate candidates → rank (+ explain) → assemble.
 *
 * Classification, candidate generation, query building and layout are deterministic. The ranker
 * (Claude when configured) only orders and words them. If it is missing, slow, refuses or answers
 * badly, the response is the rules' answer with `generatedBy: "rules"`: the AI assists, never blocks.
 */

export interface RecommenderOptions {
  /** Null/undefined: rules only. */
  ranker?: Ranker | null;
  /** Hard deadline for the ranking step, after which the rules answer is used. */
  rankTimeoutMs?: number;
  onRankerError?: (error: unknown) => void;
}

export interface RecommendInput {
  source: DataSource;
  sourceName: string;
  profile: SourceProfile;
  signal?: AbortSignal;
  /** False for teams not allowed to send profiles to an external model (BI_AI_TEAMS, D-077): rules only. */
  allowLlm?: boolean;
}

function deadline(ms: number, outer?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Ranking timed out', 'TimeoutError')), ms);
  const onOuter = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuter, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });
}

export class Recommender {
  private readonly ranker: Ranker | null;
  private readonly rules = new RuleRanker();
  private readonly timeoutMs: number;

  constructor(private readonly options: RecommenderOptions = {}) {
    this.ranker = options.ranker ?? null;
    this.timeoutMs = options.rankTimeoutMs ?? 25_000;
  }

  get llmEnabled(): boolean {
    return this.ranker !== null;
  }

  async recommend(input: RecommendInput): Promise<RecommendationResponse> {
    const fields = classify(input.profile);
    const candidates = generateCandidates(input.profile, fields);
    const warnings: string[] = [];
    if (!fields.measures.length) warnings.push('No numeric measure columns were found, so suggestions count rows instead of summing values.');
    if (!fields.time) warnings.push('No date column was found, so there is no trend chart or date-range control.');
    if (input.profile.sampled) warnings.push('The profile was built from a sample of the table; distinct counts are approximate.');

    let ranking: RankResult | null = null;
    let generatedBy: RecommendationResponse['generatedBy'] = 'rules';
    if (this.ranker && candidates.length > 1 && input.allowLlm !== false) {
      const d = deadline(this.timeoutMs, input.signal);
      try {
        const result = await abortable(this.ranker.rank({ sourceName: input.sourceName, profile: input.profile, candidates }, d.signal), d.signal);
        if (result.ranked.length) {
          ranking = result;
          generatedBy = 'rules+llm';
        } else {
          warnings.push('AI ranking returned no usable choices; showing the rule-based order.');
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        this.options.onRankerError?.(error);
        warnings.push(
          error instanceof RankerRefusedError
            ? 'AI ranking was declined for this source; showing the rule-based order.'
            : d.signal.aborted
              ? 'AI ranking took too long; showing the rule-based order.'
              : 'AI ranking is unavailable right now; showing the rule-based order.',
        );
      } finally {
        d.clear();
      }
    }
    ranking ??= await this.rules.rank({ sourceName: input.sourceName, profile: input.profile, candidates });

    // Apply the ranking: chosen ones first (with the ranker's wording), the rest after in rule order.
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const chosen: Candidate[] = ranking.ranked.map((r) => ({ ...byId.get(r.id)!, title: r.title, rationale: r.rationale }));
    const chosenIds = new Set(chosen.map((c) => c.id));
    const rest = candidates.filter((c) => !chosenIds.has(c.id));
    const ordered = [...chosen, ...rest].map((c, i, all) => ({ ...c, score: Math.round((1 - i / Math.max(all.length, 1)) * 1000) / 1000 }));

    // Retitled candidates carry their new title into the widget too.
    const withTitles = ordered.map((c) => retitle(c));
    const { dashboard, used } = assembleDashboard({
      source: input.source,
      sourceName: input.sourceName,
      candidates: withTitles.slice(0, chosen.length || withTitles.length),
      title: ranking.dashboardTitle,
      description: ranking.dashboardDescription,
      timeField: fields.time?.name,
    });
    if (!used.length) warnings.push('No charts could be suggested for this source.');

    return {
      source: input.source,
      profile: input.profile,
      candidates: withTitles.map(toRecommendation),
      dashboard,
      generatedBy,
      warnings,
    };
  }
}

function retitle(c: Candidate): Candidate {
  const w = c.widget as { type: string; options?: Record<string, unknown> };
  if (!w.options) return c;
  const options = w.type === 'kpi' ? { ...w.options, label: c.title } : { ...w.options, title: c.title };
  return { ...c, widget: { ...w, options } as Candidate['widget'] };
}

function toRecommendation(c: Candidate): Recommendation {
  return { id: c.id, title: c.title, rationale: c.rationale, pattern: c.pattern, query: c.query, widget: c.widget, score: c.score };
}
