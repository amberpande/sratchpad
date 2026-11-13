import { describe, expect, it } from 'vitest';
import { linearFit, nextX, withTrend } from '../src/widgets/trend';

describe('trend lines and forecasts (D-081)', () => {
  it('fits a straight line exactly and projects whole periods', () => {
    const rows = [1, 2, 3, 4].map((v, i) => ({ x: `2026-0${i + 1}-01`, y: v * 10 }));
    const { rows: out, trendKeys, bandKeys } = withTrend(rows, ['y'], 'x', { name: 'x', type: 'time', grain: 'month' }, { type: 'linear', forecast: 2 });
    expect(trendKeys).toEqual(['y__trend']);
    expect(bandKeys).toEqual(['y__band']);
    expect(out.map((r) => r.x)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']);
    expect(out.map((r) => Math.round(r.y__trend as number))).toEqual([10, 20, 30, 40, 50, 60]);
    // Perfect fit: zero-width band.
    expect(out[5]!.y__band).toEqual([60, 60]);
  });

  it('widens the band with noise and distance', () => {
    const ys = [10, 14, 9, 15, 11, 16];
    const { rows: out } = withTrend(ys.map((y, i) => ({ x: i, y })), ['y'], 'x', undefined, { forecast: 3 });
    const widths = out.slice(6).map((r) => (r.y__band as [number, number])[1] - (r.y__band as [number, number])[0]);
    expect(widths[0]).toBeGreaterThan(0);
    expect(widths[2]).toBeGreaterThan(widths[0]!);
    expect(out.at(-1)!.x).toBe(8);
  });

  it('moving average, skips nulls, infers weekly spacing', () => {
    const { rows } = withTrend([{ x: 'a', y: 3 }, { x: 'b', y: null }, { x: 'c', y: 9 }, { x: 'd', y: 6 }], ['y'], 'x', undefined, { type: 'moving_average', window: 2 });
    expect(rows.map((r) => r.y__trend)).toEqual([null, 3, 9, 7.5]);
    expect(nextX(['2026-01-05', '2026-01-12', '2026-01-19'], undefined, 1)).toBe('2026-01-26');
    expect(linearFit([5])).toBeNull();
  });
});
