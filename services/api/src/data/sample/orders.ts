import { toIsoDate } from '@yourorg/bi-spec';
import type { Row } from './execute';

/**
 * Deterministic sample orders: about two years of daily orders ending today, with growth,
 * Q4 seasonality and weekend dips, so the sample dashboards look like real data.
 */

export const ORDER_FIELDS: ReadonlySet<string> = new Set([
  'order_id',
  'order_date',
  'customer_id',
  'region',
  'category',
  'channel',
  'status',
  'quantity',
  'amount',
]);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(rand: () => number, items: ReadonlyArray<readonly [T, number]>): T {
  let r = rand() * items.reduce((sum, [, w]) => sum + w, 0);
  for (const [item, w] of items) {
    if ((r -= w) <= 0) return item;
  }
  return items[items.length - 1]![0];
}

const REGIONS = [
  ['North America', 0.42],
  ['Europe', 0.3],
  ['APAC', 0.18],
  ['LATAM', 0.1],
] as const;
const REGION_PRICE: Record<string, number> = { 'North America': 1, Europe: 1.08, APAC: 0.92, LATAM: 0.8 };
const CATEGORIES = [
  ['Software', 0.35],
  ['Hardware', 0.3],
  ['Support', 0.2],
  ['Services', 0.15],
] as const;
const CATEGORY_PRICE: Record<string, number> = { Software: 900, Hardware: 450, Support: 300, Services: 2400 };
const CHANNELS = [
  ['Online', 0.5],
  ['Partner', 0.3],
  ['Direct', 0.2],
] as const;
const STATUSES = [
  ['paid', 0.88],
  ['pending', 0.07],
  ['refunded', 0.05],
] as const;

const DAY_MS = 86_400_000;

export function generateOrders(now: Date, { months = 24, seed = 20261109 } = {}): { fields: ReadonlySet<string>; rows: Row[] } {
  const rand = mulberry32(seed);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1);
  const totalDays = Math.round((end - start) / DAY_MS);
  const rows: Row[] = [];
  let seq = 0;

  for (let i = 0; i <= totalDays; i++) {
    const day = new Date(start + i * DAY_MS);
    const month = day.getUTCMonth();
    const growth = 1 + 0.6 * (i / totalDays);
    const seasonal = month >= 10 ? 1.3 : month === 0 || month === 7 ? 0.85 : 1;
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6 ? 0.55 : 1;
    const expected = 9 * growth * seasonal * weekend;
    const count = Math.max(0, Math.round(expected * (0.7 + rand() * 0.6)));
    const date = toIsoDate(day);

    for (let k = 0; k < count; k++) {
      const region = weighted(rand, REGIONS);
      const category = weighted(rand, CATEGORIES);
      const quantity = 1 + Math.floor(rand() ** 2 * 5);
      const unitPrice = CATEGORY_PRICE[category]! * REGION_PRICE[region]! * (0.7 + rand() * 0.6);
      rows.push({
        order_id: `ord_${String(++seq).padStart(6, '0')}`,
        order_date: date,
        customer_id: `cus_${String(1 + Math.floor(rand() * 2400)).padStart(4, '0')}`,
        region,
        category,
        channel: weighted(rand, CHANNELS),
        status: weighted(rand, STATUSES),
        quantity,
        amount: Math.round(unitPrice * quantity * 100) / 100,
      });
    }
  }
  return { fields: ORDER_FIELDS, rows };
}
