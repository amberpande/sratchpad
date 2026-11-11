import { Dashboard } from '@yourorg/bi-renderer';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// In a real app this comes from the host's own login (OIDC). Dev token maps to team-a.
const authToken = import.meta.env.VITE_BI_TOKEN ?? 'dev-token-team-a';

const RANGES = [
  ['last_30d', 'Last 30 days'],
  ['last_90d', 'Last 90 days'],
  ['last_365d', 'Last 12 months'],
  ['ytd', 'Year to date'],
  ['all', 'All time'],
] as const;

function App() {
  // The host owns the control; the dashboard only receives the param value.
  const [dateRange, setDateRange] = useState<string>(new URLSearchParams(location.search).get('range') ?? 'last_365d');
  return (
    <div className="ops-shell">
      <aside className="ops-sidebar">
        <div className="ops-brand">Ops Console</div>
        <nav>
          <a className="active">Revenue</a>
          <a>Fulfilment</a>
          <a>Incidents</a>
          <a>Settings</a>
        </nav>
      </aside>
      <main className="ops-main">
        <div className="ops-toolbar">
          <span className="ops-crumb">Revenue / Overview</span>
          <label>
            Range{' '}
            <select value={dateRange} onChange={(e) => setDateRange(e.target.value)}>
              {RANGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {/* The whole embed: one component, a dashboard id and an auth token. */}
        <Dashboard id="dash_9f2a" token={authToken} params={{ dateRange }} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
