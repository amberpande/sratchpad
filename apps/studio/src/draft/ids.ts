import { ID_PATTERN } from '@yourorg/bi-spec';

/** Turns any text into something matching the spec's id pattern (letter first, [A-Za-z0-9_-], ≤ 64). */
export function toId(text: string, prefix = 'x'): string {
  let id = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  if (!/^[a-z]/.test(id)) id = id ? `${prefix}_${id}` : prefix;
  return id.slice(0, 64);
}

/** First of `base`, `base_2`, `base_3`, … not in `taken`. Always matches ID_PATTERN. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = toId(base).slice(0, 58);
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** "dash_" + a slug of the title, for new dashboards. */
export function dashboardIdFromTitle(title: string): string {
  const slug = toId(title, 'dash');
  return slug.startsWith('dash') ? slug : `dash_${slug}`.slice(0, 64);
}
