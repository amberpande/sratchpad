/**
 * k-means over 2-D points (spec 1.4 scatter `cluster`, D-085). Coordinates are scaled to 0–1 first so
 * neither axis dominates. Deterministic: k-means++-style seeding from a fixed order (farthest point),
 * so every viewer sees the same clusters, and labels are ordered by cluster centre (left to right).
 */
export function kmeans(points: Array<[number, number]>, k: number, iterations = 50): number[] {
  const n = points.length;
  if (n === 0) return [];
  const kk = Math.max(1, Math.min(k, n));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const scale = (v: number, lo: number, hi: number) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pts = points.map(([x, y]) => [scale(x, x0, x1), scale(y, y0, y1)] as [number, number]);
  const d2 = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // Seeds: the point nearest the mean, then repeatedly the point farthest from every seed.
  const mean: [number, number] = [pts.reduce((a, p) => a + p[0], 0) / n, pts.reduce((a, p) => a + p[1], 0) / n];
  const centres: Array<[number, number]> = [pts.reduce((best, p) => (d2(p, mean) < d2(best, mean) ? p : best), pts[0]!)];
  while (centres.length < kk) {
    centres.push(pts.reduce((best, p) => (Math.min(...centres.map((c) => d2(p, c))) > Math.min(...centres.map((c) => d2(best, c))) ? p : best), pts[0]!));
  }
  let labels = new Array<number>(n).fill(0);
  for (let it = 0; it < iterations; it++) {
    const next = pts.map((p) => centres.reduce((best, c, j) => (d2(p, c) < d2(p, centres[best]!) ? j : best), 0));
    const moved = next.some((l, i) => l !== labels[i]);
    labels = next;
    for (let j = 0; j < kk; j++) {
      const members = pts.filter((_, i) => labels[i] === j);
      if (members.length) centres[j] = [members.reduce((a, p) => a + p[0], 0) / members.length, members.reduce((a, p) => a + p[1], 0) / members.length];
    }
    if (!moved && it > 0) break;
  }
  // Stable naming: cluster 0 is the left-most centre.
  const order = centres.map((c, j) => [c[0], c[1], j] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((c) => c[2]);
  const rename = new Map(order.map((old, i) => [old, i]));
  return labels.map((l) => rename.get(l)!);
}
