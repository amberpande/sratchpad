/**
 * A small Prometheus-compatible metrics registry (counters and histograms), exposed as text on
 * GET /metrics. Labels are low-cardinality on purpose: never team ids, dashboard ids or refs.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}

export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) lines.push(`${this.name}${key ? `{${key}}` : ''} ${value}`);
    return lines.join('\n');
  }
}

export class Histogram {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }

  count(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const sep = key ? `${key},` : '';
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ''} ${Math.round(s.sum * 1e6) / 1e6}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Metrics {
  readonly httpRequests = new Counter('bi_http_requests_total', 'HTTP requests by method, route and status.');
  readonly httpDuration = new Histogram('bi_http_request_duration_seconds', 'HTTP request latency until the response starts.');
  readonly queries = new Counter('bi_queries_total', 'Widget queries by engine and outcome (ok, cache_hit or an error code).');
  readonly queryDuration = new Histogram('bi_query_duration_seconds', 'Engine execution time of widget queries (cache misses only).');
  readonly cache = new Counter('bi_result_cache_total', 'Result cache lookups by result (hit, miss, bypass, error).');
  readonly recommendations = new Counter('bi_recommendations_total', 'Recommendation responses by generator (rules, rules+llm).');
  readonly rateLimited = new Counter('bi_rate_limited_total', 'Requests or queries rejected by a per-team limit, by limit.');
  readonly assistantTurns = new Counter('bi_assistant_turns_total', 'Studio assistant turns by outcome (changed, unchanged, declined, error).');

  render(): string {
    return `${[this.httpRequests, this.httpDuration, this.queries, this.queryDuration, this.cache, this.recommendations, this.rateLimited, this.assistantTurns].map((m) => m.render()).join('\n')}\n`;
  }
}
