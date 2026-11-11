import type { Cell, QueryResult } from '@yourorg/bi-spec';

/**
 * Client-side exports (workstream D): CSV from a widget's result and PNG from its chart. Both work on
 * data already in the browser, so they need no server round trip and respect exactly what the viewer
 * was allowed to see.
 */

/** RFC 4180 CSV. Text that a spreadsheet would run as a formula is prefixed with "'". */
export function resultToCsv(result: QueryResult): string {
  const cols = result.columns.map((c) => c.name);
  const cell = (v: Cell | undefined): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell), ...result.rows.map((r) => cols.map((c) => cell(r[c])))].map((l) => l.join(',')).join('\r\n') + '\r\n';
}

export function safeFileName(name: string, ext: string): string {
  const base = name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'export';
  return `${base}.${ext}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'visibility', 'display'];

/**
 * A standalone copy of a rendered chart SVG: every element's computed presentation styles are inlined,
 * because the live chart's colors come from CSS custom properties that a detached image cannot see.
 */
export function standaloneSvg(svg: SVGSVGElement): { markup: string; width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || Number(svg.getAttribute('width')) || 600));
  const height = Math.max(1, Math.round(rect.height || Number(svg.getAttribute('height')) || 300));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const target = dst[i] as SVGElement | undefined;
    if (!target) return;
    const cs = getComputedStyle(el);
    const inline = STYLE_PROPS.map((p) => [p, cs.getPropertyValue(p)] as const)
      .filter(([, v]) => v && !v.includes('var('))
      .map(([p, v]) => `${p}:${v}`)
      .join(';');
    if (inline) target.setAttribute('style', inline);
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

/** Renders a chart SVG to a PNG (2x for sharpness) on the given background color. */
export async function svgToPng(svg: SVGSVGElement, background: string): Promise<Blob> {
  const { markup, width, height } = standaloneSvg(svg);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The chart could not be converted to an image.'));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot export images.');
    ctx.fillStyle = background || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image export failed.'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
