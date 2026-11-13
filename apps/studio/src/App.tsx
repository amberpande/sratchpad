import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { completeSignIn, currentSession, freshToken, loadAuthInfo, signOut as ssoSignOut, startSignIn, type AuthInfo, type OidcClientConfig } from '@yourorg/bi-auth-client';
import { API_URL, ApiError, StudioApi, TOKEN } from './api/studioApi';
import type { SavedRef } from './api/previewClient';
import { DashboardList } from './components/DashboardList';
import { Studio } from './components/Studio';
import { coerceDraft, emptyDraft } from './draft/json';
import type { DraftSpec } from './draft/types';

type Route = { name: 'list' } | { name: 'edit'; id: string };

function parseHash(): Route {
  const m = /^#\/d\/([^/?]+)/.exec(location.hash);
  return m ? { name: 'edit', id: decodeURIComponent(m[1]!) } : { name: 'list' };
}

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [route, (hash) => (location.hash = hash)];
}

type Loaded = { status: 'loading' } | { status: 'error'; message: string; notFound?: boolean } | { status: 'ready'; draft: DraftSpec; saved: SavedRef | null; latest: number };

function Editor({ api, id, pendingNew, onExit }: { api: StudioApi; id: string; pendingNew: { id: string; title: string } | null; onExit: () => void }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.getDashboard(id).then(
      (stored) => {
        if (cancelled) return;
        const coerced = coerceDraft(stored.spec);
        if (!coerced.ok) setState({ status: 'error', message: `Stored spec can’t be edited: ${coerced.message}` });
        else setState({ status: 'ready', draft: coerced.draft, saved: { id: stored.id, version: stored.version, spec: stored.spec }, latest: stored.version });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          if (pendingNew?.id === id) setState({ status: 'ready', draft: emptyDraft(id, pendingNew.title), saved: null, latest: 0 });
          else setState({ status: 'error', message: `Dashboard "${id}" was not found.`, notFound: true });
        } else setState({ status: 'error', message: (error as Error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, pendingNew]);

  if (state.status === 'loading') return <div className="center-message muted">Loading {id}…</div>;
  if (state.status === 'error') {
    return (
      <div className="center-message">
        <p>{state.message}</p>
        <div className="row gap-s">
          <button type="button" className="btn" onClick={onExit}>
            Back to dashboards
          </button>
          {state.notFound && (
            <button type="button" className="btn primary" onClick={() => setState({ status: 'ready', draft: emptyDraft(id, 'Untitled dashboard'), saved: null, latest: 0 })}>
              Create “{id}”
            </button>
          )}
        </div>
      </div>
    );
  }
  return <Studio key={id} api={api} draft={state.draft} saved={state.saved} latestVersion={state.latest} onExit={onExit} />;
}

const TOKEN_KEY = 'sratchpad.token';

function storedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? TOKEN;
  } catch {
    return TOKEN;
  }
}

/** A token the user pasted in this tab (not the build's default). */
function explicitToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token lives only in memory */
  }
}

/**
 * Stopgap sign-in until SSO: paste the access token an admin issued (an entry in BI_TOKENS). It is
 * checked against the API and kept for this browser tab only (sessionStorage), never in a cookie.
 */
function SignIn({ onSignedIn, expired }: { onSignedIn: (token: string) => void; expired: boolean }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await new StudioApi({ token }).listDashboards();
      onSignedIn(token);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That token isn’t valid.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-message">
      <form className="signin" onSubmit={(e) => void submit(e)}>
        <h1>Sratchpad Studio</h1>
        {expired && <p className="note small">Your session ended. Sign in again.</p>}
        <label className="field-label">
          Access token
          <input type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Access token" autoFocus />
        </label>
        {error && <p className="note small">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <p className="muted small">Ask your Sratchpad admin for a token. It stays in this tab only.</p>
      </form>
    </div>
  );
}

/** Browser sign-in settings for SSO; the redirect comes back to this page (register it with the provider). */
function ssoConfig(info: Extract<AuthInfo, { mode: 'oidc' }>): OidcClientConfig {
  return { issuer: info.issuer, clientId: info.clientId, scopes: info.scopes, redirectUri: `${location.origin}${location.pathname}`, storageKey: 'sratchpad.studio.sso' };
}

/** Single sign-on (D-074): "Sign in with your company account"; access tokens stay available for service accounts. */
function SsoSignIn({ cfg, expired, error, onToken }: { cfg: OidcClientConfig; expired: boolean; error: string | null; onToken: (token: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(error);
  return (
    <div className="center-message">
      <div className="signin">
        <h1>Sratchpad Studio</h1>
        {expired && <p className="note small">Your session ended. Sign in again.</p>}
        {problem && <p className="note small" role="alert">{problem}</p>}
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            startSignIn(cfg).catch((err: Error) => {
              setBusy(false);
              setProblem(err.message);
            });
          }}
        >
          {busy ? 'Redirecting…' : 'Sign in with your company account'}
        </button>
        <details>
          <summary className="small muted">Use an access token instead</summary>
          <SignIn expired={false} onSignedIn={onToken} />
        </details>
      </div>
    </div>
  );
}

export function App() {
  const [info, setInfo] = useState<AuthInfo | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [token, setToken] = useState(storedToken);
  const [expired, setExpired] = useState(false);
  const cfg = useMemo(() => (info?.mode === 'oidc' ? ssoConfig(info) : null), [info]);

  // Learn how to sign in; finish an SSO callback (?code=…&state=…) if this load is one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadAuthInfo(API_URL);
      if (cancelled) return;
      if (loaded.mode === 'oidc') {
        const c = ssoConfig(loaded);
        try {
          const done = await completeSignIn(c);
          if (done) {
            history.replaceState(null, '', new URL(done.returnTo, location.href).toString().replace(location.search, ''));
            if (!cancelled) setToken(done.session.idToken);
          } else {
            // With SSO, the built-in dev token is not a sign-in: only a pasted token or an SSO session is.
            const pasted = explicitToken();
            const s = currentSession(c);
            if (!cancelled) setToken(pasted ?? s?.idToken ?? '');
          }
        } catch (err) {
          history.replaceState(null, '', `${location.origin}${location.pathname}${location.hash}`);
          if (!cancelled) setSsoError((err as Error).message);
        }
      }
      if (!cancelled) setInfo(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(() => {
    storeToken(null);
    setToken('');
    setExpired(true);
  }, []);
  // SSO: every request carries a fresh ID token (renewed with the refresh token near expiry).
  // Any 401 (expired or revoked) sends the user back to sign-in.
  const api = useMemo(
    () =>
      new StudioApi({
        token,
        fetch: async (input, init) => {
          let next = init;
          const usingSso = cfg && currentSession(cfg)?.idToken === token;
          if (usingSso) {
            const fresh = await freshToken(cfg);
            if (!fresh) {
              signOut();
              return new Response('{}', { status: 401 });
            }
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${fresh}`);
            next = { ...init, headers };
          }
          const res = await globalThis.fetch(input, next);
          if (res.status === 401) signOut();
          return res;
        },
      }),
    [token, signOut, cfg],
  );
  if (!info) return <div className="center-message muted">Loading…</div>;
  if (!token) {
    const onToken = (t: string) => {
      storeToken(t);
      setExpired(false);
      setToken(t);
    };
    return cfg ? <SsoSignIn cfg={cfg} expired={expired} error={ssoError} onToken={onToken} /> : <SignIn expired={expired} onSignedIn={onToken} />;
  }
  const session = cfg ? currentSession(cfg) : null;
  const account = cfg && session?.idToken === token ? { name: session.name, signOut: () => void ssoSignOut(cfg).then(signOut) } : undefined;
  return <Routes api={api} account={account} />;
}

function Routes({ api, account }: { api: StudioApi; account?: { name?: string; signOut: () => void } }) {
  const [route, go] = useRoute();
  const [pendingNew, setPendingNew] = useState<{ id: string; title: string } | null>(null);
  if (route.name === 'edit') return <Editor api={api} id={route.id} pendingNew={pendingNew} onExit={() => go('#/')} />;
  return (
    <>
      {account && (
        <div className="signout-bar">
          <span className="muted small">{account.name}</span>
          <button type="button" className="btn ghost small" onClick={account.signOut}>
            Sign out
          </button>
        </div>
      )}
    <DashboardList
      api={api}
      onOpen={(id) => go(`#/d/${encodeURIComponent(id)}`)}
      onCreate={(id, title) => {
        setPendingNew({ id, title });
        go(`#/d/${encodeURIComponent(id)}`);
      }}
    />
    </>
  );
}
