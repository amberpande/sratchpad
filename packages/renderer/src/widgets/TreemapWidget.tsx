import type { TreemapWidget as TreemapSpec } from '@yourorg/bi-spec';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { useMemo } from 'react';
import { formatValue, humanize, pickFormat } from '../format';
import { seriesColor } from '../styles';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { useMarks, useSize } from './vizParts';

interface Leaf {
  name: string;
  group: string;
  value: number;
}

/**
 * Treemap: rectangles sized by an additive measure, optionally nested in groups. Shows the largest
 * `maxNodes`; the rest are left out with a note (never summed into "Other" in the browser).
 */
export default function TreemapWidget({ widget, result, format }: WidgetProps<TreemapSpec>) {
  const { category, value, group } = widget.encoding;
  const fmt = pickFormat(widget.options.numberFormats, value, widget.options.format);
  const marks = useMarks(category);
  const [ref, size] = useSize<HTMLDivElement>();
  const prepared = useMemo(() => {
    const leaves: Leaf[] = [];
    let negative = 0;
    for (const r of result.rows) {
      const v = r[value];
      if (typeof v !== 'number' || v === 0) continue;
      if (v < 0) {
        negative++;
        continue;
      }
      leaves.push({ name: String(r[category] ?? '(blank)'), group: group ? String(r[group] ?? '(blank)') : '', value: v });
    }
    leaves.sort((a, b) => b.value - a.value);
    const shown = leaves.slice(0, widget.options.maxNodes);
    return { shown, hidden: leaves.length - shown.length, negative };
  }, [result, category, value, group, widget.options.maxNodes]);

  const nodes = useMemo(() => {
    if (!size.width || !prepared.shown.length) return [];
    const groups = new Map<string, Leaf[]>();
    for (const l of prepared.shown) groups.set(l.group, [...(groups.get(l.group) ?? []), l]);
    const root = hierarchy<{ children?: unknown[]; leaf?: Leaf }>({
      children: [...groups.entries()].map(([name, ls]) => ({ name, children: ls.map((leaf) => ({ leaf })) })),
    })
      .sum((d) => d.leaf?.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const layout = treemap<{ children?: unknown[]; leaf?: Leaf }>().tile(treemapSquarify).size([size.width, size.height]).paddingInner(2).paddingTop(group ? 16 : 0)(root);
    const groupIndex = new Map([...groups.keys()].map((g, i) => [g, i]));
    return layout.leaves().map((n) => ({ x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1, leaf: n.data.leaf!, color: seriesColor(group ? (groupIndex.get(n.data.leaf!.group)! % 8) : 0) }));
  }, [prepared, size, group]);

  if (prepared.negative) return <Message title="Can’t show as a treemap" detail={`${humanize(value)} has negative values; rectangles show parts of a positive whole.`} />;
  if (!prepared.shown.length) return <Message title="No data" />;
  const vMeta = column(result, value);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div ref={ref} style={{ flex: 1, minHeight: 0, cursor: marks.cursor }} role="img" aria-label={`Treemap of ${humanize(value)} by ${humanize(category)}${group ? ` within ${humanize(group)}` : ''}`}>
        {size.width > 0 && (
          <svg width={size.width} height={size.height} className="bi-treemap">
            {nodes.map((n, i) => {
              const w = n.x1 - n.x0;
              const h = n.y1 - n.y0;
              const text = formatValue(n.leaf.value, fmt, vMeta, format, { compact: true });
              return (
                <g key={i} onClick={(e) => marks.onSelect(n.leaf.name, e)} opacity={marks.opacity(n.leaf.name)}>
                  <rect x={n.x0} y={n.y0} width={w} height={h} rx={3} fill={n.color} fillOpacity={0.85}>
                    <title>{`${group ? `${n.leaf.group} · ` : ''}${n.leaf.name}: ${formatValue(n.leaf.value, fmt, vMeta, format)}`}</title>
                  </rect>
                  {w > 48 && h > 30 && (
                    <text x={n.x0 + 6} y={n.y0 + 16} className="bi-treemap-label">
                      <tspan>{n.leaf.name.length * 7 > w - 8 ? `${n.leaf.name.slice(0, Math.max(1, Math.floor((w - 16) / 7)))}…` : n.leaf.name}</tspan>
                      <tspan x={n.x0 + 6} dy={15} className="bi-treemap-value">
                        {text}
                      </tspan>
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {prepared.hidden > 0 && <p className="bi-viz-note">{prepared.hidden} smaller item(s) not shown.</p>}
    </div>
  );
}
