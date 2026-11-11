/**
 * When scheduled jobs run. Times are wall-clock in an IANA time zone, so "every Monday at 08:00
 * Europe/Berlin" stays at 08:00 across daylight-saving changes.
 */

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface Schedule {
  frequency: Frequency;
  /** "HH:MM" (daily/weekly/monthly); hourly uses only the minutes. */
  time: string;
  timezone: string;
  /** 0 = Sunday … 6 = Saturday (weekly). */
  dayOfWeek?: number;
  /** 1–28 (monthly; 28 max so every month has it). */
  dayOfMonth?: number;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateSchedule(s: unknown): string | null {
  if (!s || typeof s !== 'object') return 'schedule must be an object';
  const v = s as Partial<Schedule>;
  if (!['hourly', 'daily', 'weekly', 'monthly'].includes(String(v.frequency))) return 'schedule.frequency must be hourly, daily, weekly or monthly';
  if (typeof v.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) return 'schedule.time must be "HH:MM"';
  if (typeof v.timezone !== 'string' || !isValidTimezone(v.timezone)) return 'schedule.timezone must be an IANA time zone, e.g. "Europe/Berlin"';
  if (v.frequency === 'weekly' && !(Number.isInteger(v.dayOfWeek) && v.dayOfWeek! >= 0 && v.dayOfWeek! <= 6)) return 'schedule.dayOfWeek must be 0–6';
  if (v.frequency === 'monthly' && !(Number.isInteger(v.dayOfMonth) && v.dayOfMonth! >= 1 && v.dayOfMonth! <= 28)) return 'schedule.dayOfMonth must be 1–28';
  return null;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function partsIn(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour! % 24, minute: +p.minute!, weekday: WEEKDAYS[p.weekday!]! };
}

/**
 * The UTC instant of a wall-clock time in a zone. In a DST gap (a time that doesn't exist, e.g. 02:30 on
 * spring-forward day) it moves forward; in an overlap (fall-back) it picks the earlier instant.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (t: number) => {
    const p = partsIn(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000;
  };
  const matches = (t: number) => {
    const p = partsIn(new Date(t), tz);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  };
  const before = target - offset(target - 86_400_000);
  const after = target - offset(target + 86_400_000);
  const valid = [before, after].filter(matches).sort((a, b) => a - b);
  return new Date(valid[0] ?? before);
}

/** The first run strictly after `after`. */
export function nextRun(s: Schedule, after: Date): Date {
  const [hh, mm] = s.time.split(':').map(Number) as [number, number];
  if (s.frequency === 'hourly') {
    // Zone offsets are whole minutes; fold the zone's minute offset in once, then step minutes in UTC.
    const offset = (partsIn(after, s.timezone).minute - after.getUTCMinutes() + 60) % 60;
    const base = Math.floor(after.getTime() / 60_000) * 60_000;
    for (let i = 1; i <= 60; i++) {
      const t = new Date(base + i * 60_000);
      if ((t.getUTCMinutes() + offset) % 60 === mm) return t;
    }
  }
  const start = partsIn(after, s.timezone);
  for (let d = 0; d < 70; d++) {
    const dayUtc = new Date(Date.UTC(start.year, start.month - 1, start.day + d));
    const y = dayUtc.getUTCFullYear();
    const m = dayUtc.getUTCMonth() + 1;
    const day = dayUtc.getUTCDate();
    const weekday = dayUtc.getUTCDay();
    if (s.frequency === 'weekly' && weekday !== s.dayOfWeek) continue;
    if (s.frequency === 'monthly' && day !== s.dayOfMonth) continue;
    const t = zonedTimeToUtc(y, m, day, hh, mm, s.timezone);
    if (t > after) return t;
  }
  throw new Error('No next run found');
}

/** How long a subscription's share link should live: a bit longer than the gap between runs. */
export function linkLifetimeDays(f: Frequency): number {
  return { hourly: 2, daily: 3, weekly: 10, monthly: 40 }[f];
}
