import type { Cell } from '@yourorg/bi-spec';

/** A tiny inline line (table sparklines). Points are drawn in result order; non-numbers are gaps. */
export function Sparkline({ points, label, width = 96, height = 22 }: { points: Array<{ x: Cell; y: Cell }>; label: string; width?: number; height?: number }) {
  const ys = points.map((p) => (typeof p.y === 'number' ? p.y : null));
  const nums = ys.filter((v): v is number => v !== null);
  if (nums.length < 2) return <span className="bi-spark-empty">—</span>;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const step = width / Math.max(1, ys.length - 1);
  const yOf = (v: number) => (hi === lo ? height / 2 : height - 2 - ((v - lo) / (hi - lo)) * (height - 4));
  let d = '';
  let pen = false;
  ys.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${(i * step).toFixed(1)},${yOf(v).toFixed(1)}`;
    pen = true;
  });
  const last = ys.length - 1;
  const lastV = ys[last];
  return (
    <svg className="bi-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={d} fill="none" stroke="var(--bi-series-1)" strokeWidth={1.5} />
      {lastV !== null && lastV !== undefined && <circle cx={last * step} cy={yOf(lastV)} r={2} fill="var(--bi-series-1)" />}
    </svg>
  );
}
