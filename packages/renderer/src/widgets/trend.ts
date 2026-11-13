import type { Cell, ResultColumn } from '@yourorg/bi-spec';

/**
 * Trend lines and forecasts (spec 1.4, D-081), computed in the browser from the already-aggregated
 * rows: ordinary least squares over the row order (equally spaced periods), or a trailing moving
 * average. Forecasts extend a linear fit by whole periods with a 95% prediction band
 * (±1.96 × residual standard error, widened for distance from the data).
 */

export interface TrendOptions {
  type?: 'linear' | 'moving_average';
  forecast?: number;
  window?: number;
}

type Row = Record<string, Cell | [number, number]>;

const DAY = 86_400_000;

/** The next x value after `last`: a date stepped by the grain (or the inferred spacing), or a number stepped by the average gap. */
export function nextX(values: Cell[], column: ResultColumn | undefined, steps: number): Cell | null {
  const last = values.at(-1);
  if (typeof last === 'number') {
    const nums = values.filter((v): v is number => typeof v === 'number');
    const gap = nums.length > 1 ? (nums.at(-1)! - nums[0]!) / (nums.length - 1) : 1;
    return last + gap * steps;
  }
  if (typeof last !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(last)) return null;
  let grain = column?.grain;
  if (!grain) {
    const times = values.filter((v): v is string => typeof v === 'string').map((v) => Date.parse(`${v.slice(0, 10)}T00:00:00Z`));
    const gaps = times.slice(1).map((t, i) => (t - times[i]!) / DAY).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] ?? 1;
    grain = median >= 300 ? 'year' : median >= 80 ? 'quarter' : median >= 27 ? 'month' : median >= 6 ? 'week' : 'day';
  }
  const d = new Date(`${last.slice(0, 10)}T00:00:00Z`);
  if (grain === 'day') d.setUTCDate(d.getUTCDate() + steps);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7 * steps);
  else if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + steps);
  else if (grain === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3 * steps);
  else d.setUTCFullYear(d.getUTCFullYear() + steps);
  return d.toISOString().slice(0, 10);
}

export function linearFit(ys: Array<number | null>): { slope: number; intercept: number; se: number; n: number; meanX: number; sxx: number } | null {
  const pts = ys.map((y, i) => [i, y] as const).filter((p): p is readonly [number, number] => typeof p[1] === 'number' && Number.isFinite(p[1]));
  const n = pts.length;
  if (n < 2) return null;
  const meanX = pts.reduce((a, p) => a + p[0], 0) / n;
  const meanY = pts.reduce((a, p) => a + p[1], 0) / n;
  const sxx = pts.reduce((a, p) => a + (p[0] - meanX) ** 2, 0);
  const sxy = pts.reduce((a, p) => a + (p[0] - meanX) * (p[1] - meanY), 0);
  const slope = sxx ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const sse = pts.reduce((a, p) => a + (p[1] - (intercept + slope * p[0])) ** 2, 0);
  const se = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  return { slope, intercept, se, n, meanX, sxx };
}

/**
 * Adds `<key>__trend` (and for forecasts `<key>__band` = [low, high]) to the rows, appending forecast
 * rows after the data. Returns the new rows and the keys that were added.
 */
export function withTrend(rows: Row[], seriesKeys: string[], xKey: string, xColumn: ResultColumn | undefined, opts: TrendOptions): { rows: Row[]; trendKeys: string[]; bandKeys: string[] } {
  const out: Row[] = rows.map((r) => ({ ...r }));
  const trendKeys: string[] = [];
  const bandKeys: string[] = [];
  const type = opts.type ?? 'linear';
  const horizon = type === 'linear' ? Math.max(0, opts.forecast ?? 0) : 0;
  const xs = rows.map((r) => r[xKey] as Cell);
  const future: Row[] = [];
  for (let h = 1; h <= horizon; h++) {
    const x = nextX(xs, xColumn, h);
    if (x === null) break;
    future.push({ [xKey]: x });
  }
  for (const key of seriesKeys) {
    const ys = rows.map((r) => (typeof r[key] === 'number' ? (r[key] as number) : null));
    const tKey = `${key}__trend`;
    if (type === 'moving_average') {
      const w = Math.max(2, opts.window ?? 3);
      out.forEach((r, i) => {
        const win = ys.slice(Math.max(0, i - w + 1), i + 1).filter((v): v is number => v !== null);
        r[tKey] = i >= w - 1 && win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
      });
      trendKeys.push(tKey);
      continue;
    }
    const fit = linearFit(ys);
    if (!fit) continue;
    out.forEach((r, i) => (r[tKey] = fit.intercept + fit.slope * i));
    trendKeys.push(tKey);
    if (future.length) {
      const bKey = `${key}__band`;
      bandKeys.push(bKey);
      // The last real point also starts the band, so it joins the data.
      const lastIdx = rows.length - 1;
      out[lastIdx]![bKey] = [out[lastIdx]![tKey] as number, out[lastIdx]![tKey] as number];
      future.forEach((r, h) => {
        const i = rows.length + h;
        const yhat = fit.intercept + fit.slope * i;
        const spread = 1.96 * fit.se * Math.sqrt(1 + 1 / fit.n + (fit.sxx ? (i - fit.meanX) ** 2 / fit.sxx : 0));
        r[tKey] = yhat;
        r[bKey] = [yhat - spread, yhat + spread];
      });
    }
  }
  return { rows: [...out, ...future], trendKeys, bandKeys };
}
