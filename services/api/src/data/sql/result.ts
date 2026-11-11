import type { Cell, QueryResult } from '@yourorg/bi-spec';
import type { CompiledQuery } from './compile';

/**
 * Turns driver rows into the wire result. Drivers return wide integers and decimals as strings or
 * bigints (DuckDB BIGINT/HUGEINT, Snowflake NUMBER); the wire carries plain JSON numbers.
 */
export function toQueryResult(compiled: CompiledQuery, raw: ReadonlyArray<Record<string, unknown>>): QueryResult {
  const truncated = raw.length > compiled.limit;
  const rows = (truncated ? raw.slice(0, compiled.limit) : raw).map((r) => {
    const row: Record<string, Cell> = {};
    for (const col of compiled.columns) row[col.name] = toCell(r[col.name], col.type);
    return row;
  });
  return { columns: compiled.columns, rows, truncated };
}

export function toCell(value: unknown, type: 'string' | 'number' | 'time' | 'boolean'): Cell {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true' || value === 1 || value === '1';
    default:
      return typeof value === 'string' ? value : String(value);
  }
}
