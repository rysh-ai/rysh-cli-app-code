import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import type { CompanySnapshot, CompanyActivity } from '../types';

interface Props {
  paneId: string;
}

type Section = 'orders' | 'enquiries' | 'email' | 'phone' | 'services' | 'activity';
const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'orders', label: 'Orders' },
  { key: 'enquiries', label: 'Enquiries' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'services', label: 'Services' },
  { key: 'activity', label: 'Activity' },
];

/**
 * CompanyView (design 037, Company Connect) — the desktop painter for a pane in
 * "company" content mode. It renders the CompanySnapshot the daemon's follower
 * pushes (store.companySnapshot, fed by the `company_snapshot` message) and asks
 * the daemon for the current one on mount (`company_query`). Nothing here talks
 * to the server: the terminal's company_view.go paints the same data from the
 * same daemon, so the two never disagree.
 */
export const CompanyView = React.memo(function CompanyView({ paneId }: Props) {
  const snap = useStore((s) => s.companySnapshot);
  const [section, setSection] = useState<Section>('orders');
  const [selected, setSelected] = useState<Record<Section, number>>({
    orders: 0, enquiries: 0, email: 0, phone: 0, services: 0, activity: 0,
  });
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    if (!snap) sendCommand('company_query');
  }, [snap]);

  const rows = useMemo(() => buildRows(snap, section), [snap, section]);
  const sel = Math.min(selected[section], Math.max(0, rows.length - 1));
  const current = rows[sel];

  const pick = (i: number) => {
    setSelected((s) => ({ ...s, [section]: i }));
    setDetailOpen(true);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col text-[12px] text-[#d4d4d4]" data-pane={paneId}>
      <Header snap={snap} onRefresh={() => sendCommand('company_refresh')} />
      <div className="flex gap-3 px-3 py-1 border-b border-[#2a2a2a] text-[11px] select-none">
        {SECTIONS.map((s) => {
          const count = s.key === 'orders' ? snap?.orders?.length : s.key === 'enquiries' ? snap?.enquiries?.length : undefined;
          const active = s.key === section;
          return (
            <button
              key={s.key}
              onClick={() => { setSection(s.key); setDetailOpen(false); }}
              className={`px-1 py-0.5 rounded ${active ? 'text-white bg-[#2a2a2a]' : 'text-[#8a8a8a] hover:text-[#d4d4d4]'}`}
            >
              {s.label}{count !== undefined ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>
      {!snap ? (
        <div className="flex-1 flex items-center justify-center text-[#8a8a8a]">
          waiting for the company follower…
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <ul className={`min-h-0 overflow-y-auto ${detailOpen && current ? 'w-2/5 border-r border-[#2a2a2a]' : 'flex-1'}`}>
            {rows.length === 0 && <li className="px-3 py-2 text-[#8a8a8a]">nothing here yet</li>}
            {rows.map((r, i) => (
              <li
                key={r.key}
                onClick={() => pick(i)}
                className={`px-3 py-1 font-mono whitespace-pre truncate cursor-pointer ${i === sel && detailOpen ? 'bg-[#094771] text-white' : 'hover:bg-[#2a2a2a]'}`}
                title={r.line}
              >
                {r.line}
              </li>
            ))}
          </ul>
          {detailOpen && current && (
            <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono whitespace-pre-wrap">
              {current.detail.join('\n')}
            </div>
          )}
        </div>
      )}
      <div className="px-3 py-1 border-t border-[#2a2a2a] text-[11px] text-[#8a8a8a]">
        read-only · click a row for its detail · refresh with the button above
      </div>
    </div>
  );
});

function Header({ snap, onRefresh }: { snap: CompanySnapshot | null; onRefresh: () => void }) {
  const c = snap?.company;
  const link = snap ? describeLink(snap) : 'no snapshot yet';
  const warn = !!snap && (snap.link.auth_failed || (!snap.link.connected && !!snap.link.last_error));
  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#2a2a2a]">
      <div className="min-w-0">
        <div className="text-[13px] text-white truncate">
          {c?.name || c?.slug || 'company'}
          {c?.fqdn ? <span className="text-[#8a8a8a]"> · {c.fqdn}</span> : null}
          {c?.status ? <span className="text-[#8a8a8a]"> · {c.status.replace(/_/g, ' ')}</span> : null}
        </div>
        <div className={`text-[11px] truncate ${warn ? 'text-[#ff8787]' : 'text-[#8a8a8a]'}`}>
          {link}
          {snap?.link.last_fetch && snap.link.last_fetch !== '0001-01-01T00:00:00Z'
            ? ` · updated ${new Date(snap.link.last_fetch).toLocaleTimeString()}`
            : ''}
        </div>
      </div>
      <button onClick={onRefresh} className="text-[11px] px-2 py-0.5 rounded border border-[#3a3a3a] hover:bg-[#2a2a2a]" title="Ask the follower to fetch now">
        refresh
      </button>
    </div>
  );
}

export function describeLink(snap: CompanySnapshot): string {
  const l = snap.link;
  if (l.auth_failed) return 'key refused — reconnect from the dashboard';
  if (!l.connected && l.last_error) return `disconnected: ${l.last_error}`;
  if (!l.connected) return 'connecting…';
  if (l.live) return 'live';
  return 'connected (polling)';
}

interface Row {
  key: string;
  line: string;
  detail: string[];
}

export function buildRows(snap: CompanySnapshot | null, section: Section): Row[] {
  if (!snap) return [];
  switch (section) {
    case 'orders':
      return (snap.orders || []).map((o) => ({
        key: o.id,
        line: `${pad(o.reference, 6)} ${pad(o.status, 9)} ${pad(o.payment_status, 8)} ${pad(o.customer_name, 18)} ${pad(o.fulfilment, 10)} ${money(o.amount_pence, o.currency).padStart(9)}  ${when(o.created_at)}`,
        detail: [
          `order ${o.reference} · ${o.status} · ${o.payment_status}`,
          `placed ${new Date(o.created_at).toLocaleString()}`,
          `customer ${o.customer_name}`,
          ...(o.customer_phone ? [`phone ${o.customer_phone}`] : []),
          ...(o.customer_email ? [`email ${o.customer_email}`] : []),
          `fulfilment ${o.fulfilment}`,
          ...(o.address ? [`address ${o.address}`] : []),
          ...(o.notes ? [`notes ${o.notes}`] : []),
          '',
          ...(o.items || []).map((it) => `${String(it.quantity).padStart(2)} × ${pad(it.name, 24)} ${money(it.total_pence, o.currency).padStart(9)}`),
          `${pad('total', 29)} ${money(o.amount_pence, o.currency).padStart(9)}`,
        ],
      }));
    case 'enquiries':
      return (snap.enquiries || []).map((e) => ({
        key: e.id,
        line: `${pad(e.reference, 6)} ${pad(e.kind, 12)} ${pad(e.status, 9)} ${pad(e.name, 18)} ${pad(e.subject, 20)} ${when(e.created_at)}`,
        detail: [
          `${e.kind} ${e.reference} · ${e.status}`,
          `received ${new Date(e.created_at).toLocaleString()}`,
          `from ${e.name}`,
          ...(e.subject ? [`about ${e.subject}`] : []),
          ...(e.phone ? [`phone ${e.phone}`] : []),
          ...(e.email ? [`email ${e.email}`] : []),
          ...fields(e.fields),
          ...(e.message ? ['', e.message] : []),
          ...(e.owner_note ? ['', `note: ${e.owner_note}`] : []),
        ],
      }));
    case 'email': {
      const m = snap.email;
      if (!m) return [{ key: 'none', line: 'no managed mailbox yet', detail: [] }];
      const incoming = m.incoming_email_address || m.address;
      const rows: Row[] = [
        { key: 'in', line: `receives at  ${incoming}`, detail: [] },
        { key: 'out', line: `sends as     ${m.outgoing_email_address || m.address}`, detail: [] },
      ];
      if (m.reply_address && m.reply_address !== incoming) rows.push({ key: 'reply', line: `replies via  ${m.reply_address}`, detail: [] });
      rows.push({ key: 'state', line: `state        ${m.state.replace(/_/g, ' ')}`, detail: [] });
      if (m.last_error) rows.push({ key: 'err', line: `error        ${m.last_error}`, detail: [] });
      return rows;
    }
    case 'phone': {
      const p = snap.phone;
      if (!p) return [{ key: 'none', line: 'no business number yet', detail: [] }];
      const rows: Row[] = [];
      if (p.number) rows.push({ key: 'n', line: `number  ${p.number}`, detail: [] });
      if (p.state) rows.push({ key: 's', line: `state   ${p.state.replace(/_/g, ' ')}`, detail: [] });
      if (p.message) rows.push({ key: 'm', line: `note    ${p.message}`, detail: [] });
      return rows;
    }
    case 'services':
      return [
        ...(snap.services || []).map((s) => ({
          key: `svc-${s.service_key}`,
          line: `service  ${pad(s.service_key, 12)} ${pad(s.state.replace(/_/g, ' '), 20)} ${s.status_message}`,
          detail: [`${s.service_key} · ${s.state}`, s.status_message, ...(s.next_action ? [`next: ${s.next_action}`] : []), ...(s.monthly_cost_minor > 0 ? [`monthly ${money(s.monthly_cost_minor, s.currency)}`] : [])],
        })),
        ...(snap.channels || []).map((c) => ({
          key: `ch-${c.channel}`,
          line: `channel  ${pad(c.channel, 12)} ${pad(`${c.state.replace(/_/g, ' ')} (${c.enabled ? 'on' : 'off'})`, 20)} ${c.status_message}`,
          detail: [`${c.channel} · ${c.state}`, c.status_message, ...((c.credentials_required || []).length ? [`needs: ${(c.credentials_required || []).join(', ')}`] : [])],
        })),
      ];
    case 'activity':
      return (snap.activity || []).map((a: CompanyActivity, i) => ({
        key: `${a.kind}-${a.id || i}-${a.occurred_at}`,
        line: `${new Date(a.occurred_at).toLocaleString()}  ${pad(a.action ? `${a.kind}/${a.action}` : a.kind, 22)} ${a.summary}`,
        detail: [a.summary, a.action ? `${a.kind}/${a.action}` : a.kind, ...(a.reference ? [`reference ${a.reference}`] : []), ...(a.status ? [`status ${a.status}`] : [])],
      }));
  }
}

function fields(raw: string): string[] {
  if (!raw || raw === '{}') return [];
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return Object.keys(obj).sort().map((k) => `${k.replace(/_/g, ' ')} ${obj[k]}`);
  } catch {
    return [];
  }
}

export function money(minor: number, currency: string): string {
  const whole = Math.trunc(minor / 100);
  const frac = Math.abs(minor % 100).toString().padStart(2, '0');
  switch ((currency || '').toUpperCase()) {
    case 'GBP': case '': return `£${whole}.${frac}`;
    case 'EUR': return `€${whole}.${frac}`;
    case 'USD': return `$${whole}.${frac}`;
    default: return `${whole}.${frac} ${currency.toUpperCase()}`;
  }
}

function when(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function pad(s: string, n: number): string {
  const v = (s || '').trim();
  const out = v.length > n ? v.slice(0, Math.max(0, n - 1)) + '…' : v;
  return out.padEnd(n);
}
