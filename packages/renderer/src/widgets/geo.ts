import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import usTopo from 'us-atlas/states-10m.json';
import worldTopo from 'world-atlas/countries-110m.json';
import { ISO_NUMERIC } from './iso3166';

/**
 * Basemaps for map widgets (world countries 1:110m, US states 1:10m) and region matching.
 * Countries match by name (with aliases for the atlas's abbreviated names) or ISO 3166-1 numeric
 * code, or (1.4) ISO alpha-2/alpha-3 code; US states by name, FIPS code or postal code; US counties
 * (1.4, loaded on demand) by 5-digit FIPS code or "County name, ST".
 */

export type Basemap = 'world' | 'usa' | 'usa-counties';
export type Region = Feature<Geometry, { name: string }> & { id?: string | number };

const cache = new Map<Basemap, FeatureCollection<Geometry, { name: string }>>();

let countiesTopo: Topology | null = null;
let countiesLoading: Promise<void> | null = null;

/** Starts loading the counties basemap (≈800 KB) the first time a counties map renders. */
export function loadCounties(): Promise<void> {
  countiesLoading ??= import('us-atlas/counties-10m.json').then((m) => {
    countiesTopo = ((m as { default?: unknown }).default ?? m) as Topology;
  });
  return countiesLoading;
}

export const countiesReady = () => countiesTopo !== null;

export function basemap(kind: Basemap): FeatureCollection<Geometry, { name: string }> {
  let fc = cache.get(kind);
  if (!fc && kind === 'usa-counties') {
    if (!countiesTopo) throw loadCounties(); // Suspense: WidgetFrame shows the skeleton until loaded
    fc = feature(countiesTopo, countiesTopo.objects.counties as GeometryCollection<{ name: string }>) as unknown as FeatureCollection<Geometry, { name: string }>;
    cache.set(kind, fc);
  }
  if (!fc) {
    const topo = (kind === 'usa' ? usTopo : worldTopo) as unknown as Topology;
    const object = topo.objects[kind === 'usa' ? 'states' : 'countries'] as GeometryCollection<{ name: string }>;
    fc = feature(topo, object) as unknown as FeatureCollection<Geometry, { name: string }>;
    cache.set(kind, fc);
  }
  return fc;
}

export const normalizeName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Common alternate names → the atlas name. */
const WORLD_ALIASES: Record<string, string> = {
  'united states': 'United States of America',
  usa: 'United States of America',
  us: 'United States of America',
  america: 'United States of America',
  uk: 'United Kingdom',
  'great britain': 'United Kingdom',
  britain: 'United Kingdom',
  'russian federation': 'Russia',
  'democratic republic of the congo': 'Dem. Rep. Congo',
  'dr congo': 'Dem. Rep. Congo',
  drc: 'Dem. Rep. Congo',
  'congo kinshasa': 'Dem. Rep. Congo',
  'republic of the congo': 'Congo',
  'congo brazzaville': 'Congo',
  'dominican republic': 'Dominican Rep.',
  'central african republic': 'Central African Rep.',
  'equatorial guinea': 'Eq. Guinea',
  'ivory coast': "Côte d'Ivoire",
  'cote d ivoire': "Côte d'Ivoire",
  swaziland: 'eSwatini',
  eswatini: 'eSwatini',
  'czech republic': 'Czechia',
  'bosnia and herzegovina': 'Bosnia and Herz.',
  'north macedonia': 'Macedonia',
  'south sudan': 'S. Sudan',
  'western sahara': 'W. Sahara',
  'falkland islands': 'Falkland Is.',
  'solomon islands': 'Solomon Is.',
  'northern cyprus': 'N. Cyprus',
  'korea republic of': 'South Korea',
  'republic of korea': 'South Korea',
  korea: 'South Korea',
  'democratic people s republic of korea': 'North Korea',
  'viet nam': 'Vietnam',
  'lao pdr': 'Laos',
  'syrian arab republic': 'Syria',
  'iran islamic republic of': 'Iran',
  'united republic of tanzania': 'Tanzania',
  uae: 'United Arab Emirates',
  holland: 'Netherlands',
  'the netherlands': 'Netherlands',
  turkiye: 'Turkey',
  burma: 'Myanmar',
};

const US_POSTAL: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

/** A lookup from a data value (name, code) to the basemap feature it names. */
export function regionMatcher(kind: Basemap): (value: unknown) => Region | undefined {
  const fc = basemap(kind);
  const byName = new Map<string, Region>();
  const byId = new Map<string, Region>();
  for (const f of fc.features as Region[]) {
    byName.set(normalizeName(f.properties.name), f);
    if (f.id !== undefined) byId.set(String(Number(f.id)), f);
  }
  // Counties: "Cook, IL" / "Cook County, IL" → the county in that state (state FIPS = first 2 digits).
  const stateFips = kind === 'usa-counties' ? new Map((basemap('usa').features as Region[]).map((f) => [normalizeName(f.properties.name), String(Number(f.id)).padStart(2, '0')])) : null;
  const byCountyState = new Map<string, Region>();
  if (stateFips) for (const f of fc.features as Region[]) byCountyState.set(`${normalizeName(f.properties.name)}|${String(f.id).padStart(5, '0').slice(0, 2)}`, f);
  return (value) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') return byId.get(String(value));
    const raw = String(value).trim();
    if (/^\d+$/.test(raw)) return byId.get(String(Number(raw)));
    if (kind === 'world' && /^[A-Za-z]{2,3}$/.test(raw) && ISO_NUMERIC.has(raw.toUpperCase())) {
      const hit = byId.get(String(ISO_NUMERIC.get(raw.toUpperCase())));
      if (hit) return hit;
    }
    if (stateFips) {
      const m = /^(.*?)(?:\s+(?:county|parish|borough|census area|municipality))?\s*,\s*([A-Za-z]{2}|[A-Za-z .]+)$/i.exec(raw);
      if (!m) return undefined;
      const st = m[2]!.length === 2 ? US_POSTAL[m[2]!.toUpperCase()] : m[2]!;
      const fips = st ? stateFips.get(normalizeName(st)) : undefined;
      return fips ? byCountyState.get(`${normalizeName(m[1]!)}|${fips}`) : undefined;
    }
    if (kind === 'usa' && /^[A-Za-z]{2}$/.test(raw)) {
      const name = US_POSTAL[raw.toUpperCase()];
      return name ? byName.get(normalizeName(name)) : undefined;
    }
    const n = normalizeName(raw);
    const alias = kind === 'world' ? WORLD_ALIASES[n] : undefined;
    return byName.get(alias ? normalizeName(alias) : n);
  };
}
