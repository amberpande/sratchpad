import type { DashboardTheme, WidgetStyle } from '@yourorg/bi-spec';
import type { CSSProperties } from 'react';
import { SERIES_COUNT } from './styles';

/**
 * Spec 1.2 styling → CSS custom properties. Values were validated by the spec (hex colors, enums,
 * bounded numbers), and are only ever set as custom-property values, never as raw CSS text.
 */

const FONT_STACKS: Record<NonNullable<DashboardTheme['font']>, string> = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
  inherit: 'inherit',
  humanist: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  geometric: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif',
  slab: 'Rockwell, "Rockwell Nova", "Roboto Slab", "DejaVu Serif", "Sitka Small", serif',
  condensed: '"Roboto Condensed", "Arial Narrow", "Helvetica Neue Condensed", "Avenir Next Condensed", sans-serif-condensed, sans-serif',
};

type Vars = CSSProperties & Record<`--${string}`, string>;

function palette(colors: string[] | undefined, vars: Vars) {
  colors?.slice(0, SERIES_COUNT).forEach((c, i) => (vars[`--bi-series-${i + 1}`] = c));
}

export function themeVars(theme: DashboardTheme | undefined): { style: Vars; attrs: Record<string, string | undefined> } {
  const style: Vars = {};
  if (!theme) return { style, attrs: {} };
  palette(theme.palette, style);
  if (theme.accent) style['--bi-accent'] = theme.accent;
  if (theme.background) style['--bi-page'] = theme.background;
  if (theme.cardBackground) style['--bi-surface'] = theme.cardBackground;
  if (theme.radius !== undefined) style['--bi-radius'] = `${theme.radius}px`;
  if (theme.font) style['--bi-font'] = FONT_STACKS[theme.font];
  return {
    style,
    attrs: {
      'data-bi-card': theme.cardStyle && theme.cardStyle !== 'bordered' ? theme.cardStyle : undefined,
      'data-bi-density': theme.density === 'compact' ? 'compact' : undefined,
      'data-bi-page': theme.background ? '' : undefined,
    },
  };
}

export function widgetStyleVars(style: WidgetStyle | undefined): { style: Vars; attrs: Record<string, string | undefined> } {
  const vars: Vars = {};
  if (!style) return { style: vars, attrs: {} };
  palette(style.colors, vars);
  if (style.background) vars['--bi-surface'] = style.background;
  if (style.accent) vars['--bi-accent'] = style.accent;
  return {
    style: vars,
    attrs: {
      'data-bi-emphasis': style.emphasis ? '' : undefined,
      'data-bi-title-align': style.titleAlign === 'center' ? 'center' : undefined,
    },
  };
}
