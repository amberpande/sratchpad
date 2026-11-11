import { BIProvider, Dashboard } from '@yourorg/bi-renderer';
import { createRoot } from 'react-dom/client';
import './portal.css';

/** A token getter: the SDK calls it before each request, so refreshed tokens just work. */
async function getToken(): Promise<string> {
  return import.meta.env.VITE_BI_TOKEN ?? 'dev-token-team-a';
}

function Portal() {
  return (
    <>
      <header className="portal-top">
        <strong>Sales Portal</strong>
        <nav>
          <span>Accounts</span>
          <span>Pipeline</span>
          <span className="on">Reports</span>
        </nav>
      </header>
      <section className="portal-body">
        <h1>Reports</h1>
        <p className="portal-lede">Embedded from Sratchpad. Nothing about this dashboard is compiled into this app.</p>
        <div className="portal-frame">
          <Dashboard id="dash_9f2a" token={getToken} />
        </div>
      </section>
    </>
  );
}

// App-wide SDK config lives in one provider; this host mounts the API under /analytics.
createRoot(document.getElementById('app')!).render(
  <BIProvider apiUrl="/analytics">
    <Portal />
  </BIProvider>,
);
