import { stableStringify } from '@yourorg/bi-spec';
import { useEffect, useState } from 'react';
import type { IssueIndex } from '../draft/issues';
import { draftToJson, parseDraftJson } from '../draft/json';
import type { DraftSpec } from '../draft/types';
import type { Dispatch } from '../hooks/useDraftHistory';
import { IssueList } from './IssueList';

/**
 * Raw JSON, two-way with the canvas: valid JSON edits apply immediately (validation errors still
 * show inline); unparseable text is kept here until it parses, without touching the draft.
 */
export function JsonView({ draft, dispatch, issues }: { draft: DraftSpec; dispatch: Dispatch; issues: IssueIndex }) {
  const [text, setText] = useState(() => draftToJson(draft));
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    // Canvas edits (or undo) replace the text, unless it already says the same thing.
    const parsed = parseDraftJson(text);
    if (!parsed.ok || stableStringify(parsed.draft) !== stableStringify(draft)) {
      if (parsed.ok || !parseError) {
        setText(draftToJson(draft));
        setParseError(null);
      }
    }
    // Only react to draft changes; text changes are handled in onChange.
  }, [draft]);

  return (
    <div className="json-view">
      <div className="json-toolbar">
        <span className="panel-label">Dashboard JSON</span>
        <span className="muted small">Edits apply as you type. This is exactly what Save stores.</span>
        <span className="spacer" />
        <button type="button" className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(draftToJson(draft))}>
          Copy
        </button>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            setText(draftToJson(draft));
            setParseError(null);
          }}
        >
          Format
        </button>
      </div>
      <textarea
        className="json-text"
        spellCheck={false}
        value={text}
        aria-label="Dashboard JSON"
        aria-invalid={Boolean(parseError)}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const parsed = parseDraftJson(next);
          if (parsed.ok) {
            setParseError(null);
            dispatch({ type: 'replace', draft: parsed.draft }, 'json');
          } else setParseError(parsed.message);
        }}
      />
      <div className="json-issues">
        {parseError ? <p className="issue-inline-block">{parseError} The canvas keeps the last valid JSON.</p> : <IssueList issues={[...issues.errors, ...issues.warnings]} />}
      </div>
    </div>
  );
}
