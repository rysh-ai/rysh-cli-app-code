import { useCallback, useEffect, useState } from 'react';
import { LoginPage } from './components/LoginPage';
import { clearToken, fetchAuthStatus } from './utils/auth';

/**
 * AuthGate — decides whether to mount the app or the login form.
 *
 * Browser mode only. It asks the server (GET /api/auth/status) which state we
 * are in, and re-asks when the tab becomes visible again and every few minutes
 * while it is open. That periodic re-ask is what turns an expired 30-day token
 * back into a login page without a refresh-token mechanism: the server simply
 * stops authenticating the JWT, the next status call says so, and the form
 * comes back.
 *
 * Servers without the endpoint (or unreachable ones) report "no login
 * required", so the UI degrades to exactly its pre-login behaviour.
 */
const RECHECK_MS = 5 * 60 * 1000;

type GateState = 'checking' | 'ok' | 'login';

export function AuthGate({ children }: { children: React.ReactNode }) {
  // Electron never logs in: the desktop app reaches its sidecar with the
  // access token it already holds, so the gate is open from the first frame.
  const inElectron = typeof window.electronAPI !== 'undefined';
  const [state, setState] = useState<GateState>(inElectron ? 'ok' : 'checking');

  const check = useCallback(async () => {
    if (inElectron) return;
    const status = await fetchAuthStatus();
    if (!status.loginRequired || status.authenticated) {
      setState('ok');
      return;
    }
    // Whatever we were holding is no longer accepted — drop it so the next
    // request does not keep presenting a dead token.
    clearToken();
    setState('login');
  }, [inElectron]);

  useEffect(() => {
    if (inElectron) return;
    void check();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => void check(), RECHECK_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    };
  }, [check, inElectron]);

  // One same-origin round trip; the page background is already the app's, so
  // this reads as the page still loading rather than as a flash of empty UI.
  if (state === 'checking') return null;
  if (state === 'login') return <LoginPage onSignedIn={() => setState('ok')} />;
  return <>{children}</>;
}
