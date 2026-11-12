import { stableStringify } from '@yourorg/bi-spec';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { isRouteMissing, type AssistantMessage, type StudioApi } from '../api/studioApi';
import { coerceDraft } from '../draft/json';
import type { DraftSpec } from '../draft/types';

/**
 * Chat with the dashboard assistant. Each answer that changes the dashboard is applied to the draft
 * as one undo step; nothing is saved until the developer saves. The assistant can only express what
 * the spec can (it says so when asked for something unsupported).
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  changes?: string[];
  error?: boolean;
  /** This answer changed the draft and is still the latest change (can be undone). */
  undoable?: boolean;
}

const EXAMPLES = [
  'Add KPIs for total revenue and orders across the top',
  'Show revenue by month as a line chart',
  'Give it a dark navy theme with teal accents',
  'Turn on data labels and remove gridlines on the bar charts',
  'Make this chart full width and highlight it',
];

export interface AssistantPanelProps {
  api: StudioApi;
  draft: DraftSpec;
  selected: string | null;
  /** Apply a new draft as one undo step. */
  onApply: (draft: DraftSpec) => void;
  onUndo: () => void;
}

type Status = { state: 'checking' } | { state: 'ready'; model?: string } | { state: 'off'; message: string };

export function AssistantPanel({ api, draft, selected, onApply, onUndo }: AssistantPanelProps) {
  const [status, setStatus] = useState<Status>({ state: 'checking' });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.assistantStatus().then(
      (s) => !cancelled && setStatus(s.enabled ? { state: 'ready', model: s.model } : { state: 'off', message: 'The assistant isn’t enabled on this server. An admin can turn it on (ANTHROPIC_API_KEY, BI_ASSISTANT).' }),
      (error: unknown) =>
        !cancelled &&
        setStatus({ state: 'off', message: isRouteMissing(error) ? 'This server doesn’t have the assistant yet.' : `Couldn’t reach the assistant: ${(error as Error).message}` }),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Block body on purpose: an effect must return nothing or a cleanup function, and Chrome's
  // scrollIntoView now returns a Promise (returning it crashed the whole Studio).
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns, busy]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy || status.state !== 'ready') return;
    const history: AssistantMessage[] = [...turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })), { role: 'user' as const, content }].slice(-20);
    if (history[0]?.role === 'assistant') history.shift();
    setTurns((t) => [...t.map((x) => ({ ...x, undoable: false })), { role: 'user', content }]);
    setInput('');
    setBusy(true);
    const sent = stableStringify(draft);
    try {
      const res = await api.assistantChat({ draft, messages: history, ...(selected ? { selectedWidgetId: selected } : {}) });
      let note = '';
      let applied = false;
      if (res.changed) {
        const coerced = coerceDraft(res.draft);
        if (!coerced.ok) note = ' (I couldn’t apply the result: it wasn’t a usable dashboard.)';
        else if (stableStringify(latestDraft.current) !== sent) note = ' You edited the dashboard while I was working, so I didn’t apply this. Send your request again.';
        else {
          onApply(coerced.draft);
          applied = true;
        }
      }
      setTurns((t) => [...t, { role: 'assistant', content: res.reply + note, changes: applied ? res.changes : undefined, undoable: applied }]);
    } catch (error) {
      setTurns((t) => [...t, { role: 'assistant', content: (error as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  if (status.state === 'checking') return <p className="muted small assistant-note">Connecting…</p>;
  if (status.state === 'off') return <p className="note small assistant-note">{status.message}</p>;

  return (
    <div className="assistant">
      <div className="assistant-log" aria-live="polite">
        {turns.length === 0 && (
          <div className="assistant-empty">
            <p className="muted small">Ask for charts, layout or styling changes. I edit your draft; you review and save. {selected ? <>“This chart” means <code>{selected}</code>.</> : null}</p>
            <ul>
              {EXAMPLES.map((ex) => (
                <li key={ex}>
                  <button type="button" className="btn small ghost" onClick={() => void send(ex)}>
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`assistant-turn ${t.role}`} data-error={t.error || undefined}>
            <p>{t.content}</p>
            {t.changes && t.changes.length > 0 && (
              <ul className="assistant-changes">
                {t.changes.map((c, j) => (
                  <li key={j}>{c}</li>
                ))}
              </ul>
            )}
            {t.undoable && (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  onUndo();
                  setTurns((all) => all.map((x, k) => (k === i ? { ...x, undoable: false, content: `${x.content} (undone)` } : x)));
                }}
              >
                Undo this change
              </button>
            )}
          </div>
        ))}
        {busy && <p className="muted small assistant-busy">Working on it…</p>}
        <div ref={endRef} />
      </div>
      <form className="assistant-input" onSubmit={onSubmit}>
        <textarea
          aria-label="Message the assistant"
          placeholder={selected ? `Ask about ${selected} or the whole dashboard…` : 'Describe a change…'}
          value={input}
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
        />
        <button type="submit" className="btn primary small" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
