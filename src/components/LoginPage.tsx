import { useState } from 'react';
import { login } from '../utils/auth';

/**
 * LoginPage — the username/password form the web UI shows when the server has
 * a login configured (`##rysh web auth username=<u> password=<p>`) and this
 * browser holds no valid token: first visit, sign-out, or a 30-day token that
 * has expired.
 *
 * On success the token is in localStorage and onSignedIn() swaps this screen
 * for the app. Only ever rendered in browser mode — Electron authenticates
 * against its sidecar with the access token it already has.
 */
export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      onSignedIn();
    } catch (err: any) {
      setError(err?.message || 'sign-in failed');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen w-screen bg-[#1e1e1e] text-[#d4d4d4]">
      <form onSubmit={submit} className="w-[320px] max-w-[90vw]">
        <div className="text-3xl font-semibold tracking-tight mb-1">rysh</div>
        <div className="text-[#8a8a8a] text-[13px] mb-6">Sign in to open this session.</div>

        <label className="block text-[11px] uppercase tracking-wide text-[#8a8a8a] mb-1">
          Username
        </label>
        <input
          className="w-full mb-4 px-3 py-2 bg-[#252526] border border-[#3c3c3c] rounded text-[13px] text-[#d4d4d4] outline-none focus:border-[#0e639c]"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
        />

        <label className="block text-[11px] uppercase tracking-wide text-[#8a8a8a] mb-1">
          Password
        </label>
        <input
          className="w-full mb-4 px-3 py-2 bg-[#252526] border border-[#3c3c3c] rounded text-[13px] text-[#d4d4d4] outline-none focus:border-[#0e639c]"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={busy}
        />

        {error && <div className="mb-3 text-[12px] text-[#f48771]">{error}</div>}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full px-3 py-2 rounded text-[13px] bg-[#0e639c] hover:bg-[#1177bb] disabled:opacity-40 disabled:hover:bg-[#0e639c] text-white"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="mt-6 text-[11px] text-[#6a6a6a] leading-relaxed">
          Credentials are set in the session with{' '}
          <span className="font-mono text-[#8a8a8a]">##rysh web auth</span>. A sign-in lasts 30
          days.
        </div>
      </form>
    </div>
  );
}
