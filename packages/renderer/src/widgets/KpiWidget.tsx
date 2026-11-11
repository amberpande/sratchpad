import type { Cell, KpiWidget as KpiSpec } from '@yourorg/bi-spec';
import { formatValue, humanize, pickFormat } from '../format';
import { column, type WidgetProps } from './types';
import { cellVars, matchRule } from './vizParts';

/** Collapses an already-aggregated result (e.g. 12 monthly totals) into the headline number. */
export function reduceColumn(values: Cell[], reduce: KpiSpec['options']['reduce']): number | null {
  if (reduce === 'count') return values.filter((v) => v !== null).length;
  const nums = values.filter((v): v is number => typeof v === 'number');
  if (!nums.length) return null;
  switch (reduce) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min':
      return Math.min(...nums);
    case 'max':
      return Math.max(...nums);
    case 'first':
      return nums[0]!;
    case 'last':
      return nums[nums.length - 1]!;
  }
}

export function KpiWidget({ widget, result, format }: WidgetProps<KpiSpec>) {
  const { field, reduce, label, thresholds, comparison, numberFormats } = widget.options;
  const value = reduceColumn(
    result.rows.map((r) => r[field] ?? null),
    reduce,
  );
  const text = formatValue(value, pickFormat(numberFormats, field, widget.options.format), column(result, field), format);
  // Threshold colors (1.3) go through a custom property, like every author-chosen color.
  const rule = matchRule(value, thresholds);
  return (
    <div className="bi-kpi">
      <div className="bi-kpi-value" title={text} data-cf={rule ? '' : undefined} style={rule ? cellVars(rule.color, rule.background) : undefined}>
        {text}
      </div>
      {comparison && <Comparison spec={comparison} result={result} format={format} numberFormats={numberFormats} />}
      <div className="bi-kpi-label">{label ?? humanize(field)}</div>
    </div>
  );
}

/**
 * ▲/▼ change under the value. Reads the comparison column (e.g. a percent_change window column) from
 * the last row, where period-over-period calculations put the latest period.
 */
function Comparison({ spec, result, format, numberFormats }: { spec: NonNullable<KpiSpec['options']['comparison']>; result: WidgetProps<KpiSpec>['result']; format: WidgetProps<KpiSpec>['format']; numberFormats?: KpiSpec['options']['numberFormats'] }) {
  const rows = result.rows;
  const raw = rows.length ? rows[rows.length - 1]![spec.field] : null;
  if (typeof raw !== 'number') return <div className="bi-kpi-delta" data-tone="neutral">{spec.label ? `${spec.label}: ` : ''}—</div>;
  const good = raw === 0 ? null : (raw > 0) === (spec.positiveIs === 'up');
  const arrow = raw > 0 ? '▲' : raw < 0 ? '▼' : '■';
  const fmt = pickFormat(numberFormats, spec.field, spec.display === 'percent' ? 'percent' : undefined);
  const text = formatValue(Math.abs(raw), fmt, column(result, spec.field), format);
  const tone = good === null ? 'neutral' : good ? 'good' : 'bad';
  return (
    <div className="bi-kpi-delta" data-tone={tone}>
      <span aria-hidden="true">{arrow}</span> <span>{raw < 0 ? '−' : raw > 0 ? '+' : ''}{text}</span>
      {spec.label && <span className="bi-kpi-delta-label"> {spec.label}</span>}
      <span className="bi-sr-only">{` (${tone === 'good' ? 'improvement' : tone === 'bad' ? 'decline' : 'no change'})`}</span>
    </div>
  );
}
