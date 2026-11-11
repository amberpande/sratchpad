import type { TextWidget as TextSpec } from '@yourorg/bi-spec';
import { useMemo, type ReactNode } from 'react';
import type { WidgetProps } from './types';

/**
 * Markdown-lite, rendered as React elements (never innerHTML), so author text can't inject
 * markup or script. Supported: paragraphs, "#"–"###" headings, "-"/"*" and "1." lists,
 * **bold**, *italic* / _italic_, `code`, and [links](https://…) (http, https and mailto only).
 */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

export function renderInline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = m[0];
    const key = `${keyPrefix}${n++}`;
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{renderInline(token.slice(2, -2), `${key}.`)}</strong>);
    else if (m[3]) out.push(<em key={key}>{renderInline(token.slice(1, -1), `${key}.`)}</em>);
    else {
      const [, label = '', href = ''] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token) ?? [];
      out.push(
        SAFE_HREF.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {renderInline(label, `${key}.`)}
          </a>
        ) : (
          label
        ),
      );
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'h'; level: number; text: string } | { kind: 'ul' | 'ol'; items: string[] };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'h', level: heading[1]!.length, text: heading[2]! });
    } else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      const c = current as Block | null;
      if (c?.kind !== kind) {
        flush();
        current = { kind, items: [] };
      }
      (current as unknown as { items: string[] }).items.push((bullet ?? numbered)![1]!);
    } else {
      const c = current as Block | null;
      if (c?.kind !== 'p') {
        flush();
        current = { kind: 'p', lines: [] };
      }
      (current as unknown as { lines: string[] }).lines.push(line.trim());
    }
  }
  flush();
  return blocks;
}

export function TextWidget({ widget }: WidgetProps<TextSpec>) {
  const { text, align } = widget.options;
  const content = useMemo(
    () =>
      parseBlocks(text).map((b, i) => {
        const key = `b${i}`;
        if (b.kind === 'h') {
          // Card titles are h3; text headings nest below them.
          const Tag = (['h4', 'h5', 'h6'] as const)[b.level - 1]!;
          return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
        }
        if (b.kind === 'p') return <p key={key}>{renderInline(b.lines.join(' '), key)}</p>;
        const List = b.kind;
        return (
          <List key={key}>
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item, `${key}.${j}.`)}</li>
            ))}
          </List>
        );
      }),
    [text],
  );
  return (
    <div className="bi-text" data-align={align}>
      {content}
    </div>
  );
}
