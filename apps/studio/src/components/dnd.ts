import type { DataSource } from '@yourorg/bi-spec';
import type { FieldInfo } from '../draft/types';

/** Drag payload for a field dragged out of the data panel. */
export const FIELD_MIME = 'application/x-bi-field';

export interface FieldDrag {
  field: FieldInfo;
  source: DataSource;
}

export function readFieldDrag(e: { dataTransfer: DataTransfer }): FieldDrag | null {
  const raw = e.dataTransfer.getData(FIELD_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FieldDrag;
  } catch {
    return null;
  }
}

export const isFieldDrag = (e: { dataTransfer: DataTransfer }) => Array.from(e.dataTransfer.types).includes(FIELD_MIME);
