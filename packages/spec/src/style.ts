import { z } from 'zod';

/**
 * Spec 1.2: the styling layer. Dashboard-level `theme` and widget-level `style`.
 *
 * Every value is constrained (hex colors, enums, bounded numbers) because renderers apply them as
 * CSS custom properties: a free-form string here would be a CSS-injection hole in every host app.
 * Colors chosen by authors are not checked for contrast or color-vision safety; the default palette is.
 */

export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'colors are hex, e.g. "#1f6feb"');

/**
 * Font families (never URLs or free CSS). Since 1.4 (D-093): 'inherit' uses the host app's own font, so an
 * embedded dashboard matches each team's typography; plus humanist, geometric, slab and condensed stacks of
 * fonts already installed on users' systems (no network loading).
 */
export const FONTS = ['system', 'serif', 'mono', 'rounded', 'inherit', 'humanist', 'geometric', 'slab', 'condensed'] as const;

export const DashboardThemeSchema = z
  .object({
    /**
     * Light or dark text and chrome. Set it whenever backgrounds are set: it wins over the host's theme,
     * because the author picked the colors for it. Unset: the host decides (light/dark/auto).
     */
    mode: z.enum(['light', 'dark']).optional(),
    /** Series colors in order (up to 8); replaces the default categorical palette. */
    palette: z.array(HexColorSchema).min(1).max(8).optional(),
    /** Emphasis color: emphasized widgets, focus rings. */
    accent: HexColorSchema.optional(),
    /** Page background behind the cards. Default: the host page shows through. */
    background: HexColorSchema.optional(),
    /** Card background. */
    cardBackground: HexColorSchema.optional(),
    /** Card chrome: hairline border (default), no border, or a soft shadow. */
    cardStyle: z.enum(['bordered', 'flat', 'elevated']).optional(),
    /** Spacing between and inside cards. */
    density: z.enum(['comfortable', 'compact']).optional(),
    /** Card corner radius in px. */
    radius: z.number().int().min(0).max(24).optional(),
    font: z.enum(FONTS).optional(),
  })
  .strict();

export const WidgetStyleSchema = z
  .object({
    /** Series colors for this widget only (up to 8). */
    colors: z.array(HexColorSchema).min(1).max(8).optional(),
    /** Card background for this widget. */
    background: HexColorSchema.optional(),
    /** Emphasize this card with an accent edge (theme accent unless set here). */
    emphasis: z.boolean().optional(),
    accent: HexColorSchema.optional(),
    titleAlign: z.enum(['left', 'center']).optional(),
    hideTitle: z.boolean().optional(),
  })
  .strict();

const AxisSideSchema = z.object({ label: z.string().max(80).optional(), hide: z.boolean().optional() }).strict();

/** Chart axes (1.2): titles, hiding, and a fixed value range on y. */
export const AxisOptionsSchema = z
  .object({
    x: AxisSideSchema.optional(),
    y: AxisSideSchema.extend({ min: z.number().finite().optional(), max: z.number().finite().optional() })
      .strict()
      .refine((v) => v.min === undefined || v.max === undefined || v.min < v.max, '"min" must be below "max"')
      .optional(),
  })
  .strict();

export type DashboardTheme = z.infer<typeof DashboardThemeSchema>;
export type WidgetStyle = z.infer<typeof WidgetStyleSchema>;
export type AxisOptions = z.infer<typeof AxisOptionsSchema>;

/** Relative luminance of a hex color (WCAG), 0 = black, 1 = white. */
export function luminance(hex: string): number {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Backgrounds that would leave the text unreadable: a dark background with light-mode (dark) text,
 * or the reverse. Returned as warnings; they never block saving.
 */
export function themeContrastProblems(theme: DashboardTheme): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  for (const key of ['background', 'cardBackground'] as const) {
    const color = theme[key];
    if (!color) continue;
    const dark = luminance(color) < 0.18;
    if (dark && theme.mode !== 'dark') out.push({ path: `theme.${key}`, message: `${color} is dark: set theme.mode to "dark" so text stays readable.` });
    if (!dark && theme.mode === 'dark') out.push({ path: `theme.${key}`, message: `${color} is light but theme.mode is "dark": text would be hard to read.` });
  }
  return out;
}

/** The version that introduced the styling layer. */
export const STYLE_SINCE = '1.2';
