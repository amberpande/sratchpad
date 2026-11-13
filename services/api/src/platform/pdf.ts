import type { QueryResult } from '@yourorg/bi-spec';

/**
 * A small PDF report for subscription emails (D-096): the dashboard title, KPI values and each attached
 * widget's data as a table. Text only, built-in PDF fonts (Helvetica, Courier), no dependencies and no
 * headless browser, so it runs in the API container as is. Charts are not drawn; the email links to them.
 */

export interface PdfSection {
  title: string;
  result: QueryResult;
}

const PAGE_W = 595; // A4 in points
const PAGE_H = 842;
const MARGIN = 48;
const MAX_ROWS = 200;

/** PDF string literal in WinAnsi: escapes \ ( ) and replaces characters outside Latin-1 with "?". */
/** Characters WinAnsi (Windows-1252) places above Latin-1's control range. */
const WIN_ANSI: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

function pdfText(s: string): string {
  const latin = [...s].map((ch) => (WIN_ANSI[ch] !== undefined ? String.fromCharCode(WIN_ANSI[ch]!) : ch.charCodeAt(0) < 256 ? ch : '?')).join('');
  return `(${latin.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[\r\n\t]/g, ' ')})`;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return String(v);
}

type Line = { font: 'F1' | 'F2' | 'F3'; size: number; text: string; gap?: number };

export function renderPdf(title: string, kpis: Array<{ label: string; value: string }>, sections: PdfSection[], generatedAt: Date): Uint8Array {
  const lines: Line[] = [{ font: 'F2', size: 18, text: title, gap: 10 }, { font: 'F1', size: 9, text: `Generated ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, gap: 14 }];
  for (const k of kpis) lines.push({ font: 'F1', size: 12, text: `${k.label}: ${k.value}` });
  if (kpis.length) lines.push({ font: 'F1', size: 6, text: '', gap: 8 });
  for (const sec of sections) {
    lines.push({ font: 'F2', size: 13, text: sec.title, gap: 4 });
    const cols = sec.result.columns.map((c) => c.name);
    const rows = sec.result.rows.slice(0, MAX_ROWS).map((r) => cols.map((c) => cellText(r[c])));
    // Monospaced columns sized to content, capped so a row fits the page width (Courier 8pt ≈ 4.8pt/char).
    const maxChars = Math.floor((PAGE_W - 2 * MARGIN) / 4.8);
    const widths = cols.map((c, i) => Math.min(28, Math.max(c.length, ...rows.map((r) => r[i]!.length))));
    while (widths.reduce((a, b) => a + b + 2, 0) > maxChars && Math.max(...widths) > 6) widths[widths.indexOf(Math.max(...widths))]! -= 1;
    const fmt = (cells: string[]) => cells.map((c, i) => (c.length > widths[i]! ? `${c.slice(0, widths[i]! - 1)}~` : c.padEnd(widths[i]!))).join('  ');
    lines.push({ font: 'F3', size: 8, text: fmt(cols) });
    lines.push({ font: 'F3', size: 8, text: widths.map((w) => '-'.repeat(w)).join('  ') });
    for (const r of rows) lines.push({ font: 'F3', size: 8, text: fmt(r) });
    if (sec.result.rows.length > MAX_ROWS || sec.result.truncated) lines.push({ font: 'F1', size: 8, text: `Showing ${Math.min(MAX_ROWS, sec.result.rows.length)} rows; the CSV attachment and the dashboard have the rest.` });
    lines.push({ font: 'F1', size: 6, text: '', gap: 10 });
  }

  // Lay out into pages.
  const pages: string[] = [];
  let y = PAGE_H - MARGIN;
  let ops: string[] = [];
  const flush = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  for (const l of lines) {
    const height = l.size * 1.3 + (l.gap ?? 0);
    if (y - height < MARGIN) flush();
    y -= l.size * 1.3;
    if (l.text) ops.push(`BT /${l.font} ${l.size} Tf ${MARGIN} ${y.toFixed(1)} Td ${pdfText(l.text)} Tj ET`);
    y -= l.gap ?? 0;
  }
  if (ops.length || !pages.length) flush();

  // Objects: 1 catalog, 2 pages, 3–5 fonts, then per page: page + content.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  pages.forEach((content, i) => {
    const id = pageIds[i]!;
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
