import type { Cell, MapWidget as MapSpec } from '@yourorg/bi-spec';
import { geoAlbersUsa, geoNaturalEarth1, geoPath, type GeoProjection } from 'd3-geo';
import { useMemo, type CSSProperties } from 'react';
import { formatValue, humanize, pickFormat } from '../format';
import { basemap, regionMatcher, type Region } from './geo';
import { Message } from './Message';
import { column, type WidgetProps } from './types';
import { extent, norm, scaleFill, useMarks, useSize } from './vizParts';

/**
 * Map: a choropleth (regions colored by a measure) or a symbol map (points at lat/lon sized by a
 * measure) over world countries or US states. Unmatched regions are counted in a note; their data is
 * still in the "View as table" alternative.
 */
export default function MapWidget({ widget, result, format }: WidgetProps<MapSpec>) {
  const e = widget.encoding;
  const o = widget.options;
  const [ref, size] = useSize<HTMLDivElement>();
  const keyField = o.kind === 'symbol' ? (e.label ?? e.lat) : e.region;
  const marks = useMarks(keyField);
  const valueField = o.kind === 'symbol' ? e.size : e.value;
  const fmt = pickFormat(o.numberFormats, valueField, o.format);
  const vMeta = valueField ? column(result, valueField) : undefined;

  const model = useMemo(() => {
    const fc = basemap(o.basemap);
    if (o.kind === 'symbol') {
      const points = result.rows
        .map((r) => ({ row: r, lat: r[e.lat ?? ''], lon: r[e.lon ?? ''] }))
        .filter((p): p is { row: Record<string, Cell>; lat: number; lon: number } => typeof p.lat === 'number' && typeof p.lon === 'number' && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
      return { fc, matched: new Map<Region, Record<string, Cell>>(), points, unmatched: result.rows.length - points.length };
    }
    const match = regionMatcher(o.basemap);
    const matched = new Map<Region, Record<string, Cell>>();
    let unmatched = 0;
    for (const r of result.rows) {
      const f = match(r[e.region ?? '']);
      if (f && !matched.has(f)) matched.set(f, r);
      else if (!f) unmatched++;
    }
    return { fc, matched, points: [], unmatched };
  }, [result, o.basemap, o.kind, e.region, e.lat, e.lon]);

  const path = useMemo(() => {
    if (!size.width) return null;
    const proj: GeoProjection = (o.basemap === 'usa' ? geoAlbersUsa() : geoNaturalEarth1()) as GeoProjection;
    proj.fitExtent(
      [
        [4, 4],
        [size.width - 4, Math.max(8, size.height - 24)],
      ],
      model.fc,
    );
    return { proj, d: geoPath(proj) };
  }, [size, model.fc, o.basemap]);

  if (!result.rows.length) return <Message title="No data" />;
  const values = o.kind === 'symbol' ? model.points.map((p) => (valueField ? (p.row[valueField] ?? null) : null)) : [...model.matched.values()].map((r) => r[e.value ?? ''] ?? null);
  const range = extent(values);
  const tip = (r: Record<string, Cell>, name: string) =>
    [
      `${name}: ${valueField ? formatValue(r[valueField] ?? null, fmt, vMeta, format) : ''}`,
      ...(o.tooltip?.fields ?? []).map((f) => `${humanize(f)}: ${formatValue(r[f] ?? null, pickFormat(o.numberFormats, f), column(result, f), format)}`),
    ].join('\n');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        ref={ref}
        style={{ flex: 1, minHeight: 0, cursor: marks.cursor }}
        role="img"
        aria-label={o.kind === 'symbol' ? `Symbol map of ${model.points.length} locations${valueField ? ` sized by ${humanize(valueField)}` : ''}` : `Map of ${humanize(e.value ?? 'value')} by ${humanize(e.region ?? 'region')}`}
      >
        {size.width > 0 && path && (
          <svg width={size.width} height={size.height} className="bi-map">
            {(model.fc.features as Region[]).map((f, i) => {
              const row = model.matched.get(f);
              const v = row?.[e.value ?? ''];
              const fill = o.kind === 'choropleth' && typeof v === 'number' && range ? scaleFill(norm(v, range), o.colors) : null;
              const key = row ? (row[e.region ?? ''] ?? null) : null;
              return (
                <path
                  key={i}
                  d={path.d(f) ?? undefined}
                  className="bi-map-region"
                  data-matched={row ? '' : undefined}
                  fill={fill ? fill.fill : 'var(--bi-hover)'}
                  fillOpacity={fill ? fill.fillOpacity * (row ? marks.opacity(key) : 1) : 1}
                  onClick={row ? (ev) => marks.onSelect(key, ev) : undefined}
                >
                  <title>{row ? tip(row, f.properties.name) : f.properties.name}</title>
                </path>
              );
            })}
            {o.kind === 'symbol' &&
              model.points.map((p, i) => {
                const xy = path.proj([p.lon, p.lat]);
                if (!xy) return null;
                const v = valueField ? p.row[valueField] : null;
                const r = typeof v === 'number' && range ? 3 + Math.sqrt(Math.max(0, norm(v, range))) * 15 : 5;
                const key = keyField ? (p.row[keyField] ?? null) : null;
                const name = e.label ? String(p.row[e.label] ?? '') : `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`;
                return (
                  <circle key={i} cx={xy[0]} cy={xy[1]} r={r} className="bi-map-point" fillOpacity={0.6 * marks.opacity(key)} onClick={(ev) => marks.onSelect(key, ev)}>
                    <title>{tip(p.row, name)}</title>
                  </circle>
                );
              })}
          </svg>
        )}
      </div>
      <div className="bi-map-foot">
        {o.kind === 'choropleth' && range && (
          <span className="bi-map-legend">
            {formatValue(range[0], fmt, vMeta, format, { compact: true })}
            <span className="bi-map-ramp" style={o.colors ? ({ '--bi-ramp-from': o.colors.from, '--bi-ramp-to': o.colors.to } as CSSProperties) : undefined} data-custom={o.colors ? '' : undefined} />
            {formatValue(range[1], fmt, vMeta, format, { compact: true })}
          </span>
        )}
        {model.unmatched > 0 && (
          <span className="bi-viz-note">
            {model.unmatched} row(s) {o.kind === 'symbol' ? 'without valid coordinates' : 'not matched to a region'}; see the table view.
          </span>
        )}
      </div>
    </div>
  );
}
