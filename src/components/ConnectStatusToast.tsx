import { useEffect, useRef, useState } from 'react';

/**
 * ConnectStatusToast (CD3 rehearsal note N2): the outcome of a company connect
 * (design 037) over an OPEN workspace. The welcome screen shows these lines in
 * its own form; once a workspace is open nothing did, so a refused connect (an
 * invalid code, a downgraded server, a cancelled dialog) looked like nothing
 * happened. Progress and success fade; an error stays until dismissed.
 */
type Status = { stage: 'claiming' | 'opening' | 'done' | 'error'; message: string };

const FADE_MS = 5_000;

export function ConnectStatusToast() {
  const [status, setStatus] = useState<Status | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = window.electronAPI?.company?.onStatus((s) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setStatus(s);
      if (s.stage === 'done') timer.current = setTimeout(() => setStatus(null), FADE_MS);
    });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (typeof off === 'function') off();
    };
  }, []);

  if (!status) return null;
  if (status.stage === 'error') {
    return (
      <div role="alert" className="fixed bottom-10 right-4 z-50 max-w-md rounded border border-[#7a3b3b] bg-[#2a1717] px-3 py-2 text-[12px] text-[#f0c0c0] shadow-lg">
        <span>{status.message}</span>
        <button type="button" aria-label="Dismiss" className="ml-3 text-[#f0c0c0] underline" onClick={() => setStatus(null)}>
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div role="status" className="fixed bottom-10 right-4 z-50 max-w-md rounded border border-[#3b5a3b] bg-[#172a17] px-3 py-2 text-[12px] text-[#c0f0c0] shadow-lg">
      {status.message}
    </div>
  );
}
