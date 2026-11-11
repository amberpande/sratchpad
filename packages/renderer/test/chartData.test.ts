import type { QueryResult } from '@yourorg/bi-spec';
import { describe, expect, it } from 'vitest';
import { cartesianData, OTHER_LABEL, pieData, pivotData, X_KEY } from '../src/widgets/chartData';
import { resolveTableMode } from '../src/widgets/DataTable';
import { parseBlocks } from '../src/widgets/TextWidget';
import { formatAge } from '../src/format';

const long = (series: string[], months = 2): QueryResult => ({
  columns: [
    { name: 'month', type: 'time', grain: 'month' },
    { name: 'channel', type: 'string' },
    { name: 'revenue', type: 'number' },
  ],
  rows: Array.from({ length: months }, (_, m) => series.map((s, i) => ({ month: `2026-0${m + 1}-01`, channel: s, revenue: (i + 1) * 10 }))).flat(),
  truncated: false,
});

describe('cartesianData', () => {
  it('maps y columns to safe keys in the author’s order', () => {
    const r: QueryResult = { columns: [{ name: 'x', type: 'string' }, { name: 'a.b', type: 'number' }, { name: 'c', type: 'number' }], rows: [{ x: 'k', 'a.b': 1, c: 2 }], truncated: false };
    const d = cartesianData(r, { x: 'x', y: ['a.b', 'c'] });
    expect(d.series.map((s) => [s.key, s.label, s.color])).toEqual([
      ['s0', 'a.b', 'var(--bi-series-1)'],
      ['s1', 'c', 'var(--bi-series-2)'],
    ]);
    expect(d.rows).toEqual([{ [X_KEY]: 'k', s0: 1, s1: 2 }]);
  });

  it('pivots long → wide by the series column, colored by sorted value (stable under filters)', () => {
    const d = cartesianData(long(['Partner', 'Online', 'Direct']), { x: 'month', y: 'revenue', series: 'channel' });
    expect(d.series.map((s) => s.label)).toEqual(['Direct', 'Online', 'Partner']);
    expect(d.rows).toEqual([
      { [X_KEY]: '2026-01-01', s0: 30, s1: 20, s2: 10 },
      { [X_KEY]: '2026-02-01', s0: 30, s1: 20, s2: 10 },
    ]);
    // Dropping "Online" doesn't repaint the survivors' order relative to each other.
    const filtered = cartesianData(long(['Partner', 'Direct']), { x: 'month', y: 'revenue', series: 'channel' });
    expect(filtered.series.map((s) => s.label)).toEqual(['Direct', 'Partner']);
  });

  it('never cycles colors: beyond 8 series the smallest fold into a neutral "Other"', () => {
    const names = 'ABCDEFGHIJ'.split('');
    const d = cartesianData(long(names, 1), { x: 'month', y: 'revenue', series: 'channel' });
    expect(d.series).toHaveLength(8);
    expect(d.folded).toBe(3);
    const other = d.series[7]!;
    expect(other).toMatchObject({ label: OTHER_LABEL, color: 'var(--bi-series-other)', other: true });
    // A, B, C are the three smallest (10, 20, 30) → folded and summed
    expect(d.series.slice(0, 7).map((s) => s.label)).toEqual(['D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(d.rows[0]![other.key]).toBe(60);
    expect(new Set(d.series.map((s) => s.color)).size).toBe(8);
  });
});

describe('pieData', () => {
  const r: QueryResult = {
    columns: [{ name: 'cat', type: 'string' }, { name: 'v', type: 'number' }],
    rows: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((cat, i) => ({ cat, v: i + 1 })),
    truncated: false,
  };
  it('caps at maxSlices including "Other", largest first, with shares', () => {
    const d = pieData(r, { category: 'cat', value: 'v' }, 6);
    expect(d.slices.map((s) => s.label)).toEqual(['h', 'g', 'f', 'e', 'd', 'Other (3)']);
    expect(d.slices[5]!.value).toBe(6);
    expect(d.total).toBe(36);
    expect(d.slices.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1);
  });
  it('flags negative values', () => {
    expect(pieData({ ...r, rows: [{ cat: 'a', v: -1 }, { cat: 'b', v: 3 }] }, { category: 'cat', value: 'v' }, 6).negative).toBe(1);
  });
});

describe('pivotData', () => {
  const r: QueryResult = {
    columns: [{ name: 'region', type: 'string' }, { name: 'cat', type: 'string' }, { name: 'rev', type: 'number' }],
    rows: [
      { region: 'EU', cat: 'Software', rev: 1 },
      { region: 'EU', cat: 'Hardware', rev: 2 },
      { region: 'NA', cat: 'Software', rev: 3 },
    ],
    truncated: false,
  };
  it('reshapes by lookup only; missing cells are null', () => {
    const p = pivotData(r, { rows: 'region', columns: 'cat', value: 'rev' }, 'asc', 50);
    expect(p.rowValues).toEqual(['EU', 'NA']);
    expect(p.columnValues).toEqual(['Hardware', 'Software']);
    expect([p.cell(0, 0), p.cell(0, 1), p.cell(1, 0), p.cell(1, 1)]).toEqual([2, 1, null, 3]);
    expect(p.duplicates).toBe(0);
  });
  it('caps columns without folding them', () => {
    const p = pivotData(r, { rows: 'region', columns: 'cat', value: 'rev' }, 'data', 1);
    expect(p.columnValues).toEqual(['Software']);
    expect(p.hiddenColumns).toBe(1);
  });
});

describe('table mode', () => {
  it('pages short results, virtualizes long ones', () => {
    expect(resolveTableMode('auto', 40, 50)).toBe('plain');
    expect(resolveTableMode('auto', 300, 50)).toBe('pages');
    expect(resolveTableMode('auto', 10_000, 50)).toBe('virtual');
    expect(resolveTableMode('pages', 10_000, 50)).toBe('pages');
    expect(resolveTableMode('scroll', 80, 50)).toBe('plain');
    expect(resolveTableMode('scroll', 10_000, 50)).toBe('virtual');
  });
});

describe('markdown-lite', () => {
  it('parses headings, paragraphs and lists', () => {
    expect(parseBlocks('# Title\nline one\nline two\n\n- a\n- b\n1. x')).toEqual([
      { kind: 'h', level: 1, text: 'Title' },
      { kind: 'p', lines: ['line one', 'line two'] },
      { kind: 'ul', items: ['a', 'b'] },
      { kind: 'ol', items: ['x'] },
    ]);
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  it('reads as a freshness hint', () => {
    expect(formatAge('2026-11-09T11:59:50Z', now)).toBe('just now');
    expect(formatAge('2026-11-09T11:57:00Z', now)).toBe('3 min ago');
    expect(formatAge('2026-11-09T09:00:00Z', now)).toBe('3 h ago');
    expect(formatAge('nope', now)).toBeNull();
  });
});
