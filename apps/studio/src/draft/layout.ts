import { GRID_COLUMNS, type LayoutItem } from '@yourorg/bi-spec';

export const collides = (a: LayoutItem, b: LayoutItem) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** First free spot for a w×h widget, scanning rows top to bottom, left to right. */
export function findSpot(layout: LayoutItem[], w: number, h: number): { x: number; y: number } {
  const width = Math.min(w, GRID_COLUMNS);
  const bottom = layout.reduce((max, it) => Math.max(max, it.y + it.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + width <= GRID_COLUMNS; x++) {
      const probe = { i: '', x, y, w: width, h };
      if (!layout.some((it) => collides(it, probe))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}

/** Moves every item as far up as it can go, keeping reading order. */
export function compactLayout(layout: LayoutItem[]): LayoutItem[] {
  const order = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: LayoutItem[] = [];
  for (const item of order) {
    let y = item.y;
    // Items on different tabs (spec 1.3) never collide: each tab is its own grid.
    while (y > 0 && !placed.some((p) => (p.tab ?? null) === (item.tab ?? null) && collides(p, { ...item, y: y - 1 }))) y--;
    placed.push({ ...item, y });
  }
  const byId = new Map(placed.map((p) => [p.i, p]));
  return layout.map((it) => byId.get(it.i)!);
}

export function sameLayout(a: LayoutItem[], b: LayoutItem[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((it) => [it.i, it]));
  return b.every((it) => {
    const o = byId.get(it.i);
    return o !== undefined && o.x === it.x && o.y === it.y && o.w === it.w && o.h === it.h;
  });
}
