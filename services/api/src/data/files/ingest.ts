import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import ExcelJS from 'exceljs';
import type { DuckDBRuntime } from '../duckdb/runtime';
import { quoteLiteral } from '../sql/dialect';

/**
 * Upload → columnar copy. The upload is validated, parsed exactly once by DuckDB's CSV reader
 * (Excel is first flattened to CSV so both formats share one type-inference path) and written as
 * Parquet. Queries only ever read the Parquet copy; the original bytes are deleted.
 */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export type UploadFormat = 'csv' | 'xlsx';

/** A user-facing upload problem (bad type, bad content). The route maps it to 4xx. */
export class UploadError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A display-safe file name: no directories, no control characters, bounded length. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return clean && clean !== '.' && clean !== '..' ? clean : 'upload';
}

/** Checks extension AND content, so a renamed binary cannot pass as a CSV. */
export function detectFormat(fileName: string, bytes: Uint8Array): UploadFormat {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.xlsx') {
    // XLSX is a ZIP container: local file header "PK\x03\x04".
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new UploadError(415, 'invalid_file_content', 'The file has an .xlsx extension but is not an Excel workbook.');
    }
    return 'xlsx';
  }
  if (ext === '.csv') {
    const head = bytes.subarray(0, 64 * 1024);
    if (head.includes(0)) throw new UploadError(415, 'invalid_file_content', 'The file has a .csv extension but contains binary data.');
    try {
      // stream: true tolerates a multi-byte character cut at the 64 KB boundary.
      new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    } catch {
      throw new UploadError(415, 'invalid_file_content', 'CSV files must be UTF-8 text.');
    }
    if (!new TextDecoder().decode(head).trim()) throw new UploadError(422, 'empty_file', 'The CSV file is empty.');
    return 'csv';
  }
  throw new UploadError(415, 'unsupported_file_type', 'Only .csv and .xlsx files can be uploaded.');
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function excelCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Excel dates carry no zone; exceljs exposes them as UTC. Midnight means "a date".
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    if (!value.getUTCHours() && !value.getUTCMinutes() && !value.getUTCSeconds()) return date;
    return `${date} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('formula' in value || 'sharedFormula' in value) return excelCellText((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
  if ('text' in value) return String((value as ExcelJS.CellHyperlinkValue).text);
  return ''; // errors (#DIV/0!) and anything exotic become NULL
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** First non-empty worksheet → CSV text. Row 1 is the header. */
export async function xlsxToCsv(bytes: Uint8Array): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as never);
  } catch {
    throw new UploadError(422, 'unreadable_file', 'The Excel workbook could not be read.');
  }
  const sheet = workbook.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) throw new UploadError(422, 'empty_file', 'The workbook has no data.');
  const width = sheet.getRow(1).cellCount;
  if (!width) throw new UploadError(422, 'empty_file', 'The first row of the sheet must hold column names.');
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(csvField(excelCellText(row.getCell(c).value)));
    lines.push(cells.join(','));
  });
  return `${lines.join('\n')}\n`;
}

export interface IngestResult {
  rowCount: number;
}

/**
 * Writes `<dataDir>/files/<id>.parquet` from the upload. Paths are built from the server-generated
 * id only, so user input never reaches the filesystem or the SQL text.
 */
export async function ingestUpload(
  runtime: DuckDBRuntime,
  { id, format, bytes, dataDir }: { id: string; format: UploadFormat; bytes: Uint8Array; dataDir: string },
): Promise<IngestResult> {
  const tmpDir = join(dataDir, 'tmp');
  const filesDir = join(dataDir, 'files');
  await Promise.all([mkdir(tmpDir, { recursive: true }), mkdir(filesDir, { recursive: true })]);
  const csvPath = join(tmpDir, `${id}.csv`);
  const partial = join(tmpDir, `${id}.parquet`);
  const target = join(filesDir, `${id}.parquet`);
  try {
    await writeFile(csvPath, format === 'xlsx' ? await xlsxToCsv(bytes) : bytes);
    try {
      // header=true: auto-detection mistakes an all-text file's header for data.
      // sample_size=-1: infer types from every row, so a late "N/A" can't fail the load.
      await runtime.query(
        `COPY (SELECT * FROM read_csv(${quoteLiteral(csvPath)}, header = true, auto_detect = true, sample_size = -1))
         TO ${quoteLiteral(partial)} (FORMAT parquet, COMPRESSION zstd)`,
      );
    } catch (error) {
      throw new UploadError(422, 'unreadable_file', `The file could not be parsed as a table: ${firstLine(error)}`);
    }
    const [row] = await runtime.query(`SELECT count(*) AS n FROM read_parquet(?)`, [partial]);
    await rename(partial, target);
    return { rowCount: Number(row?.n ?? 0) };
  } finally {
    await Promise.all([rm(csvPath, { force: true }), rm(partial, { force: true })]);
  }
}

/**
 * Writes the typed rows of a Parquet copy as a normalized CSV for loading elsewhere: header row,
 * RFC 4180 quoting ("" inside quoted fields), NULL as an empty unquoted field, ISO dates and
 * timestamps (microseconds), booleans as true/false.
 */
export async function exportCsv(runtime: DuckDBRuntime, parquetPath: string, csvPath: string): Promise<void> {
  await runtime.query(
    `COPY (SELECT * FROM read_parquet(${quoteLiteral(parquetPath)}))
     TO ${quoteLiteral(csvPath)} (FORMAT csv, HEADER true, DELIMITER ',', QUOTE '"', ESCAPE '"',
       DATEFORMAT '%Y-%m-%d', TIMESTAMPFORMAT '%Y-%m-%d %H:%M:%S.%f')`,
  );
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // DuckDB messages can include local paths; keep only the first line and strip paths.
  return message.split('\n')[0]!.replace(/(['"])?\/[^\s'"]+\1?/g, '<file>').slice(0, 300);
}
