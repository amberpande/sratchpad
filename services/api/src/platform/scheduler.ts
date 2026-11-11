import { randomBytes } from 'node:crypto';
import type { Logger } from '../obs/logger';
import type { Alert, PlatformService, RefreshSchedule, Subscription } from './service';
import type { PlatformStore } from './store';

/**
 * Runs due subscriptions, alerts and cache refreshes. Every ECS task runs a scheduler, but only the
 * holder of the "scheduler" lease (a row with an expiry in the platform store) does work on a tick,
 * so a job runs once even with many tasks. If the holder dies, its lease expires and another task
 * takes over within a few ticks.
 */

export interface SchedulerOptions {
  store: PlatformStore;
  service: PlatformService;
  logger?: Logger;
  now?: () => Date;
  /** Tick interval (default 60 s). The lease lives three ticks. */
  intervalMs?: number;
  holder?: string;
  /** At most this many jobs of each kind per tick (spreads bursts over ticks). */
  maxJobsPerTick?: number;
}

export interface TickResult {
  leader: boolean;
  subscriptions: number;
  alerts: number;
  refreshes: number;
}

export class Scheduler {
  readonly holder: string;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly options: SchedulerOptions) {
    this.holder = options.holder ?? `task_${randomBytes(6).toString('hex')}`;
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = { leader: false, subscriptions: 0, alerts: 0, refreshes: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const interval = this.options.intervalMs ?? 60_000;
      const now = this.now();
      if (!(await this.options.store.acquireLease('scheduler', this.holder, interval * 3, now))) return result;
      result.leader = true;
      const max = this.options.maxJobsPerTick ?? 50;
      const due = <T extends { nextRunAt: string }>(rows: Array<{ teamId: string; data: T }>) =>
        rows.filter((r) => Date.parse(r.data.nextRunAt) <= now.getTime()).slice(0, max);
      const { store, service, logger } = this.options;

      for (const r of due(await store.listAllTeams<Subscription>('subscriptions'))) {
        await service.runSubscription(r.teamId, r.data, { reschedule: true }).catch((error: unknown) => logger?.warn('subscription job failed', { error }));
        result.subscriptions++;
      }
      for (const r of due(await store.listAllTeams<Alert>('alerts'))) {
        await service.evaluateAlert(r.teamId, r.data).catch((error: unknown) => logger?.warn('alert job failed', { error }));
        result.alerts++;
      }
      for (const r of due(await store.listAllTeams<RefreshSchedule>('refresh'))) {
        await service.runRefresh(r.teamId, r.data).catch((error: unknown) => logger?.warn('refresh job failed', { error }));
        result.refreshes++;
      }
    } catch (error) {
      this.options.logger?.warn('scheduler tick failed', { error });
    } finally {
      this.running = false;
    }
    return result;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.options.store.releaseLease('scheduler', this.holder).catch(() => undefined);
  }
}
