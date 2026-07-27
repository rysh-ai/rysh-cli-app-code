import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { sendPairingApprove, sendChannelAllow, sendPairingList } from '../utils/commands';
import type { PendingPair, PairingQR, PairingStatusInfo } from '../types';

/**
 * DB2 — Pairings view (design 005 §4.3): pending pairing requests with expiry
 * countdown and Approve, per-humanoid allowlists with a direct-allow input,
 * QR/device-link payload cards (raw payload rendered in a monospace block with
 * a copy button — no client-side QR image, which would need an npm dep), and
 * live device-link status. All actions ride the same MsgChannelPair* messages
 * the terminal ##humanoid pair commands drive (WS3, design 003 §4.4).
 */

function fmtRemaining(expiresAt: number, now: number): string {
  const secs = expiresAt - now;
  if (secs <= 0) return 'expired';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

interface PendingRowProps {
  humanoidName: string;
  pair: PendingPair;
  now: number;
  controlEnabled: boolean;
}

const PendingRow = React.memo(function PendingRow({ humanoidName, pair, now, controlEnabled }: PendingRowProps) {
  const expired = pair.expires_at > 0 && pair.expires_at <= now;
  const handleApprove = useCallback(() => {
    sendPairingApprove(humanoidName, pair.code, pair.channel);
    // Refresh the roster shortly after so the approved entry moves to the
    // allowlist without waiting for a manual refresh.
    setTimeout(() => sendPairingList(humanoidName), 500);
  }, [humanoidName, pair.code, pair.channel]);

  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded bg-[#242424] text-[12px]">
      <span className="font-mono font-bold text-[#ffffaf] shrink-0">{pair.code}</span>
      <span className="text-[#87ffff] shrink-0">{pair.channel}</span>
      <span className="text-[#d4d4d4] truncate" title={pair.sender_id}>
        {pair.sender_name || pair.sender_id}
      </span>
      {pair.first_msg && (
        <span className="text-[#808080] italic flex-1 truncate" title={pair.first_msg}>
          “{pair.first_msg}”
        </span>
      )}
      <span
        className={`text-[11px] shrink-0 ${expired ? 'text-[#ff5f5f]' : 'text-[#808080]'}`}
        title={pair.expires_at > 0 ? new Date(pair.expires_at * 1000).toLocaleString() : ''}
      >
        {pair.expires_at > 0 ? `exp ${fmtRemaining(pair.expires_at, now)}` : ''}
      </span>
      {controlEnabled && (
        <button
          onClick={handleApprove}
          disabled={expired}
          className="px-2 py-0.5 rounded text-[11px] bg-[#005f00] text-[#87ff87] hover:bg-[#007700] transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          Approve
        </button>
      )}
    </div>
  );
});

const QRCard = React.memo(function QRCard({ qr }: { qr: PairingQR }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(qr.qr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [qr.qr]);

  return (
    <div className="border border-[#3a3a5a] rounded bg-[#20202a] p-2 mt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold text-[#ffffaf]">
          device link · {qr.channel}
        </span>
        <button
          onClick={handleCopy}
          className="px-2 py-0.5 rounded text-[10px] bg-[#333] text-[#aaa] hover:bg-[#444] hover:text-[#ddd] transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="font-mono text-[11px] text-[#87ffff] bg-[#141420] rounded p-2 whitespace-pre-wrap break-all select-all max-h-40 overflow-y-auto">
        {qr.qr}
      </pre>
      <p className="text-[10px] text-[#666] mt-1">
        Paste this payload into a QR generator or your device's link-device flow.
      </p>
    </div>
  );
});

const StatusLine = React.memo(function StatusLine({ status }: { status: PairingStatusInfo }) {
  return (
    <div className="flex items-center gap-2 text-[11px] mt-1 px-1">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: status.connected ? '#87ff87' : '#ff5f5f' }}
      />
      <span className="text-[#aaa]">{status.channel}</span>
      <span className={status.connected ? 'text-[#87ff87]' : 'text-[#ff5f5f]'}>
        {status.connected ? 'linked' : 'link error'}
      </span>
      {status.detail && <span className="text-[#808080] truncate">{status.detail}</span>}
    </div>
  );
});

interface HumanoidPairingsProps {
  name: string;
  now: number;
}

const HumanoidPairings = React.memo(function HumanoidPairings({ name, now }: HumanoidPairingsProps) {
  const controlEnabled = useStore((s) => s.controlEnabled);
  const state = useStore((s) => s.pairings[name]);
  const pairingQRs = useStore((s) => s.pairingQRs);
  const pairingStatuses = useStore((s) => s.pairingStatuses);

  const [allowSender, setAllowSender] = useState('');
  const [allowChannel, setAllowChannel] = useState('');

  const qrs = Object.values(pairingQRs).filter((q) => q.humanoid_name === name);
  const statuses = Object.values(pairingStatuses).filter((st) => st.humanoid_name === name);
  const pending = state?.pending || [];
  const allowlist = state?.allowlist || [];

  const handleAllow = useCallback(() => {
    const sender = allowSender.trim();
    if (!sender) return;
    sendChannelAllow(name, sender, allowChannel.trim());
    setAllowSender('');
    setTimeout(() => sendPairingList(name), 500);
  }, [name, allowSender, allowChannel]);

  return (
    <div className="border border-[#333] rounded bg-[#1e1e1e] p-2">
      <div className="flex items-center justify-between mb-1 px-1">
        <span className="font-bold text-[#ffffaf] text-[13px]">{name}</span>
        <button
          onClick={() => sendPairingList(name)}
          className="px-2 py-0.5 rounded text-[10px] bg-[#333] text-[#aaa] hover:bg-[#444] hover:text-[#ddd] transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Pending requests */}
      <div className="mb-2">
        <span className="text-[11px] text-[#808080] px-1">pending ({pending.length})</span>
        {pending.length === 0 ? (
          <p className="text-[11px] text-[#555] italic px-1">no pending pairing requests</p>
        ) : (
          <div className="flex flex-col gap-1 mt-1">
            {pending.map((p) => (
              <PendingRow key={p.code} humanoidName={name} pair={p} now={now} controlEnabled={controlEnabled} />
            ))}
          </div>
        )}
      </div>

      {/* Allowlist */}
      <div className="mb-1">
        <span className="text-[11px] text-[#808080] px-1">allowlist ({allowlist.length})</span>
        <div className="flex flex-wrap gap-1 mt-1 px-1">
          {allowlist.length === 0 ? (
            <span className="text-[11px] text-[#555] italic">empty</span>
          ) : (
            allowlist.map((entry) => (
              <span
                key={entry}
                className="px-1.5 py-0.5 rounded bg-[#2a2a2a] border border-[#3a3a3a] text-[#87ffff] text-[10px] font-mono"
              >
                {entry}
              </span>
            ))
          )}
        </div>
        {controlEnabled && (
          <div className="flex gap-1 mt-1.5 px-1">
            <input
              type="text"
              value={allowSender}
              onChange={(e) => setAllowSender(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAllow()}
              placeholder="sender id (e.g. +15550142, U024BE7)"
              className="flex-1 px-2 py-1 bg-[#1a1a1a] border border-[#555] rounded text-[#d4d4d4] font-mono text-[11px] outline-none focus:border-[#00d7d7]"
            />
            <input
              type="text"
              value={allowChannel}
              onChange={(e) => setAllowChannel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAllow()}
              placeholder="channel (optional)"
              className="w-32 px-2 py-1 bg-[#1a1a1a] border border-[#555] rounded text-[#d4d4d4] font-mono text-[11px] outline-none focus:border-[#00d7d7]"
            />
            <button
              onClick={handleAllow}
              disabled={!allowSender.trim()}
              className="px-2 py-1 rounded text-[11px] bg-[#005f5f] text-[#87ffff] hover:bg-[#008080] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Allow
            </button>
          </div>
        )}
      </div>

      {/* QR / device-link payloads */}
      {qrs.map((qr) => (
        <QRCard key={`${qr.humanoid_name}:${qr.channel}`} qr={qr} />
      ))}

      {/* Device-link status */}
      {statuses.map((st) => (
        <StatusLine key={`${st.humanoid_name}:${st.channel}`} status={st} />
      ))}
    </div>
  );
});

export const PairingsView = React.memo(function PairingsView() {
  const humanoids = useStore((s) => s.humanoidList);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // 1s tick for expiry countdowns.
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  // Populate initial state per humanoid via MsgChannelPairList request/reply.
  useEffect(() => {
    humanoids.forEach((h) => sendPairingList(h.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [humanoids.map((h) => h.name).join(',')]);

  if (humanoids.length === 0) {
    return <p className="text-[12px] text-[#666] italic mt-4 text-center">No humanoids registered</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {humanoids.map((h) => (
        <HumanoidPairings key={h.name} name={h.name} now={now} />
      ))}
    </div>
  );
});
