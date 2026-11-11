import type { CartesianEncoding, Cell, PieEncoding, PivotEncoding, QueryResult, ResultColumn } from '@yourorg/bi-spec';
import { OTHER_COLOR, SERIES_COUNT, seriesColor } from '../styles';
import { column, yList } from './types';

/**
 * Pure reshaping of already-aggregated results into what charts draw. Nothing here groups raw
 * data: the one arithmetic step is folding the tail of a too-long series list into "Other",
 * which the palette rules require (a 9th series never gets a generated color).
 */

export const OTHER_LABEL = 'Other';
/** Key of the x value in reshaped rows; series values live under `s0`, `s1`, … */
export const X_KEY = '__x';

export interface SeriesDef {
  /** Safe dataKey (column names may contain dots, which chart libraries read as paths). */
  key: string;
  label: string;
  color: string;
  /** Result column the values come from (for formatting). */
  column?: ResultColumn;
  other?: boolean;
}

export interface CartesianData {
  rows: Array<Record<string, Cell>>;
  series: SeriesDef[];
  /** How many series were folded into "Other". */
  folded: number;
}

const label = (v: Cell | undefined) => (v === null || v === undefined || v === '' ? '(blank)' : String(v));
const byLabel = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function addCells(a: Cell | undefined, b: Cell | undefined): Cell {
  const na = typeof a === 'number' ? a : null;
  const nb = typeof b === 'number' ? b : null;
  return na === null ? nb : nb === null ? na : na + nb;
}

/**
 * Line / bar / area data. Without `series`, each y column is a series in the author's order.
 * With `series`, one y column is pivoted long → wide: a series per distinct value, colored by
 * the value's sorted position so a filter that drops one series never repaints the others.
 */
export function cartesianData(result: QueryResult, encoding: CartesianEncoding): CartesianData {
  const ys = yList(encoding.y);
  const { x } = encoding;
  if (!encoding.series) {
    const series = ys.slice(0, SERIES_COUNT).map<SeriesDef>((y, i) => ({ key: `s${i}`, label: y, color: seriesColor(i), column: column(result, y) }));
    const rows = result.rows.map((r) => {
      const out: Record<string, Cell> = { [X_KEY]: r[x] ?? null };
      ys.forEach((y, i) => (out[`s${i}`] = r[y] ?? null));
      return out;
    });
    return { rows, series, folded: 0 };
  }

  const y = ys[0]!;
  const seriesField = encoding.series;
  const yColumn = column(result, y);
  // Totals only decide which series survive a fold; they are never displayed.
  const totals = new Map<string, number>();
  for (const r of result.rows) {
    const name = label(r[seriesField]);
    const v = r[y];
    totals.set(name, (totals.get(name) ?? 0) + (typeof v === 'number' ? Math.abs(v) : 0));
  }
  let names = [...totals.keys()];
  let kept = new Set(names);
  let folded = 0;
  if (names.length > SERIES_COUNT) {
    names = [...names].sort((a, b) => totals.get(b)! - totals.get(a)! || byLabel(a, b)).slice(0, SERIES_COUNT - 1);
    kept = new Set(names);
    folded = totals.size - names.length;
  }
  names.sort(byLabel);
  const keyOf = new Map(names.map((n, i) => [n, `s${i}`]));
  const series: SeriesDef[] = names.map((n, i) => ({ key: `s${i}`, label: n, color: seriesColor(i), column: yColumn }));
  if (folded) series.push({ key: 'other', label: OTHER_LABEL, color: OTHER_COLOR, column: yColumn, other: true });

  // Rows keep the query's x order (it is already sorted by the data layer).
  const byX = new Map<string, Record<string, Cell>>();
  for (const r of result.rows) {
    const xv = r[x] ?? null;
    const xKey = JSON.stringify(xv);
    let row = byX.get(xKey);
    if (!row) {
      row = { [X_KEY]: xv };
      byX.set(xKey, row);
    }
    const name = label(r[seriesField]);
    const key = kept.has(name) ? keyOf.get(name)! : 'other';
    row[key] = key === 'other' ? addCells(row[key], r[y]) : (r[y] ?? null);
  }
  return { rows: [...byX.values()], series, folded };
}

export interface PieSlice {
  key: string;
  label: string;
  value: number;
  share: number;
  color: string;
  other?: boolean;
}

export interface PieData {
  slices: PieSlice[];
  total: number;
  /** Rows with a negative value: a pie can't show them, so the widget refuses to draw. */
  negative: number;
}

/** Largest first; beyond `maxSlices` the smallest fold into one "Other" slice (≤ maxSlices total). */
export function pieData(result: QueryResult, encoding: PieEncoding, maxSlices: number): PieData {
  const items: Array<{ label: string; value: number }> = [];
  let negative = 0;
  for (const r of result.rows) {
    const v = r[encoding.value];
    if (typeof v !== 'number' || v === 0) continue;
    if (v < 0) negative++;
    items.push({ label: label(r[encoding.category]), value: v });
  }
  items.sort((a, b) => b.value - a.value || byLabel(a.label, b.label));
  const cap = Math.max(2, Math.min(maxSlices, SERIES_COUNT));
  const head = items.length > cap ? items.slice(0, cap - 1) : items;
  const tail = items.length > cap ? items.slice(cap - 1) : [];
  const total = items.reduce((sum, i) => sum + i.value, 0);
  // Color by sorted name, so a category keeps its color as shares shift.
  const colorIndex = new Map([...head].map((i) => i.label).sort(byLabel).map((l, i) => [l, i]));
  const slices: PieSlice[] = head.map((i, n) => ({ key: `p${n}`, label: i.label, value: i.value, share: total ? i.value / total : 0, color: seriesColor(colorIndex.get(i.label)!) }));
  if (tail.length) {
    const value = tail.reduce((sum, i) => sum + i.value, 0);
    slices.push({ key: 'other', label: `${OTHER_LABEL} (${tail.length})`, value, share: total ? value / total : 0, color: OTHER_COLOR, other: true });
  }
  return { slices, total, negative };
}

export interface PivotData {
  rowValues: Cell[];
  columnValues: Cell[];
  /** Distinct column values not shown because of maxColumns. */
  hiddenColumns: number;
  /** Cells that appeared more than once (the first is shown; validation prevents this). */
  duplicates: number;
  cell(rowIndex: number, columnIndex: number): Cell;
}

function compareCells(a: Cell, b: Cell): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return byLabel(String(a), String(b));
}

/** Long → wide by lookup only: each (row, column) pair is one result row; nothing is summed. */
export function pivotData(result: QueryResult, encoding: PivotEncoding, order: 'data' | 'asc' | 'desc', maxColumns: number): PivotData {
  const rowIndex = new Map<string, number>();
  const colIndex = new Map<string, number>();
  const rowValues: Cell[] = [];
  let columnValues: Cell[] = [];
  const cells = new Map<string, Cell>();
  let duplicates = 0;
  for (const r of result.rows) {
    const rv = r[encoding.rows] ?? null;
    const cv = r[encoding.columns] ?? null;
    const rk = JSON.stringify(rv);
    const ck = JSON.stringify(cv);
    if (!rowIndex.has(rk)) rowIndex.set(rk, rowValues.push(rv) - 1);
    if (!colIndex.has(ck)) colIndex.set(ck, columnValues.push(cv) - 1);
    const key = `${rk}\u0000${ck}`;
    if (cells.has(key)) duplicates++;
    else cells.set(key, r[encoding.value] ?? null);
  }
  if (order !== 'data') {
    columnValues = [...columnValues].sort(compareCells);
    if (order === 'desc') columnValues.reverse();
  }
  const hiddenColumns = Math.max(0, columnValues.length - maxColumns);
  columnValues = columnValues.slice(0, maxColumns);
  const rowKeys = rowValues.map((v) => JSON.stringify(v));
  const colKeys = columnValues.map((v) => JSON.stringify(v));
  return {
    rowValues,
    columnValues,
    hiddenColumns,
    duplicates,
    cell: (ri, ci) => cells.get(`${rowKeys[ri]}\u0000${colKeys[ci]}`) ?? null,
  };
}
