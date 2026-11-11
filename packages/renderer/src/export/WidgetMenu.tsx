import type { QueryResult, RenderableWidget } from '@yourorg/bi-spec';
import { useEffect, useRef, useState } from 'react';
import { downloadBlob, resultToCsv, safeFileName, svgToPng } from './download';

/**
 * Platform UI in the renderer (workstream D): a per-widget actions menu (download CSV / PNG) and a
 * dashboard toolbar (print / save as PDF through the browser's print dialog and a print stylesheet).
 */

export function WidgetMenu({ widgetId, widget, result, title }: { widgetId: string; widget: RenderableWidget; result?: QueryResult; title?: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const known = widget.type !== '__unsupported__';
  const hasData = Boolean(result && result.columns.length);
  const name = title || widgetId || 'widget';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!known || widget.type === 'text' || !hasData) return null;

  const chartSvg = (): SVGSVGElement | null => (ref.current?.closest('.bi-card')?.querySelector('.bi-card-body svg.recharts-surface, .bi-card-body svg[data-bi-chart]') as SVGSVGElement | null) ?? null;

  const csv = () => {
    downloadBlob(new Blob([resultToCsv(result!)], { type: 'text/csv;charset=utf-8' }), safeFileName(name, 'csv'));
    setOpen(false);
  };
  const png = async () => {
    setError(null);
    const svg = chartSvg();
    const card = ref.current?.closest('.bi-card') as HTMLElement | null;
    try {
      if (!svg) throw new Error('Switch back to the chart view to export an image.');
      const bg = card ? getComputedStyle(card).backgroundColor : '#ffffff';
      downloadBlob(await svgToPng(svg, bg), safeFileName(name, 'png'));
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="bi-menu" ref={ref}>
      <button type="button" className="bi-toggle bi-menu-button" aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${name}`} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="bi-menu-list" role="menu">
          <button type="button" role="menuitem" onClick={csv}>
            Download CSV
          </button>
          <button type="button" role="menuitem" onClick={() => void png()}>
            Download PNG
          </button>
          {error && (
            <p className="bi-menu-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function DashboardToolbar({ dashboardId }: { dashboardId: string; title: string; version: number }) {
  return (
    <div className="bi-toolbar" data-dashboard-id={dashboardId}>
      <button type="button" className="bi-toggle" onClick={() => window.print()} title="Print or save as PDF (choose “Save as PDF” in the print dialog)">
        Print / PDF
      </button>
    </div>
  );
}

/** Menu styling and the print stylesheet: actions hidden, cards kept whole, colors printed. */
export const PLATFORM_CSS = `
.bi-menu{position:relative;flex:none}
.bi-menu-button{padding:0 6px;letter-spacing:1px}
.bi-menu-list{position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:150px;background:var(--bi-surface);border:1px solid var(--bi-border);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.12);padding:4px;display:flex;flex-direction:column}
.bi-menu-list button{font:inherit;font-size:12px;text-align:left;color:var(--bi-text);background:transparent;border:0;border-radius:6px;padding:6px 8px;cursor:pointer}
.bi-menu-list button:hover,.bi-menu-list button:focus-visible{background:var(--bi-hover)}
.bi-menu-error{margin:4px 8px;font-size:11px;color:var(--bi-critical)}
.bi-toolbar{display:flex;gap:6px;flex:none}
@media print{
.bi-root{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bi-toolbar,.bi-menu,.bi-toggle{display:none!important}
.bi-card{break-inside:avoid;page-break-inside:avoid}
}
`;
