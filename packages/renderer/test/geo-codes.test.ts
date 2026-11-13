import { describe, expect, it } from 'vitest';
import { basemap, loadCounties, regionMatcher } from '../src/widgets/geo';

// ISO alpha codes and US counties on maps (D-092).
describe('map region matching', () => {
  it('matches ISO alpha-2 and alpha-3 country codes', () => {
    const m = regionMatcher('world');
    expect(m('DE')?.properties.name).toBe('Germany');
    expect(m('deu')?.properties.name).toBe('Germany');
    expect(m('BRA')?.properties.name).toBe('Brazil');
    expect(m('Germany')?.properties.name).toBe('Germany');
  });

  it('loads counties on demand and matches FIPS and "County, ST"', async () => {
    expect(() => basemap('usa-counties')).toThrow(); // a promise for Suspense until loaded
    await loadCounties();
    const m = regionMatcher('usa-counties');
    expect(m('17031')?.properties.name).toBe('Cook');
    expect(m(17031)?.properties.name).toBe('Cook');
    expect(m('Cook County, IL')?.properties.name).toBe('Cook');
    expect(m('Los Angeles, California')?.properties.name).toBe('Los Angeles');
    expect(m('Cook, ZZ')).toBeUndefined();
  });
});
