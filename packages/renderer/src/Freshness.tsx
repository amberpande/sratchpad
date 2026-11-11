import { createContext, useContext, useSyncExternalStore } from 'react';
import { formatAge } from './format';

/**
 * One shared clock for every freshness label on the page: a single interval, started on the
 * first subscriber and stopped with the last, so N widgets don't mean N timers.
 */
const TICK_MS = 30_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}

/** The oldest timestamp: a dashboard is only as fresh as its stalest widget. */
export function oldestAsOf(values: Array<string | undefined>): string | undefined {
  let oldest: string | undefined;
  let oldestT = Infinity;
  for (const v of values) {
    const t = v ? Date.parse(v) : NaN;
    if (!Number.isNaN(t) && t < oldestT) {
      oldestT = t;
      oldest = v;
    }
  }
  return oldest;
}

/** "Updated 3 min ago". Renders nothing without a timestamp; callers reserve no space for it. */
export function Freshness({ asOf, cached, floating }: { asOf?: string; cached?: boolean; floating?: boolean }) {
  const current = useNow();
  const age = asOf ? formatAge(asOf, Math.max(current, Date.now() - TICK_MS)) : null;
  if (!asOf || !age) return null;
  const exact = new Date(asOf).toLocaleString();
  return (
    <time className="bi-fresh" dateTime={asOf} title={`Data as of ${exact}${cached ? ' (cached)' : ''}`} data-floating={floating || undefined}>
      Updated {age}
    </time>
  );
}

/**
 * The timestamp the dashboard header already shows. Read through context (not a prop) so a
 * new dashboard timestamp re-renders only these small labels, never the memoized widgets.
 */
export const DashboardAsOfContext = createContext<string | undefined>(undefined);

function sameMinute(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) < 60_000;
}

/** A widget repeats its timestamp only when it differs from the dashboard's by a minute or more. */
export function WidgetFreshness(props: { asOf?: string; cached?: boolean; floating?: boolean }) {
  const dashboardAsOf = useContext(DashboardAsOfContext);
  return <Freshness {...props} asOf={sameMinute(props.asOf, dashboardAsOf) ? undefined : props.asOf} />;
}
