/**
 * The SDK's only stylesheet, injected once. Everything is scoped under .bi-root and themed
 * through --bi-* custom properties, so a host app can restyle without fighting our CSS.
 * Series colors follow a fixed, CVD-validated categorical order (never cycled).
 */

const LIGHT: Record<string, string> = {
  '--bi-surface': '#fcfcfb',
  '--bi-border': '#e4e3df',
  '--bi-text': '#0b0b0b',
  '--bi-text-2': '#52514e',
  '--bi-text-3': '#75746f',
  '--bi-grid': '#ebeae6',
  '--bi-skeleton': '#efeeea',
  '--bi-hover': 'rgba(11, 11, 11, 0.04)',
  '--bi-critical': '#d03b3b',
  '--bi-series-1': '#2a78d6',
  '--bi-series-2': '#eb6834',
  '--bi-series-3': '#1baf7a',
  '--bi-series-4': '#eda100',
  '--bi-series-5': '#e87ba4',
  '--bi-series-6': '#008300',
  '--bi-series-7': '#6250d6',
  '--bi-series-8': '#e34948',
  // "Other" (folded series / slices) is neutral on purpose: it is a remainder, not an entity.
  '--bi-series-other': '#a3a29c',
};

const DARK: Record<string, string> = {
  '--bi-surface': '#1a1a19',
  '--bi-border': '#33332f',
  '--bi-text': '#f0efec',
  '--bi-text-2': '#c3c2b7',
  '--bi-text-3': '#9a998f',
  '--bi-grid': '#2c2c29',
  '--bi-skeleton': '#262624',
  '--bi-hover': 'rgba(240, 239, 236, 0.06)',
  '--bi-critical': '#e66767',
  '--bi-series-1': '#3987e5',
  '--bi-series-2': '#d95926',
  '--bi-series-3': '#199e70',
  '--bi-series-4': '#c98500',
  '--bi-series-5': '#d55181',
  '--bi-series-6': '#008300',
  '--bi-series-7': '#9085e9',
  '--bi-series-8': '#e66767',
  '--bi-series-other': '#6b6a64',
};

export const SERIES_COUNT = 8;
export const OTHER_COLOR = 'var(--bi-series-other)';
/** Never cycles: anything past the 8th slot is folded into "Other" upstream, and gets its neutral. */
export const seriesColor = (i: number) => (i >= 0 && i < SERIES_COUNT ? `var(--bi-series-${i + 1})` : OTHER_COLOR);

import { INTERACTION_CSS } from './interactions-ui';
import { PLATFORM_CSS } from './export/WidgetMenu';
import { VIZ_CSS } from './widgets/viz.css';

const vars = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}:${v};`).join('');

const BASE_CSS = `
.bi-root{${vars(LIGHT)}color-scheme:light;font-family:var(--bi-font,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);color:var(--bi-text);font-size:14px;line-height:1.4;container-type:inline-size}
.bi-root[data-bi-theme="dark"]{${vars(DARK)}color-scheme:dark}
@media (prefers-color-scheme:dark){.bi-root[data-bi-theme="auto"]{${vars(DARK)}color-scheme:dark}}
.bi-root *{box-sizing:border-box}
.bi-root[data-bi-page]{background:var(--bi-page);padding:16px;border-radius:var(--bi-radius,10px)}
.bi-root[data-bi-card="flat"] .bi-card{border-color:transparent}
.bi-root[data-bi-card="elevated"] .bi-card{border-color:transparent;box-shadow:0 1px 2px rgba(0,0,0,.06),0 4px 14px rgba(0,0,0,.08)}
.bi-root[data-bi-density="compact"] .bi-card{padding:10px 12px}
.bi-root[data-bi-density="compact"] .bi-card-head{margin-bottom:4px}
.bi-card[data-bi-emphasis]{box-shadow:inset 3px 0 0 var(--bi-accent,var(--bi-series-1))}
.bi-card[data-bi-title-align="center"] .bi-card-title{text-align:center}
.bi-axis-label{fill:var(--bi-text-3);font-size:11px}
.bi-data-label{fill:var(--bi-text-2);font-size:11px;font-variant-numeric:tabular-nums}
.bi-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 16px}
.bi-header .bi-fresh{font-size:12px}
.bi-title{font-size:18px;font-weight:600;margin:0;letter-spacing:-0.01em}
.bi-desc{margin:4px 0 0;color:var(--bi-text-2);font-size:13px}
.bi-grid{display:grid;gap:16px}
.bi-card{flex:1 1 auto;width:100%;background:var(--bi-surface);border:1px solid var(--bi-border);border-radius:var(--bi-radius,10px);padding:14px 16px;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.bi-card{position:relative}
.bi-card-head{display:flex;align-items:center;gap:8px;min-height:22px;margin:0 0 8px}
.bi-card-title{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;color:var(--bi-text-2);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bi-fresh{flex:none;font-size:11px;color:var(--bi-text-3);white-space:nowrap;font-variant-numeric:tabular-nums}
.bi-fresh[data-floating]{position:absolute;top:8px;right:12px}
.bi-toggle{flex:none;font:inherit;font-size:11px;line-height:18px;color:var(--bi-text-2);background:transparent;border:1px solid var(--bi-border);border-radius:6px;padding:0 7px;cursor:pointer}
.bi-toggle:hover{background:var(--bi-hover)}
.bi-toggle[aria-pressed="true"]{color:var(--bi-text);background:var(--bi-hover);border-color:var(--bi-text-3)}
.bi-root :focus-visible{outline:2px solid var(--bi-accent,var(--bi-series-1));outline-offset:1px}
.bi-card-body{flex:1;min-height:0;position:relative}
.bi-kpi{display:flex;flex-direction:column;justify-content:center;height:100%}
.bi-kpi-value{font-size:30px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bi-kpi-label{color:var(--bi-text-2);font-size:13px;margin-top:6px}
.bi-skeleton{background:var(--bi-skeleton);border-radius:6px;animation:bi-pulse 1.4s ease-in-out infinite}
@keyframes bi-pulse{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.bi-skeleton{animation:none}}
.bi-message{display:flex;flex-direction:column;justify-content:center;gap:4px;height:100%;font-size:13px;color:var(--bi-text-2)}
.bi-message strong{color:var(--bi-text);font-weight:600}
.bi-message[data-tone="error"] strong{color:var(--bi-critical)}
.bi-banner{border:1px solid var(--bi-border);background:var(--bi-surface);border-radius:8px;padding:8px 12px;margin:0 0 12px;font-size:13px;color:var(--bi-text-2)}
.bi-table-wrap{flex:1;min-height:0;height:100%;overflow:auto}
.bi-table tr[data-virtual] td{height:31px;overflow:hidden;text-overflow:ellipsis}
.bi-table th[scope="row"]{position:static;font-weight:600;color:var(--bi-text);border-bottom:1px solid var(--bi-grid)}
.bi-table-note{font-size:12px;color:var(--bi-text-3);padding-top:6px}
.bi-text{height:100%;overflow:auto;color:var(--bi-text);font-size:14px;line-height:1.5}
.bi-text>:first-child{margin-top:0}
.bi-text p,.bi-text ul,.bi-text ol{margin:0 0 8px}
.bi-text ul,.bi-text ol{padding-left:20px}
.bi-text h4{font-size:15px;margin:0 0 6px}.bi-text h5{font-size:14px;margin:0 0 6px}.bi-text h6{font-size:13px;margin:0 0 6px;color:var(--bi-text-2)}
.bi-text code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:var(--bi-hover);border-radius:4px;padding:1px 4px}
.bi-text a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.bi-text[data-align="center"]{text-align:center}
.bi-pie{display:flex;gap:12px;height:100%;align-items:center}
.bi-pie-plot{position:relative;flex:1 1 55%;min-width:0;height:100%}
.bi-pie-total{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;text-align:center}
.bi-pie-total strong{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.bi-pie-total span{font-size:11px;color:var(--bi-text-3)}
.bi-pie-legend{flex:1 1 45%;min-width:0;list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12px}
.bi-pie-legend li{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:6px;color:var(--bi-text-2)}
.bi-pie-legend li span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bi-pie-legend li span:last-child{color:var(--bi-text);font-variant-numeric:tabular-nums}
@container (max-width:360px){.bi-pie{flex-direction:column}.bi-pie-legend{width:100%}}
.bi-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.bi-table th{position:sticky;top:0;background:var(--bi-surface);text-align:left;font-weight:600;color:var(--bi-text-2);padding:6px 10px;border-bottom:1px solid var(--bi-border);white-space:nowrap}
.bi-table td{padding:6px 10px;border-bottom:1px solid var(--bi-grid);white-space:nowrap}
.bi-table tbody tr:hover{background:var(--bi-hover)}
.bi-table [data-align="right"]{text-align:right}
.bi-pager{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:8px;font-size:12px;color:var(--bi-text-2)}
.bi-pager button{font:inherit;color:var(--bi-text);background:transparent;border:1px solid var(--bi-border);border-radius:6px;padding:2px 8px;cursor:pointer}
.bi-pager button:disabled{opacity:.4;cursor:default}
.bi-tooltip{background:var(--bi-surface);border:1px solid var(--bi-border);border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.08);font-size:12px;min-width:120px}
.bi-tooltip-label{color:var(--bi-text-2);margin-bottom:4px}
.bi-tooltip-row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.bi-tooltip-key{display:flex;align-items:center;gap:6px;color:var(--bi-text-2)}
.bi-tooltip-swatch{width:8px;height:8px;border-radius:2px;flex:none}
.bi-tooltip-value{color:var(--bi-text);font-weight:600;font-variant-numeric:tabular-nums}
.bi-legend{display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-end;font-size:12px;color:var(--bi-text-2);margin:-4px 0 6px}
.bi-legend span{display:inline-flex;align-items:center;gap:6px}
`;

/** Base styles plus each workstream's additions (interaction UI, new visuals, platform UI). */
export const CSS = `${BASE_CSS}${INTERACTION_CSS}${VIZ_CSS}${PLATFORM_CSS}`;


const STYLE_ID = 'bi-renderer-styles';

export function ensureStyles(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}
