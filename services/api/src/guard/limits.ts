/**
 * Per-team guardrails. One shared backend means one team's runaway dashboard or script must not
 * starve the others or run up a warehouse bill:
 *
 *   RateLimiter   – token bucket per (team, bucket): requests per minute, with bursts.
 *   QueryGate     – at most N queries executing per team at once; more wait in a bounded queue.
 *
 * Both are in-process. With several replicas each enforces its own share; move them to Redis if
 * exact global limits matter.
 */

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** perMinute <= 0 disables the limit. */
  constructor(
    private readonly perMinute: number,
    private readonly burst = perMinute,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token. Returns 0 when allowed, else the seconds until a token is available. */
  take(key: string): number {
    if (this.perMinute <= 0) return 0;
    const t = this.now();
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * rate);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    if (this.buckets.size > 10_000) this.prune(t);
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets) if (t - b.at > 600_000) this.buckets.delete(k);
  }
}

export class QueueFullError extends Error {}

class Semaphore {
  active = 0;
  readonly waiting: Array<{ resolve(): void; reject(e: unknown): void }> = [];
}

export class QueryGate {
  private readonly teams = new Map<string, Semaphore>();

  /** maxConcurrent <= 0 disables the gate. */
  constructor(
    readonly maxConcurrent: number,
    readonly maxQueued: number,
  ) {}

  /** Resolves with a release function once the team has a free slot. */
  async acquire(teamId: string, signal?: AbortSignal): Promise<() => void> {
    if (this.maxConcurrent <= 0) return () => {};
    let s = this.teams.get(teamId);
    if (!s) {
      s = new Semaphore();
      this.teams.set(teamId, s);
    }
    const sem = s;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = sem.waiting.shift();
      if (next) next.resolve();
      else if (--sem.active === 0) this.teams.delete(teamId);
    };
    if (sem.active < this.maxConcurrent) {
      sem.active++;
      return release;
    }
    if (sem.waiting.length >= this.maxQueued) throw new QueueFullError('Too many queries are already running for this team.');
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const i = sem.waiting.indexOf(waiter);
        if (i >= 0) sem.waiting.splice(i, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      sem.waiting.push(waiter);
    });
    // The releasing query handed its slot over, so `active` is unchanged.
    return release;
  }

  active(teamId: string): number {
    return this.teams.get(teamId)?.active ?? 0;
  }
}
