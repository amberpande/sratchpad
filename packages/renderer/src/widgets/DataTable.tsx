import type { Cell } from '@yourorg/bi-spec';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * The one table primitive: table widgets, pivots and every chart's "View as table" use it.
 * Short results page (or show plainly); long ones render only the rows in view, so a
 * 10,000-row result costs the same as a 30-row one.
 */

export interface DataColumn {
  key: string;
  label: string;
  align: 'left' | 'right';
  text(row: Record<string, Cell>): string;
  /** Render this column's cells as row headers (pivot row labels). */
  rowHeader?: boolean;
  /** Spec 1.3: per-cell style (conditional formatting, as CSS custom properties). */
  cellStyle?(row: Record<string, Cell>): CSSProperties | undefined;
  /** Spec 1.3: custom cell content (e.g. a sparkline); `text` stays the accessible value. */
  render?(row: Record<string, Cell>): ReactNode;
  /** Value to sort by (default: row[key]). */
  sortValue?(row: Record<string, Cell>): Cell;
  /** False to make this column unsortable (e.g. sparklines). */
  sortable?: boolean;
}

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;

/** Client-side sort of already-aggregated rows: numbers numerically, text naturally, blanks last. */
export function sortRows(rows: Array<Record<string, Cell>>, column: DataColumn | undefined, dir: 'asc' | 'desc'): Array<Record<string, Cell>> {
  if (!column) return rows;
  const value = column.sortValue ?? ((r: Record<string, Cell>) => r[column.key] ?? null);
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * sign;
  });
}

export type TableMode = 'auto' | 'pages' | 'scroll';

/** Fixed row height for virtualization (6px padding × 2 + 13px × 1.4 line + 1px border). */
export const ROW_HEIGHT = 31;
/** "scroll" stops rendering every row above this; below it a plain table is cheaper. */
export const VIRTUALIZE_ABOVE = 100;
/** "auto" pages results up to this many pages and virtualizes anything longer. */
export const AUTO_MAX_PAGES = 10;

export function resolveTableMode(mode: TableMode, rows: number, pageSize: number): 'plain' | 'pages' | 'virtual' {
  if (mode === 'pages') return rows > pageSize ? 'pages' : 'plain';
  if (mode === 'scroll') return rows > VIRTUALIZE_ABOVE ? 'virtual' : 'plain';
  if (rows <= pageSize) return 'plain';
  return rows <= pageSize * AUTO_MAX_PAGES ? 'pages' : 'virtual';
}

interface DataTableProps {
  columns: DataColumn[];
  rows: Array<Record<string, Cell>>;
  /** Accessible name for the table and its scroll region. */
  label: string;
  mode?: TableMode;
  pageSize?: number;
  truncated?: boolean;
  /** Extra line under the table (e.g. "3 more columns not shown"). */
  note?: ReactNode;
  /** Spec 1.3: click a header to sort. */
  sortable?: boolean;
  /** Spec 1.3: row click (interactions); rows get a pointer when set. */
  onRowClick?(row: Record<string, Cell>, event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): void;
  /** Spec 1.3: per-row opacity (selection de-emphasis). */
  rowOpacity?(row: Record<string, Cell>): number;
}

interface RowOptions {
  onRowClick?: DataTableProps['onRowClick'];
  rowOpacity?: DataTableProps['rowOpacity'];
}

function Head({ columns, sortable, sort, onSort }: { columns: DataColumn[]; sortable?: boolean; sort: SortState; onSort(key: string): void }) {
  return (
    <thead>
      <tr aria-rowindex={1}>
        {columns.map((c) => {
          const active = sort?.key === c.key;
          const can = sortable && c.sortable !== false;
          return (
            <th key={c.key} data-align={c.align} scope="col" aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              {can ? (
                <button type="button" className="bi-sort" onClick={() => onSort(c.key)} title={`Sort by ${c.label}`}>
                  {c.label}
                  <span aria-hidden="true">{active ? (sort!.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                </button>
              ) : (
                c.label
              )}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

function Row({ row, columns, index, virtual, opts }: { row: Record<string, Cell>; columns: DataColumn[]; index: number; virtual?: boolean; opts?: RowOptions }) {
  const opacity = opts?.rowOpacity?.(row);
  return (
    <tr
      aria-rowindex={index + 2}
      data-virtual={virtual || undefined}
      data-clickable={opts?.onRowClick ? '' : undefined}
      onClick={opts?.onRowClick ? (e) => opts.onRowClick!(row, e) : undefined}
      style={opacity !== undefined && opacity < 1 ? { opacity } : undefined}
    >
      {columns.map((c) => {
        const style = c.cellStyle?.(row);
        const content = c.render ? c.render(row) : c.text(row);
        return c.rowHeader ? (
          <th key={c.key} scope="row" data-align={c.align} data-cf={style ? '' : undefined} style={style}>
            {content}
          </th>
        ) : (
          <td key={c.key} data-align={c.align} data-cf={style ? '' : undefined} style={style}>
            {content}
          </td>
        );
      })}
    </tr>
  );
}

/** Rows to render when the scroll area has no measurable height yet (hidden tab, print, tests). */
const UNMEASURED_ROWS = 20;

function VirtualBody({ rows, columns, scrollElement, opts }: { rows: DataTableProps['rows']; columns: DataColumn[]; scrollElement: HTMLDivElement; opts?: RowOptions }) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // An unmeasured container would otherwise render zero rows; show a first window instead.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : { width: rect.width, height: ROW_HEIGHT * UNMEASURED_ROWS })),
  });
  const items = virtualizer.getVirtualItems();
  const top = items[0]?.start ?? 0;
  const bottom = virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0);
  // Spacer rows keep this a real <table> (column widths, sticky header, row semantics) while
  // only the visible slice exists in the DOM.
  return (
    <tbody>
      {top > 0 && <tr aria-hidden="true" style={{ height: top }} />}
      {items.map((item) => (
        <Row key={item.key} row={rows[item.index]!} columns={columns} index={item.index} virtual opts={opts} />
      ))}
      {bottom > 0 && <tr aria-hidden="true" style={{ height: bottom }} />}
    </tbody>
  );
}

export function DataTable({ columns, rows: inputRows, label, mode = 'auto', pageSize = 50, truncated = false, note, sortable, onRowClick, rowOpacity }: DataTableProps) {
  const [sort, setSort] = useState<SortState>(null);
  const rows = useMemo(() => (sort ? sortRows(inputRows, columns.find((c) => c.key === sort.key), sort.dir) : inputRows), [inputRows, columns, sort]);
  // asc → desc → original order
  const onSort = (key: string) => setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const opts: RowOptions | undefined = onRowClick || rowOpacity ? { onRowClick, rowOpacity } : undefined;
  // State, not a ref: a child's layout effect runs before the parent's ref is attached, so the
  // virtualizer would first see null and never measure. Rendering it once the element exists fixes that.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const layout = resolveTableMode(mode, rows.length, pageSize);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => {
    setPage(0);
  }, [rows]);
  const visible = layout === 'pages' ? rows.slice(page * pageSize, (page + 1) * pageSize) : rows;
  const offset = layout === 'pages' ? page * pageSize : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Focusable so keyboard users can scroll it (arrows, Page Up/Down, Home/End). */}
      <div className="bi-table-wrap" ref={setScrollElement} tabIndex={0} role="region" aria-label={`${label} (scrollable)`}>
        <table className="bi-table" aria-label={label} aria-rowcount={rows.length + 1}>
          <Head columns={columns} sortable={sortable} sort={sort} onSort={onSort} />
          {layout === 'virtual' ? (
            scrollElement && <VirtualBody rows={rows} columns={columns} scrollElement={scrollElement} opts={opts} />
          ) : (
            <tbody>
              {visible.map((row, i) => (
                <Row key={offset + i} row={row} columns={columns} index={offset + i} opts={opts} />
              ))}
            </tbody>
          )}
        </table>
      </div>
      {layout === 'pages' ? (
        <div className="bi-pager">
          <span>
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, rows.length)} of {rows.length}
            {truncated ? '+' : ''}
          </span>
          <button type="button" onClick={() => setPage((p) => p - 1)} disabled={page === 0} aria-label="Previous page">
            ‹
          </button>
          <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page >= pages - 1} aria-label="Next page">
            ›
          </button>
        </div>
      ) : (
        (truncated || layout === 'virtual') && (
          <div className="bi-pager">
            <span>
              {rows.length.toLocaleString()}
              {truncated ? '+' : ''} rows
            </span>
          </div>
        )
      )}
      {note && <div className="bi-table-note">{note}</div>}
    </div>
  );
}
