import type { ReactNode } from 'react';

/** Small inline glyphs; stroke uses currentColor so they follow the text color. */
function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CalendarIcon = () => (
  <Svg>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </Svg>
);

/** Type badge for a field, by semantic type. */
export function FieldTypeIcon({ semanticType }: { semanticType: string }) {
  const map: Record<string, { label: string; text?: string }> = {
    numeric: { label: 'Number', text: '#' },
    categorical: { label: 'Category', text: 'Aa' },
    text: { label: 'Text', text: 'T' },
    boolean: { label: 'Boolean', text: '◐' },
    id: { label: 'Identifier', text: 'ID' },
    geo: { label: 'Geography', text: '⌖' },
  };
  if (semanticType === 'temporal') {
    return (
      <span className="field-icon" data-type="temporal" title="Date / time">
        <CalendarIcon />
      </span>
    );
  }
  const m = map[semanticType] ?? { label: semanticType, text: '·' };
  return (
    <span className="field-icon" data-type={semanticType} title={m.label}>
      {m.text}
    </span>
  );
}

/** Palette glyph per widget type; unknown (newer) types get a generic tile. */
export function WidgetTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'kpi':
      return (
        <Svg size={16}>
          <path d="M3 11.5h3M3 8.5h6" />
          <path d="M10.5 4.5h3v7h-3z" />
        </Svg>
      );
    case 'line-chart':
      return (
        <Svg size={16}>
          <path d="M2 12.5l3.5-4 3 2.5L14 4" />
        </Svg>
      );
    case 'bar-chart':
      return (
        <Svg size={16}>
          <path d="M3.5 13V8M8 13V4M12.5 13V6.5" />
        </Svg>
      );
    case 'table':
      return (
        <Svg size={16}>
          <rect x="2.5" y="3" width="11" height="10" rx="1" />
          <path d="M2.5 6.5h11M2.5 9.75h11M6.5 3v10" />
        </Svg>
      );
    default:
      return (
        <Svg size={16}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5.5 10.5l2-3 1.5 2 1.5-2" />
        </Svg>
      );
  }
}

export const GripIcon = () => (
  <Svg size={12}>
    <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth="2.2" />
  </Svg>
);
