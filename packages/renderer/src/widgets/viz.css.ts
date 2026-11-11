/**
 * OWNER: workstream C. CSS for spec 1.3 visuals and formatting. Scoped under .bi-root and themed
 * through --bi-* custom properties like the base stylesheet. Author colors arrive only as custom
 * properties (--bi-cell-fg/--bi-cell-bg, --bi-ramp-from/--bi-ramp-to) set from validated hex.
 */
export const VIZ_CSS = `
.bi-root{--bi-positive:#1f8a4c;--bi-negative:var(--bi-critical)}
.bi-root[data-bi-theme="dark"]{--bi-positive:#3fb96f}
@media (prefers-color-scheme:dark){.bi-root[data-bi-theme="auto"]{--bi-positive:#3fb96f}}
.bi-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bi-axis-text{fill:var(--bi-text-3);font-size:11px}
.bi-ref-label{fill:var(--bi-text-2);font-size:11px}
.bi-viz-note{margin:4px 0 0;font-size:11px;color:var(--bi-text-3)}
.bi-root [data-cf]{color:var(--bi-cell-fg,inherit);background:var(--bi-cell-bg,transparent)}
.bi-table tr[data-clickable]{cursor:pointer}
.bi-table tr[data-clickable]:hover td{background:var(--bi-hover)}
.bi-sort{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:inherit;font-weight:inherit}
.bi-sort:hover{text-decoration:underline}
.bi-spark{display:block}
.bi-spark-empty{color:var(--bi-text-3)}
.bi-kpi-delta{font-size:13px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
.bi-kpi-delta[data-tone="good"]{color:var(--bi-positive)}
.bi-kpi-delta[data-tone="bad"]{color:var(--bi-negative)}
.bi-kpi-delta[data-tone="neutral"]{color:var(--bi-text-3)}
.bi-kpi-delta-label{font-weight:400;color:var(--bi-text-3)}
.bi-facets{display:grid;gap:8px;height:100%;overflow:auto;grid-auto-rows:minmax(110px,1fr)}
.bi-facet{display:flex;flex-direction:column;margin:0;min-height:0}
.bi-facet figcaption{font-size:11px;font-weight:600;color:var(--bi-text-2);margin:0 0 2px}
.bi-facet-plot{flex:1;min-height:80px}
.bi-facet-note{grid-column:1/-1;margin:0;font-size:11px;color:var(--bi-text-3)}
.bi-cell-text{fill:var(--bi-text);font-size:11px;font-variant-numeric:tabular-nums;pointer-events:none}
.bi-treemap-label{fill:#fff;font-size:12px;font-weight:600;pointer-events:none}
.bi-treemap-value{font-weight:400;opacity:.9}
.bi-funnel{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;height:100%;overflow:auto}
.bi-funnel li{display:grid;grid-template-columns:minmax(60px,22%) 1fr auto auto;gap:8px;align-items:center;font-size:12px}
.bi-funnel-stage{color:var(--bi-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bi-funnel-track{display:flex;justify-content:center;height:22px}
.bi-funnel-bar{display:block;height:100%;background:var(--bi-series-1);border-radius:4px}
.bi-funnel-value{font-variant-numeric:tabular-nums;font-weight:600}
.bi-funnel-conv{color:var(--bi-text-3);font-size:11px;min-width:84px;text-align:right}
.bi-gauge-value{fill:var(--bi-text);font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.bi-bullets{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;justify-content:center;gap:10px;height:100%;overflow:auto}
.bi-bullets li{display:grid;grid-template-columns:minmax(64px,26%) 1fr 64px;gap:8px;align-items:center;font-size:12px}
.bi-bullets li:not(:has(.bi-bullet-label)){grid-template-columns:1fr 64px}
.bi-bullet-value{text-align:right}
.bi-bullet-label{color:var(--bi-text-2);min-width:60px}
.bi-bullet-track{position:relative;height:18px;background:var(--bi-hover);border-radius:3px;overflow:hidden}
.bi-bullet-range{position:absolute;left:0;top:0;bottom:0;background:var(--bi-text-3)}
.bi-bullet-range[data-level="1"]{opacity:.28}
.bi-bullet-range[data-level="2"]{opacity:.18}
.bi-bullet-range[data-level="3"]{opacity:.1}
.bi-bullet-bar{position:absolute;left:0;top:5px;bottom:5px;background:var(--bi-series-1);border-radius:2px}
.bi-bullet-target{position:absolute;top:2px;bottom:2px;width:2px;margin-left:-1px;background:var(--bi-text)}
.bi-bullet-value{font-variant-numeric:tabular-nums;font-weight:600}
.bi-image{margin:0;height:100%;display:flex;flex-direction:column;gap:4px}
.bi-image a{display:block;flex:1;min-height:0}
.bi-image img{display:block;width:100%;height:100%;min-height:0;flex:1;object-fit:contain}
.bi-image img[data-fit="cover"]{object-fit:cover}
.bi-image figcaption{font-size:12px;color:var(--bi-text-3)}
.bi-map-region{stroke:var(--bi-surface);stroke-width:.5}
.bi-map-region[data-matched]:hover{stroke:var(--bi-text);stroke-width:1}
.bi-map-point{fill:var(--bi-series-1);stroke:var(--bi-surface);stroke-width:1}
.bi-map-foot{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;min-height:18px}
.bi-map-legend{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--bi-text-3)}
.bi-map-ramp{display:inline-block;width:72px;height:8px;border-radius:4px;background:linear-gradient(90deg,color-mix(in srgb,var(--bi-series-1) 12%,transparent),var(--bi-series-1))}
.bi-map-ramp[data-custom]{background:linear-gradient(90deg,var(--bi-ramp-from),var(--bi-ramp-to))}
`;
