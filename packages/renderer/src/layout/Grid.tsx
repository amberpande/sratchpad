import { GRID_COLUMNS, type LayoutItem, type MobileLayoutItem } from '@yourorg/bi-spec';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export const ROW_HEIGHT = 72;
export const GAP = 16;
/** Below this container width, widgets stack in reading order. */
export const STACK_BELOW = 640;

function useElementWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Reads the spec's grid (the react-grid-layout shape: x, y, w, h on 12 columns) and places
 * widgets with CSS grid. The authoring canvas uses the same model, so what you build is what renders.
 */
export function Grid({
  items,
  children,
  gap = GAP,
  mobile,
}: {
  items: LayoutItem[];
  children: (item: LayoutItem) => ReactNode;
  gap?: number;
  /** Spec 1.3 mobileLayout: order, height and hiding when the grid stacks on narrow screens. */
  mobile?: MobileLayoutItem[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const stacked = width > 0 && width < STACK_BELOW;
  const mob = new Map((mobile ?? []).map((m) => [m.i, m]));
  const readingOrder = (a: LayoutItem, b: LayoutItem) => a.y - b.y || a.x - b.x;
  const ordered = stacked
    ? items
        .filter((it) => !mob.get(it.i)?.hide)
        .sort((a, b) => (mob.get(a.i)?.order ?? 1e6) - (mob.get(b.i)?.order ?? 1e6) || readingOrder(a, b))
    : items;

  return (
    <div
      ref={ref}
      className="bi-grid"
      data-stacked={stacked || undefined}
      style={{
        gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
        gridAutoRows: `${ROW_HEIGHT}px`,
        gap: `${gap}px`,
      }}
    >
      {ordered.map((item) => (
        <div
          key={item.i}
          data-widget-id={item.i}
          style={
            stacked
              ? { gridRow: `span ${mob.get(item.i)?.h ?? Math.max(item.h, 2)}`, minWidth: 0, minHeight: 0, display: 'flex' }
              : { gridColumn: `${item.x + 1} / span ${item.w}`, gridRow: `${item.y + 1} / span ${item.h}`, minWidth: 0, minHeight: 0, display: 'flex' }
          }
        >
          {children(item)}
        </div>
      ))}
    </div>
  );
}
