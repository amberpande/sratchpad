import { completeSignIn, currentSession, freshToken, loadAuthInfo, startSignIn, type AuthInfo, type OidcClientConfig } from '@yourorg/bi-auth-client';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Viewer } from './Viewer';
import './viewer.css';

const API_URL = import.meta.env.VITE_BI_API_URL ?? '/bi-api';

type Gate = { status: 'loading' } | { status: 'open' } | { status: 'signin'; cfg: OidcClientConfig; error?: string } | { status: 'signed-in'; cfg: OidcClientConfig };

/**
 * BI_VIEWER_LOGIN=on (D-075): a viewer link also needs a company sign-in from the share's team. The
 * viewer's ID token goes in X-BI-User next to the share token; without it the API answers 401.
 */
function useViewerGate(): Gate {
  const [gate, setGate] = useState<Gate>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info: AuthInfo = await loadAuthInfo(API_URL);
      if (info.mode !== 'oidc' || !info.viewerLogin) return !cancelled && setGate({ status: 'open' });
      const cfg: OidcClientConfig = { issuer: info.issuer, clientId: info.clientId, scopes: info.scopes, redirectUri: `${location.origin}${location.pathname}`, storageKey: 'sratchpad.viewer.sso' };
      try {
        const done = await completeSignIn(cfg);
        if (done) history.replaceState(null, '', new URL(done.returnTo, location.href).toString());
      } catch (err) {
        return !cancelled && setGate({ status: 'signin', cfg, error: (err as Error).message });
      }
      if (cancelled) return;
      setGate(currentSession(cfg) ? { status: 'signed-in', cfg } : { status: 'signin', cfg });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return gate;
}

function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const gate = useViewerGate();
  const fetchWithUser = useMemo<typeof fetch | undefined>(() => {
    if (gate.status !== 'signed-in') return undefined;
    return async (input, init) => {
      const user = await freshToken(gate.cfg);
      const headers = new Headers(init?.headers);
      if (user) headers.set('X-BI-User', `Bearer ${user}`);
      return globalThis.fetch(input, { ...init, headers });
    };
  }, [gate]);
  if (gate.status === 'loading') return <div className="viewer-state muted">Loading…</div>;
  if (gate.status === 'signin') {
    return (
      <div className="viewer-state">
        <h1>Sign in to view this dashboard</h1>
        {gate.error && <p role="alert">{gate.error}</p>}
        <button type="button" onClick={() => void startSignIn(gate.cfg)}>
          Sign in with your company account
        </button>
      </div>
    );
  }
  return <Viewer hash={hash} apiUrl={API_URL} fetch={fetchWithUser} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
