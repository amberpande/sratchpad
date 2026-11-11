import { useState, type ReactNode } from 'react';
import type { IssueIndex, LocatedIssue } from '../draft/issues';
import type { DraftSpec } from '../draft/types';
import type { Dispatch } from '../hooks/useDraftHistory';
import { IssueList } from './IssueList';
import { ParamControls } from './ParamControls';

export interface TopBarProps {
  draft: DraftSpec;
  dispatch: Dispatch;
  issues: IssueIndex;
  status: string;
  dirty: boolean;
  saving: boolean;
  view: 'canvas' | 'json';
  onView: (v: 'canvas' | 'json') => void;
  onSave: () => void;
  onBack: () => void;
  onHistory: () => void;
  canHistory: boolean;
  onShare: () => void;
  /** Extra actions next to History/Share (platform features). */
  extraActions?: ReactNode;
  undo: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
  paramValues: Record<string, unknown>;
  onParam: (name: string, value: unknown) => void;
  onSelectIssue: (issue: LocatedIssue) => void;
}

export function TopBar(props: TopBarProps) {
  const { issues, draft } = props;
  const [showIssues, setShowIssues] = useState(false);
  const errors = issues.errors.length;
  const warnings = issues.warnings.length;
  const blocked = errors > 0;

  return (
    <header className="topbar">
      <button type="button" className="btn ghost small" onClick={props.onBack} title="All dashboards">
        ← Dashboards
      </button>
      <input
        className="title-input"
        value={draft.title ?? ''}
        placeholder="Untitled dashboard"
        aria-label="Dashboard title"
        onChange={(e) => props.dispatch({ type: 'setMeta', title: e.target.value }, 'meta:title')}
      />
      <span className="status" data-dirty={props.dirty || undefined}>
        {props.status}
      </span>

      <ParamControls draft={draft} values={props.paramValues} onChange={props.onParam} />

      <span className="spacer" />

      <div className="issues-anchor">
        <button
          type="button"
          className="issue-chip"
          data-severity={errors ? 'error' : warnings ? 'warning' : 'ok'}
          onClick={() => setShowIssues((s) => !s)}
          aria-expanded={showIssues}
          title="Validation runs on every change"
        >
          {errors ? `${errors} error${errors > 1 ? 's' : ''}` : 'Valid'}
          {warnings ? ` · ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}
        </button>
        {showIssues && (
          <div className="popover" role="dialog" aria-label="Validation">
            <IssueList
              issues={[...issues.errors, ...issues.warnings]}
              onSelect={(i) => {
                setShowIssues(false);
                props.onSelectIssue(i);
              }}
            />
          </div>
        )}
      </div>

      <div className="btn-group" role="group" aria-label="History">
        <button type="button" className="btn ghost icon" onClick={props.undo.undo} disabled={!props.undo.canUndo} title="Undo (⌘Z)" aria-label="Undo">
          ↶
        </button>
        <button type="button" className="btn ghost icon" onClick={props.undo.redo} disabled={!props.undo.canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
          ↷
        </button>
      </div>

      <div className="segmented" role="group" aria-label="View">
        <button type="button" aria-pressed={props.view === 'canvas'} onClick={() => props.onView('canvas')}>
          Canvas
        </button>
        <button type="button" aria-pressed={props.view === 'json'} onClick={() => props.onView('json')}>
          JSON
        </button>
      </div>

      <button type="button" className="btn ghost small" onClick={props.onHistory} disabled={!props.canHistory} title={props.canHistory ? 'Version history' : 'Save first to start a history'}>
        History
      </button>
      {props.extraActions}
      <button type="button" className="btn ghost small" onClick={props.onShare} disabled={!props.canHistory} title={props.canHistory ? 'Share read-only with viewers or applications' : 'Save first: shares show saved versions'}>
        Share
      </button>
      <button
        type="button"
        className="btn primary"
        onClick={props.onSave}
        disabled={blocked || props.saving || !props.dirty}
        title={blocked ? 'Fix the errors before saving' : props.dirty ? 'Save a new version (⌘S)' : 'No unsaved changes'}
      >
        {props.saving ? 'Saving…' : 'Save'}
      </button>
    </header>
  );
}
