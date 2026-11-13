/**
 * Spec versioning.
 *
 * - Adding an optional field or a new widget type is a MINOR bump (backward-compatible).
 * - Removing or re-typing a field is a MAJOR bump and needs a renderer release.
 *
 * A renderer supports one major version, up to a known minor. Anything newer in the same
 * major renders "degraded" (unknown widgets become placeholders, unknown params are ignored);
 * a different major is refused outright, so an old host app degrades predictably instead of crashing.
 */

export interface SpecVersion {
  major: number;
  minor: number;
}

/** The spec version this build of the package writes and fully understands. */
export const SPEC_VERSION = '1.4';
export const SUPPORTED_SPEC: SpecVersion = { major: 1, minor: 4 };

/**
 * What each minor added, newest last. Every entry is additive: documents written for an earlier
 * minor validate and render unchanged. The registry in widgets.ts records the same versions per
 * type (`since`) and per field (`fieldsSince`); this list is the human-readable summary.
 */
export const SPEC_CHANGELOG: ReadonlyArray<{ version: string; changes: string[] }> = [
  { version: '1.0', changes: ['Widget types kpi, line-chart, bar-chart, table; daterange and select params.'] },
  {
    version: '1.1',
    changes: [
      'New widget types: area-chart, scatter, pie, pivot, text (text takes no query).',
      'Optional encoding.series on line-chart, bar-chart and area-chart (long → wide by a column).',
      'Optional options.pagination on table ("auto" | "pages" | "scroll").',
    ],
  },
  {
    version: '1.2',
    changes: [
      'Optional dashboard theme: palette, accent, background, cardBackground, cardStyle, density, radius, font.',
      'Optional widget style on every type: colors, background, emphasis, accent, titleAlign, hideTitle.',
      'Optional chart options: showGrid, dataLabels, axis (labels, hide, y min/max) on line/bar/area; showGrid and axis on scatter.',
    ],
  },
  {
    version: '1.3',
    changes: [
      'Calculations, interactivity, new visuals and platform features. Every addition is optional (see docs/SPEC.md).',
    ],
  },
  {
    version: '1.4',
    changes: ['Custom SQL queries: optional query `sql` (one SELECT) with declared result `columns`, instead of the visual query fields.'],
  },
];

export type CompatibilityLevel = 'full' | 'degraded' | 'unsupported';

export interface Compatibility {
  level: CompatibilityLevel;
  specVersion: string;
  /** Human-readable supported range, e.g. "1.0–1.1". */
  supported: string;
  message?: string;
}

export function parseSpecVersion(value: string): SpecVersion | null {
  const match = /^(\d{1,4})\.(\d{1,4})$/.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function formatSpecVersion(v: SpecVersion): string {
  return `${v.major}.${v.minor}`;
}

export function compareSpecVersions(a: SpecVersion, b: SpecVersion): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

export function checkCompatibility(specVersion: string, supported: SpecVersion = SUPPORTED_SPEC): Compatibility {
  const range = `${supported.major}.0–${formatSpecVersion(supported)}`;
  const parsed = parseSpecVersion(specVersion);
  if (!parsed) {
    return {
      level: 'unsupported',
      specVersion,
      supported: range,
      message: `"${specVersion}" is not a valid specVersion; expected "MAJOR.MINOR", such as "1.0".`,
    };
  }
  if (parsed.major !== supported.major) {
    return {
      level: 'unsupported',
      specVersion,
      supported: range,
      message: `This dashboard uses spec ${specVersion}, which needs a renderer for ${parsed.major}.x. This renderer supports ${range}.`,
    };
  }
  if (parsed.minor > supported.minor) {
    return {
      level: 'degraded',
      specVersion,
      supported: range,
      message: `This dashboard uses spec ${specVersion}, newer than this renderer (${range}). Newer features are skipped; upgrade the SDK to see everything.`,
    };
  }
  return { level: 'full', specVersion, supported: range };
}
