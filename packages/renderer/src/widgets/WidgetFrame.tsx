import { widgetNeedsQuery, type QueryResult, type RenderableWidget, type Widget } from '@yourorg/bi-spec';
import { Component, memo, Suspense, useState, type ErrorInfo, type ReactNode } from 'react';
import type { FormatContext } from '../format';
import { WidgetFreshness } from '../Freshness';
import { Message } from './Message';
import { CHART_TYPES, componentFor } from './registry';
import { ResultTable } from './ResultTable';
import { widgetStyleVars } from '../theme';
import { WidgetIdContext } from '../interactions';
import { InteractionBadge } from '../interactions-ui';
import { WidgetMenu } from '../export/WidgetMenu';

export { Message };

export type QueryState = { status: 'loading' } | { status: 'ready'; result: QueryResult } | { status: 'error'; error: Error };

/** What static widgets (text) render from: they have no query. */
export const EMPTY_RESULT: QueryResult = { columns: [], rows: [], truncated: false };

export function Skeleton({ kind }: { kind: string }) {
  if (kind === 'kpi') {
    return (
      <div className="bi-kpi" aria-busy="true" aria-label="Loading">
        <div className="bi-skeleton" style={{ height: 30, width: '60%' }} />
        <div className="bi-skeleton" style={{ height: 12, width: '40%', marginTop: 10 }} />
      </div>
    );
  }
  return <div className="bi-skeleton" style={{ position: 'absolute', inset: 0 }} aria-busy="true" aria-label="Loading" />;
}

/** One widget crashing never takes the dashboard down. */
class WidgetBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { error: Error | null; key: unknown }> {
  override state = { error: null as Error | null, key: undefined as unknown };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { error: Error | null; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[bi-renderer] widget crashed', error, info.componentStack);
  }

  override render() {
    return this.state.error ? <Message tone="error" title="This widget failed to render" detail={this.state.error.message} /> : this.props.children;
  }
}

function widgetTitle(widget: RenderableWidget): string | undefined {
  if (widget.type === '__unsupported__') return widget.title;
  return widget.options.title;
}

export interface WidgetFrameProps {
  /** The widget's id in the dashboard (for interactions and actions). */
  widgetId?: string;
  widget: RenderableWidget;
  state: QueryState;
  format: FormatContext;
}

/**
 * Card chrome around one widget: title, freshness, the chart/table toggle, and the body.
 * Memoized: DashboardView keeps each query's state object stable, so a param change re-renders
 * only the widgets whose query actually changed.
 */
export const WidgetFrame = memo(function WidgetFrame({ widgetId = '', widget, state, format }: WidgetFrameProps) {
  const title = widgetTitle(widget);
  const [tableView, setTableView] = useState(false);
  const known = widget.type !== '__unsupported__';
  const isStatic = known && !widgetNeedsQuery(widget.type);
  const result = isStatic ? EMPTY_RESULT : state.status === 'ready' ? state.result : undefined;
  const isChart = known && CHART_TYPES.has(widget.type);
  const showTable = isChart && tableView && result !== undefined;

  let body: ReactNode;
  if (!known) {
    body = <Message title="Needs a newer renderer" detail={widget.reason} />;
  } else if (!result) {
    body = state.status === 'error' ? <Message tone="error" title="Couldn’t load data" detail={state.error.message} /> : <Skeleton kind={widget.type} />;
  } else if (showTable) {
    body = <ResultTable widget={widget} result={result} format={format} label={`${title ?? 'Chart'} (table view)`} />;
  } else {
    const View = componentFor(widget as Widget);
    body = (
      <WidgetBoundary resetKey={result}>
        <Suspense fallback={<Skeleton kind={widget.type} />}>
          <View widget={widget as Widget} result={result} format={format} />
        </Suspense>
      </WidgetBoundary>
    );
  }

  const asOf = isStatic ? undefined : result?.asOf;
  const styleSpec = known ? (widget as Widget).style : undefined;
  const styled = widgetStyleVars(styleSpec);
  const showTitle = Boolean(title) && !styleSpec?.hideTitle;
  // The head row has a fixed min-height, so a freshness label appearing never shifts the body.
  const hasHead = showTitle || isChart;
  return (
    <section className="bi-card" data-widget-type={known ? widget.type : widget.originalType} aria-label={title} style={styled.style} {...styled.attrs}>
      {hasHead ? (
        <div className="bi-card-head">
          <h3 className="bi-card-title">{showTitle ? title : null}</h3>
          <InteractionBadge widgetId={widgetId} widget={widget} />
          <WidgetFreshness asOf={asOf} cached={result?.cached} />
          {isChart && (
            <button type="button" className="bi-toggle" aria-pressed={tableView} aria-label="View as table" title={tableView ? 'Show chart' : 'Show as table'} onClick={() => setTableView((v) => !v)}>
              Table
            </button>
          )}
          <WidgetMenu widgetId={widgetId} widget={widget} result={result} title={title} />
        </div>
      ) : (
        <WidgetFreshness asOf={asOf} cached={result?.cached} floating />
      )}
      <div className="bi-card-body">
        <WidgetIdContext.Provider value={{ id: widgetId, widget }}>{body}</WidgetIdContext.Provider>
      </div>
    </section>
  );
});
