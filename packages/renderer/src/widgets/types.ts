import type { QueryResult, ResultColumn } from '@yourorg/bi-spec';
import type { FormatContext } from '../format';

export interface WidgetProps<W> {
  widget: W;
  result: QueryResult;
  format: FormatContext;
}

export function column(result: QueryResult, name: string): ResultColumn | undefined {
  return result.columns.find((c) => c.name === name);
}

export const yList = (y: string | string[]) => (Array.isArray(y) ? y : [y]);
