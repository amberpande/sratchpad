import type { SankeyWidget as SankeySpec } from '@yourorg/bi-spec';
import { sankey, sankeyJustify, sankeyLeft, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from 'd3-sankey';
import { useMemo } from 'react';
import { formatValue, humanize, pickFormat } from '../format';
import { seriesColor } from '../styles';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { useMarks, useSize } from './vizParts';

type N = { name: string };
type L = { source: string; target: string; value: number };

/** Sankey: flows from source to target values sized by an additive measure. Cycles can't be drawn. */
export default function SankeyWidget({ widget, result, format }: WidgetProps<SankeySpec>) {
  const { source, target, value } = widget.encoding;
  const fmt = pickFormat(widget.options.numberFormats, value, widget.options.format);
  const marks = useMarks(source);
  const [ref, size] = useSize<HTMLDivElement>();
  const graph = useMemo(() => {
    if (!size.width) return null;
    // Node ids are prefixed by side so a value present as both source and target stays two nodes.
    const names = new Map<string, N>();
    const links: L[] = [];
    for (const r of result.rows) {
      const v = r[value];
      if (typeof v !== 'number' || v <= 0) continue;
      const s = `s:${String(r[source] ?? '(blank)')}`;
      const t = `t:${String(r[target] ?? '(blank)')}`;
      names.set(s, { name: s });
      names.set(t, { name: t });
      links.push({ source: s, target: t, value: v });
    }
    if (!links.length) return { error: 'empty' as const };
    try {
      const layout = sankey<N, L>()
        .nodeId((d) => d.name)
        .nodeAlign(widget.options.nodeAlign === 'left' ? sankeyLeft : sankeyJustify)
        .nodeWidth(12)
        .nodePadding(10)
        .extent([
          [1, 4],
          [size.width - 1, size.height - 4],
        ]);
      return layout({ nodes: [...names.values()].map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) });
    } catch {
      return { error: 'cycle' as const };
    }
  }, [result, source, target, value, size, widget.options.nodeAlign]);

  const meta = column(result, value);
  if (graph && 'error' in graph) {
    return graph.error === 'empty' ? <Message title="No data" /> : <Message title="Can’t draw these flows" detail="The flows form a cycle; a sankey needs flows that move in one direction." />;
  }
  const nodes = (graph?.nodes ?? []) as Array<SankeyNode<N, L>>;
  const links = (graph?.links ?? []) as Array<SankeyLink<N, L>>;
  const display = (n: SankeyNode<N, L>) => n.name.slice(2);
  const index = new Map(nodes.map((n, i) => [n.name, i]));
  const path = sankeyLinkHorizontal<N, L>();
  return (
    <div ref={ref} style={{ height: '100%', cursor: marks.cursor }} role="img" aria-label={`Sankey of ${humanize(value)} from ${humanize(source)} to ${humanize(target)}`}>
      {size.width > 0 && graph && (
        <svg width={size.width} height={size.height} className="bi-sankey">
          {links.map((l, i) => {
            const s = l.source as SankeyNode<N, L>;
            const t = l.target as SankeyNode<N, L>;
            return (
              <path key={i} d={path(l) ?? undefined} fill="none" stroke={seriesColor((index.get(s.name) ?? 0) % 8)} strokeOpacity={0.35 * marks.opacity(display(s))} strokeWidth={Math.max(1, l.width ?? 1)} onClick={(e) => marks.onSelect(display(s), e)}>
                <title>{`${display(s)} → ${display(t)}: ${formatValue(l.value, fmt, meta, format)}`}</title>
              </path>
            );
          })}
          {nodes.map((n, i) => {
            const left = n.name.startsWith('s:');
            return (
              <g key={n.name} onClick={(e) => left && marks.onSelect(display(n), e)}>
                <rect x={n.x0} y={n.y0} width={(n.x1 ?? 0) - (n.x0 ?? 0)} height={Math.max(1, (n.y1 ?? 0) - (n.y0 ?? 0))} fill={seriesColor(i % 8)} opacity={left ? marks.opacity(display(n)) : 1}>
                  <title>{`${display(n)}: ${formatValue(n.value ?? 0, fmt, meta, format)}`}</title>
                </rect>
                <text x={left ? (n.x1 ?? 0) + 6 : (n.x0 ?? 0) - 6} y={((n.y0 ?? 0) + (n.y1 ?? 0)) / 2} textAnchor={left ? 'start' : 'end'} dominantBaseline="middle" className="bi-axis-text">
                  {display(n)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
