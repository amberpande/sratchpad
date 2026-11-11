import { useEffect, useState } from 'react';
import type { StudioApi, VersionSummary } from '../api/studioApi';
import { Modal } from './Modal';

export function HistoryPanel({ api, id, current, onOpen, onClose }: { api: StudioApi; id: string; current: number | null; onOpen: (version: number, latest: number) => void; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listVersions(id).then(
      (v) => setVersions([...v].sort((a, b) => b.version - a.version)),
      (e: unknown) => setError((e as Error).message),
    );
  }, [api, id]);
  const latest = versions?.[0]?.version ?? 0;
  return (
    <Modal title="Version history" onClose={onClose}>
      {error && <p className="note">{error}</p>}
      {!versions && !error && <p className="muted">Loading…</p>}
      {versions && versions.length === 0 && <p className="muted">Not saved yet.</p>}
      {versions && (
        <ol className="version-list">
          {versions.map((v) => (
            <li key={v.version} data-current={v.version === current || undefined}>
              <div>
                <strong>v{v.version}</strong> {v.title}
                <span className="muted small">
                  {new Date(v.createdAt).toLocaleString()} · {v.createdBy} · spec {v.specVersion}
                </span>
              </div>
              {v.version === current ? (
                <span className="muted small">open</span>
              ) : (
                <button type="button" className="btn small" onClick={() => onOpen(v.version, latest)}>
                  Open{v.version === latest ? ' latest' : ''}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">Opening an older version loads it as a draft. Saving it creates a new version on top of the latest; nothing is overwritten.</p>
    </Modal>
  );
}
