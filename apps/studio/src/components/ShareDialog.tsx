import type { CreateShareResponse, Share, ShareAudience } from '@yourorg/bi-spec';
import { useCallback, useEffect, useState } from 'react';
import type { StudioApi } from '../api/studioApi';
import { Modal } from './Modal';

/**
 * Share a saved dashboard read-only:
 *   - "Business viewers" get a link to the hosted viewer.
 *   - "Applications" get a token to read the dashboard JSON (and run its queries) through the API.
 * Tokens are shown once, right after creation. Existing shares can be revoked at any time.
 */

const EXPIRY = [
  [0, 'Never'],
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
  [365, '1 year'],
] as const;

function status(s: Share, now = Date.now()): 'active' | 'expired' | 'revoked' {
  if (s.revokedAt) return 'revoked';
  if (s.expiresAt && Date.parse(s.expiresAt) <= now) return 'expired';
  return 'active';
}

export function appSnippets(apiBase: string, dashboardId: string, token: string): Array<[string, string]> {
  return [
    ['Read the dashboard JSON', `curl -H "Authorization: Bearer ${token}" \\\n  ${apiBase}/v1/dashboards/${dashboardId}`],
    [
      'Run its queries (NDJSON, one line per query)',
      `curl -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \\\n  -d '{"queries": ["<queryId>"], "params": {}}' \\\n  ${apiBase}/v1/dashboards/${dashboardId}/data`,
    ],
    [
      'Parse it in your app (TypeScript)',
      `import { validateDashboard } from '@yourorg/bi-spec';\n\nconst res = await fetch('${apiBase}/v1/dashboards/${dashboardId}', {\n  headers: { Authorization: 'Bearer ' + process.env.BI_SHARE_TOKEN },\n});\nconst { spec, version } = await res.json();\nconst parsed = validateDashboard(spec); // typed widgets, queries, layout, params`,
    ],
    ['Or render it with the SDK (React)', `import { Dashboard } from '@yourorg/bi-renderer';\n\n<Dashboard id="${dashboardId}" token={shareToken} apiUrl="${apiBase}" />`],
  ];
}

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export interface ShareDialogProps {
  api: StudioApi;
  dashboardId: string;
  /** Latest saved version; shares serve saved versions only. */
  savedVersion: number;
  dirty: boolean;
  onClose: () => void;
}

export function ShareDialog({ api, dashboardId, savedVersion, dirty, onClose }: ShareDialogProps) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audience, setAudience] = useState<ShareAudience>('viewer');
  const [label, setLabel] = useState('');
  const [pin, setPin] = useState(false);
  const [expiry, setExpiry] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreateShareResponse | null>(null);
  const apiBase = new URL(api.apiUrl, location.href).href.replace(/\/+$/, '');

  const load = useCallback(() => {
    api.listShares(dashboardId).then(setShares, (e: unknown) => setError((e as Error).message));
  }, [api, dashboardId]);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createShare(dashboardId, {
        audience,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(pin ? { version: savedVersion } : {}),
        ...(expiry ? { expiresInDays: expiry } : {}),
      });
      setCreated(res);
      setLabel('');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (s: Share) => {
    if (!window.confirm(`Revoke “${s.label}”? Anyone using it loses access immediately.`)) return;
    try {
      await api.revokeShare(dashboardId, s.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Share dashboard" onClose={onClose} wide>
      {dirty && <p className="note small">You have unsaved changes. Shares show saved versions only; save to share what you see.</p>}
      {error && <p className="note small">{error}</p>}

      {created ? (
        <section className="share-created" aria-label="New share">
          <p>
            <strong>Copy this now.</strong> <span className="muted">For security it won’t be shown again; revoke and re-create it if it’s lost.</span>
          </p>
          {created.viewerUrl ? (
            <>
              <label className="field-label">
                Viewer link for business users
                <input readOnly value={created.viewerUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Viewer link" />
              </label>
              <div className="row gap-s">
                <Copy text={created.viewerUrl} label="Copy link" />
                <a className="btn small" href={created.viewerUrl} target="_blank" rel="noreferrer noopener">
                  Open
                </a>
              </div>
            </>
          ) : (
            <>
              <label className="field-label">
                Share token for applications
                <input readOnly value={created.token} onFocus={(e) => e.currentTarget.select()} aria-label="Share token" />
              </label>
              <div className="row gap-s">
                <Copy text={created.token} label="Copy token" />
              </div>
              <div className="share-snippets">
                {appSnippets(apiBase, dashboardId, created.token).map(([title, code]) => (
                  <div key={title} className="embed">
                    <span className="muted small">{title}</span>
                    <pre>
                      <code>{code}</code>
                    </pre>
                    <Copy text={code} />
                  </div>
                ))}
              </div>
            </>
          )}
          <button type="button" className="btn small" onClick={() => setCreated(null)}>
            Done
          </button>
        </section>
      ) : (
        <section className="share-form" aria-label="Create a share">
          <div className="segmented" role="radiogroup" aria-label="Share with">
            <button type="button" role="radio" aria-checked={audience === 'viewer'} aria-pressed={audience === 'viewer'} onClick={() => setAudience('viewer')}>
              Business viewers
            </button>
            <button type="button" role="radio" aria-checked={audience === 'app'} aria-pressed={audience === 'app'} onClick={() => setAudience('app')}>
              Applications (JSON)
            </button>
          </div>
          <p className="muted small">
            {audience === 'viewer'
              ? 'A link that opens this dashboard read-only in the browser. Anyone with the link can view it.'
              : 'A token an application uses to read this dashboard’s JSON and run its saved queries, to render or parse it independently.'}
          </p>
          <div className="share-fields">
            <label className="field-label">
              Label
              <input value={label} maxLength={100} placeholder={audience === 'viewer' ? 'e.g. Exec weekly review' : 'e.g. Finance portal'} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="field-label">
              Version
              <select value={pin ? 'pin' : 'latest'} onChange={(e) => setPin(e.target.value === 'pin')}>
                <option value="latest">Latest saved (follows updates)</option>
                <option value="pin">Pin v{savedVersion}</option>
              </select>
            </label>
            <label className="field-label">
              Expires
              <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} aria-label="Expires">
                {EXPIRY.map(([d, l]) => (
                  <option key={d} value={d}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" className="btn primary" onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : audience === 'viewer' ? 'Create viewer link' : 'Create app token'}
          </button>
        </section>
      )}

      <section className="share-list" aria-label="Existing shares">
        <h3 className="panel-label">Existing shares</h3>
        {!shares && !error && <p className="muted small">Loading…</p>}
        {shares?.length === 0 && <p className="muted small">Not shared yet.</p>}
        {shares && shares.length > 0 && (
          <ul>
            {shares.map((s) => {
              const st = status(s);
              return (
                <li key={s.id} data-status={st}>
                  <div>
                    <strong>{s.label}</strong>
                    <span className="muted small">
                      {s.audience === 'viewer' ? 'Viewer link' : 'App token'} · {s.version ? `pinned v${s.version}` : 'latest'} · by {s.createdBy}{' '}
                      {new Date(s.createdAt).toLocaleDateString()}
                      {s.expiresAt && st === 'active' ? ` · expires ${new Date(s.expiresAt).toLocaleDateString()}` : ''}
                      {s.lastUsedAt ? ` · last used ${new Date(s.lastUsedAt).toLocaleString()}` : ' · never used'}
                    </span>
                  </div>
                  {st === 'active' ? (
                    <button type="button" className="btn small danger" onClick={() => void revoke(s)}>
                      Revoke
                    </button>
                  ) : (
                    <span className="muted small">{st}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Modal>
  );
}
