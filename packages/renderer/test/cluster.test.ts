import { describe, expect, it } from 'vitest';
import { kmeans } from '../src/widgets/cluster';

describe('k-means clustering (D-085)', () => {
  it('separates obvious groups, deterministically, named left to right', () => {
    const pts: Array<[number, number]> = [[100, 1], [101, 2], [99, 1], [1, 50], [2, 51], [0, 49], [50, 100], [51, 99]];
    const a = kmeans(pts, 3);
    expect(a).toEqual(kmeans(pts, 3));
    expect(new Set(a.slice(0, 3)).size).toBe(1);
    expect(new Set(a.slice(3, 6)).size).toBe(1);
    expect(a[3]).toBe(0); // x≈1 is the left-most cluster
    expect(a[0]).toBe(2);
    expect(new Set(a).size).toBe(3);
  });
  it('handles fewer points than k and empty input', () => {
    expect(kmeans([[1, 1]], 3)).toEqual([0]);
    expect(kmeans([], 2)).toEqual([]);
  });
});
