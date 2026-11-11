import type { Cell, Format, NumberFormat, ResultColumn } from '@yourorg/bi-spec';

/**
 * Value formatting. Dates are parsed and printed in UTC so a dashboard reads the same in
 * every host app and every viewer's timezone.
 */

export interface FormatContext {
  locale: string;
  currency: string;
}

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) cache.set(key, (f = new Intl.NumberFormat(locale, options)));
  return f;
}
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options })));
  return f;
}

function parseDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

export function inferFormat(column: ResultColumn | undefined): Format {
  if (!column) return 'text';
  if (column.type === 'time') return column.grain === 'month' ? 'month' : 'date';
  if (column.type === 'number') return 'number';
  return 'text';
}

export interface FormatOptions {
  /** Short form for axis ticks: $1.2M, Jan '26. */
  compact?: boolean;
}

const SCALES = { k: 1e3, M: 1e6, B: 1e9 } as const;

/** Spec 1.3 custom number format (decimals, prefix/suffix, k/M/B scaling, percent). */
export function formatNumber(value: number, nf: NumberFormat, ctx: FormatContext): string {
  let v = nf.percent ? value * 100 : value;
  let unit = '';
  const scale = nf.scale ?? 'none';
  if (scale !== 'none') {
    const abs = Math.abs(v);
    const key = scale === 'auto' ? (abs >= 1e9 ? 'B' : abs >= 1e6 ? 'M' : abs >= 1e3 ? 'k' : null) : scale;
    if (key) {
      v /= SCALES[key];
      unit = key;
    }
  }
  const decimals = nf.decimals ?? (unit ? 1 : nf.percent ? 1 : 2);
  const body = numberFormat(ctx.locale, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: nf.decimals ?? 0,
    useGrouping: nf.thousands !== false,
  }).format(Math.abs(v));
  const suffix = nf.suffix ?? (nf.percent ? '%' : '');
  return `${v < 0 ? '-' : ''}${nf.prefix ?? ''}${body}${unit}${suffix}`;
}

/** The format for a result column: a custom `numberFormats` entry wins over the enum format. */
export function pickFormat(numberFormats: Record<string, NumberFormat> | undefined, field: string | undefined, fallback?: Format): Format | NumberFormat | undefined {
  return (field && numberFormats?.[field]) || fallback;
}

export function formatValue(
  value: Cell | undefined,
  format: Format | NumberFormat | undefined,
  column: ResultColumn | undefined,
  ctx: FormatContext,
  opts: FormatOptions = {},
): string {
  if (value === null || value === undefined) return '—';
  if (format && typeof format === 'object') return typeof value === 'number' ? formatNumber(value, format, ctx) : String(value);
  const fmt = format ?? inferFormat(column);
  const { locale, currency } = ctx;

  if (fmt === 'date' || fmt === 'month') {
    const d = typeof value === 'string' ? parseDate(value) : null;
    if (!d) return String(value);
    const grain = column?.grain;
    if (grain === 'year') return String(d.getUTCFullYear());
    if (grain === 'quarter') return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${opts.compact ? `'${String(d.getUTCFullYear()).slice(2)}` : d.getUTCFullYear()}`;
    if (fmt === 'month' || grain === 'month') {
      return dateFormat(locale, { month: 'short', year: opts.compact ? '2-digit' : 'numeric' }).format(d);
    }
    return dateFormat(locale, opts.compact ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  }
  if (typeof value !== 'number') return String(value);

  switch (fmt) {
    case 'currency':
      return numberFormat(
        locale,
        opts.compact
          ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
          : { style: 'currency', currency, maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 },
      ).format(value);
    case 'percent':
      return numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
    case 'compact':
      return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    case 'integer':
      return numberFormat(locale, opts.compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }).format(value);
    case 'text':
      return String(value);
    default:
      return numberFormat(locale, opts.compact ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(value);
  }
}

/** "avg_order_value" → "Avg order value" */
export function humanize(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * "just now", "3 min ago", "2 h ago", "4 d ago": a freshness hint, not a timestamp (the full
 * time goes in the element's title).
 */
export function formatAge(asOf: string, now: number): string | null {
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return null;
  const seconds = Math.max(0, (now - t) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
