import { DashboardView, type DataClient } from '@yourorg/bi-renderer';
import { GRID_COLUMNS, layoutItemTab, stableStringify, type DashboardTab, type LayoutItem, type ValidDashboard } from '@yourorg/bi-spec';
import { memo, useMemo, useRef, useState, type DragEvent } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { hasErrors, type LocatedIssue } from '../draft/issues';
import { sameLayout } from '../draft/layout';
import { singleWidgetDashboard, type Renderable } from '../draft/renderable';
import type { DraftSpec } from '../draft/types';
import { widgetTypeInfo, widgetTypes } from '../draft/widgetTypes';
import { isFieldDrag, readFieldDrag, type FieldDrag } from './dnd';
import { WidgetTypeIcon } from './icons';

// Same grid metrics as the renderer's layout engine (ROW_HEIGHT 72, GAP 16, 12 columns, no outer
// padding), so a widget occupies exactly the same box here as in a host app.
export const ROW_HEIGHT = 72;
export const GAP = 16;

const Grid = WidthProvider(GridLayout);

export interface CanvasProps {
  draft: DraftSpec;
  renderable: Renderable;
  issues: Map<string, LocatedIssue[]>;
  client: DataClient;
  params: Record<string, unknown>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onLayout: (layout: LayoutItem[]) => void;
  onAddWidget: (type: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onTidy: () => void;
  onFieldDropOnWidget: (widgetId: string, drag: FieldDrag) => void;
  onFieldDropOnCanvas: (drag: FieldDrag, at: { x: number; y: number }) => void;
}

/** One canvas cell: the renderer's own DashboardView drawing a one-widget dashboard. */
const LiveWidget = memo(function LiveWidget({ dashboard, client, params }: { dashboard: ValidDashboard; client: DataClient; params: Record<string, unknown> }) {
  return <DashboardView dashboard={dashboard} version={0} client={client} params={params} showHeader={false} className="cell-render" ignoreVisibility />;
});

function Blocked({ type, message }: { type: string; message?: string }) {
  const info = widgetTypeInfo(type);
  return (
    <div className="cell-blocked">
      <WidgetTypeIcon type={type} />
      <strong>{info?.label ?? type}</strong>
      <span>{message ?? 'Needs configuring'}</span>
      <span className="muted small">Drop fields here or use the inspector.</span>
    </div>
  );
}

/** Keeps each cell's one-widget dashboard referentially stable while its content is unchanged. */
function useCellDashboards(renderable: Renderable, layout: LayoutItem[]) {
  const cache = useRef(new Map<string, { key: string; dashboard: ValidDashboard }>());
  return useMemo(() => {
    const out = new Map<string, ValidDashboard>();
    const dash = renderable.dashboard;
    if (!dash) return out;
    for (const item of layout) {
      if (!renderable.ok.has(item.i)) continue;
      const next = singleWidgetDashboard(dash, item.i, item.h);
      const key = stableStringify(next);
      const hit = cache.current.get(item.i);
      if (hit && hit.key === key) out.set(item.i, hit.dashboard);
      else {
        cache.current.set(item.i, { key, dashboard: next });
        out.set(item.i, next);
      }
    }
    return out;
  }, [renderable, layout]);
}

export function Canvas(props: CanvasProps) {
  const { draft, renderable, issues, selected } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const cells = useCellDashboards(renderable, draft.layout);
  // Tabs (spec 1.3): the canvas shows one tab at a time; items without a tab are on the first one.
  const tabs = (draft as DraftSpec & { tabs?: DashboardTab[] }).tabs;
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);
  const currentTab = tabs?.some((t) => t.id === activeTab) ? activeTab : tabs?.[0]?.id;
  const placed = draft.layout.filter((it) => draft.widgets[it.i] && (!tabs?.length || layoutItemTab(it, tabs) === currentTab));

  const onCanvasDragOver = (e: DragEvent) => {
    if (!isFieldDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onCanvasDrop = (e: DragEvent) => {
    const drag = readFieldDrag(e);
    const el = wrapRef.current;
    if (!drag || !el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const colWidth = (rect.width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    const x = Math.max(0, Math.min(GRID_COLUMNS - 1, Math.floor((e.clientX - rect.left) / (colWidth + GAP))));
    const y = Math.max(0, Math.floor((e.clientY - rect.top) / (ROW_HEIGHT + GAP)));
    props.onFieldDropOnCanvas(drag, { x, y });
  };

  const layout: Layout[] = placed.map((it) => ({ i: it.i, x: it.x, y: it.y, w: it.w, h: it.h }));

  return (
    <div className="canvas-area">
      <div className="canvas-toolbar" role="toolbar" aria-label="Add widget">
        <span className="panel-label">Add</span>
        {widgetTypes().map((t) => (
          <button key={t.type} type="button" className="btn palette-btn" onClick={() => props.onAddWidget(t.type)} title={`Add a ${t.label} widget (spec ${t.since}+)`}>
            <WidgetTypeIcon type={t.type} />
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <button type="button" className="btn ghost small" onClick={props.onTidy} disabled={!placed.length} title="Move every widget up to close gaps">
          Tidy layout
        </button>
      </div>
      {tabs?.length ? (
        <div className="canvas-tabs" role="tablist" aria-label="Dashboard tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="btn ghost small" aria-selected={t.id === currentTab} onClick={() => setActiveTab(t.id)}>
              {t.title}
            </button>
          ))}
          <span className="muted small">Move widgets between tabs in the dashboard inspector.</span>
        </div>
      ) : null}
      <div
        className="canvas-scroll"
        onMouseDown={(e) => {
          const t = e.target as HTMLElement;
          if (t === e.currentTarget || t.classList.contains('canvas-grid') || t.classList.contains('react-grid-layout')) props.onSelect(null);
        }}
      >
        <div ref={wrapRef} className="canvas-grid" onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}>
          {placed.length === 0 && (
            <div className="canvas-empty">
              <strong>Start building</strong>
              <span>Add a widget from the toolbar, drag a field here, or ask for a suggested dashboard.</span>
            </div>
          )}
          <Grid
            className="react-grid-layout"
            layout={layout}
            cols={GRID_COLUMNS}
            rowHeight={ROW_HEIGHT}
            margin={[GAP, GAP]}
            containerPadding={[0, 0]}
            compactType={null}
            preventCollision={false}
            resizeHandles={['se']}
            draggableCancel=".cell-actions, .bi-pager, button, input, select, textarea"
            onLayoutChange={(next) => {
              const items = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
              if (!sameLayout(placed, items)) props.onLayout(items);
            }}
            onDragStart={(_l, item) => props.onSelect(item.i)}
            onResizeStart={(_l, item) => props.onSelect(item.i)}
          >
            {placed.map((item) => {
              const widget = draft.widgets[item.i]!;
              const cellIssues = issues.get(item.i) ?? [];
              const errorCount = cellIssues.filter((i) => i.severity === 'error').length;
              const warnCount = cellIssues.length - errorCount;
              const dashboard = cells.get(item.i);
              const blocked = renderable.blocked.get(item.i);
              const firstError = cellIssues.find((i) => i.severity === 'error')?.message ?? blocked?.[0]?.message;
              return (
                <div
                  key={item.i}
                  className="canvas-cell"
                  data-selected={selected === item.i || undefined}
                  data-invalid={hasErrors(cellIssues) || undefined}
                  data-drop={dropTarget === item.i || undefined}
                  onMouseDown={() => props.onSelect(item.i)}
                  onDragOver={(e) => {
                    if (!isFieldDrag(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'copy';
                    setDropTarget(item.i);
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === item.i ? null : t))}
                  onDrop={(e) => {
                    const drag = readFieldDrag(e);
                    setDropTarget(null);
                    if (!drag) return;
                    e.preventDefault();
                    e.stopPropagation();
                    props.onFieldDropOnWidget(item.i, drag);
                  }}
                  aria-label={`Widget ${item.i}`}
                >
                  {dashboard ? <LiveWidget dashboard={dashboard} client={props.client} params={props.params} /> : <Blocked type={widget.type} message={firstError} />}
                  <div className="cell-actions">
                    {(errorCount > 0 || warnCount > 0) && (
                      <span className="cell-badge" data-severity={errorCount ? 'error' : 'warning'} title={cellIssues.map((i) => i.message).join('\n')}>
                        {errorCount ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : `${warnCount} warning${warnCount > 1 ? 's' : ''}`}
                      </span>
                    )}
                    <span className="cell-id">{item.i}</span>
                    <button type="button" className="btn ghost icon tiny" onClick={() => props.onDuplicate(item.i)} title="Duplicate (shares the query)" aria-label={`Duplicate ${item.i}`}>
                      ⧉
                    </button>
                    <button type="button" className="btn ghost icon tiny" onClick={() => props.onRemove(item.i)} title="Delete widget" aria-label={`Delete ${item.i}`}>
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </Grid>
        </div>
      </div>
    </div>
  );
}
