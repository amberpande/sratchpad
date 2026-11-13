import { useEffect, useState } from 'react';
import type { DashboardSummary, StudioApi } from '../api/studioApi';
import { dashboardIdFromTitle, isValidId } from '../draft/ids';
import { Modal } from './Modal';
import './platform/platform.css';

function NewDashboard({ existing, onCreate, onClose }: { existing: Set<string>; onCreate: (id: string, title: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const effectiveId = idTouched ? id : dashboardIdFromTitle(title || 'untitled');
  const problem = !title.trim()
    ? 'Give it a title.'
    : !isValidId(effectiveId)
      ? 'Ids start with a letter and use letters, digits, "_" or "-" (max 64).'
      : existing.has(effectiveId)
        ? `"${effectiveId}" is taken.`
        : null;
  return (
    <Modal title="New dashboard" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) onCreate(effectiveId, title.trim());
        }}
      >
        <label className="field-label">
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sales overview" />
        </label>
        <label className="field-label">
          Id <span className="muted small">(used by host apps: &lt;Dashboard id=… /&gt;; can’t change later)</span>
          <input
            value={effectiveId}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value);
            }}
            spellCheck={false}
          />
        </label>
        {problem && title && <p className="issue-inline-block">{problem}</p>}
        <div className="row gap-s end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={Boolean(problem)}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

type SortKey = 'updated' | 'recent' | 'views' | 'name';

export function DashboardList({ api, onOpen, onCreate }: { api: StudioApi; onOpen: (id: string) => void; onCreate: (id: string, title: string) => void }) {
  const [list, setList] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [favorites, setFavorites] = useState<Set<string> | null>(null);
  const [usage, setUsage] = useState<Map<string, { views: number; mine?: string }>>(new Map());
  const [sort, setSort] = useState<SortKey>('updated');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  useEffect(() => {
    api.listDashboards().then(
      (d) => setList([...d].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
      (e: unknown) => setError((e as Error).message),
    );
    // Favorites and usage are optional (older servers don't have them): failures just hide them.
    api.favorites().then((f) => setFavorites(new Set(f)), () => setFavorites(null));
    api.usage(30).then(
      (u) => setUsage(new Map(u.dashboards.map((d) => [d.dashboardId, { views: d.views, mine: d.myLastViewedAt }]))),
      () => {},
    );
  }, [api]);

  const toggleFavorite = (id: string) => {
    if (!favorites) return;
    const on = !favorites.has(id);
    const next = new Set(favorites);
    if (on) next.add(id);
    else next.delete(id);
    setFavorites(next);
    api.setFavorite(id, on).catch(() => setFavorites(favorites));
  };

  const shown = (list ?? [])
    .filter((d) => !onlyFavorites || favorites?.has(d.id))
    .sort((a, b) => {
      // Favorites first, then the chosen order.
      const fa = favorites?.has(a.id) ? 0 : 1;
      const fb = favorites?.has(b.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (sort === 'name') return a.title.localeCompare(b.title);
      if (sort === 'views') return (usage.get(b.id)?.views ?? 0) - (usage.get(a.id)?.views ?? 0) || a.title.localeCompare(b.title);
      if (sort === 'recent') return (usage.get(b.id)?.mine ?? '').localeCompare(usage.get(a.id)?.mine ?? '') || b.updatedAt.localeCompare(a.updatedAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  return (
    <div className="list-page">
      <header className="list-head">
        <div>
          <h1>Studio</h1>
          <p className="muted">Build dashboards by dragging fields onto a canvas. Every dashboard saves as versioned JSON that any host app renders.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          New dashboard
        </button>
      </header>
      {error && <p className="banner" data-tone="error">Couldn’t load dashboards: {error}</p>}
      {!list && !error && <p className="muted">Loading…</p>}
      {list && list.length === 0 && <p className="muted">No dashboards yet. Create one to get started.</p>}
      {list && list.length > 0 && (
        <div className="list-tools">
          <label className="small">
            Sort{' '}
            <select aria-label="Sort dashboards" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="updated">Recently updated</option>
              <option value="recent">Recently viewed by me</option>
              <option value="views">Most viewed (30 days)</option>
              <option value="name">Name</option>
            </select>
          </label>
          {favorites && (
            <label className="small row gap-s">
              <input type="checkbox" checked={onlyFavorites} onChange={(e) => setOnlyFavorites(e.target.checked)} /> Favorites only
            </label>
          )}
        </div>
      )}
      {list && list.length > 0 && (
        <ul className="dash-list">
          {shown.map((d) => {
            const views = usage.get(d.id)?.views;
            const fav = favorites?.has(d.id) ?? false;
            return (
              <li key={d.id} className="dash-row">
                <button type="button" className="dash-open" onClick={() => onOpen(d.id)}>
                  <strong>{d.title}</strong>
                  <span className="muted small">
                    <code>{d.id}</code> · v{d.latestVersion} · updated {new Date(d.updatedAt).toLocaleString()}
                    {views !== undefined ? ` · ${views} view${views === 1 ? '' : 's'} (30 days)` : ''}
                  </span>
                </button>
                {favorites && (
                  <button type="button" className="star" aria-pressed={fav} aria-label={fav ? `Remove ${d.title} from favorites` : `Add ${d.title} to favorites`} onClick={() => toggleFavorite(d.id)}>
                    {fav ? '★' : '☆'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {creating && <NewDashboard existing={new Set(list?.map((d) => d.id))} onClose={() => setCreating(false)} onCreate={onCreate} />}
    </div>
  );
}
