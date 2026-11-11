import type { LocatedIssue } from '../draft/issues';

export function IssueText({ issues }: { issues: LocatedIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="issue-inline">
      {issues.map((i, n) => (
        <li key={n} data-severity={i.severity}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function IssueList({ issues, onSelect }: { issues: LocatedIssue[]; onSelect?: (issue: LocatedIssue) => void }) {
  if (!issues.length) return <p className="muted">No problems. The dashboard is valid.</p>;
  return (
    <ul className="issue-list">
      {issues.map((i, n) => (
        <li key={n} data-severity={i.severity}>
          <button type="button" onClick={() => onSelect?.(i)}>
            <span className="issue-dot" aria-label={i.severity} />
            <span>
              <code>{i.path || '(document)'}</code>
              <span>{i.message}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
