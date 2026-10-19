import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CompanyView, buildRows, describeLink, money } from './CompanyView';
import { useStore } from '../store';
import type { CompanySnapshot } from '../types';

// The desktop painter of the company view (design 037). It must say which of
// three worlds it is in — no snapshot yet, a snapshot with data, a snapshot
// whose key was refused — and never invent rows.
const sent: Array<{ action: string; params?: Record<string, unknown> }> = [];
vi.mock('../utils/commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => {
    sent.push({ action, params });
  },
}));

function snapshot(): CompanySnapshot {
  const now = new Date().toISOString();
  return {
    company: { id: 'c1', workspace_id: 'w1', name: 'Modern Bistro', slug: 'firat', fqdn: 'firat.dns.rysh.ai', status: 'active', template_id: 'restaurant' },
    orders: [
      { id: 'o1', reference: 'ABC23', customer_name: 'Ada', customer_phone: '', customer_email: '', fulfilment: 'delivery', address: '', notes: '', items: [{ sku: 'p', name: 'Pizza', quantity: 2, unit_pence: 925, total_pence: 1850 }], amount_pence: 1850, currency: 'GBP', status: 'received', payment_status: 'paid', created_at: now },
    ],
    enquiries: [{ id: 'e1', reference: 'QRS45', kind: 'reservation', subject: '', name: 'Bo', phone: '', email: '', message: 'window seat', fields: '{"party_size":"4"}', status: 'new', owner_note: '', created_at: now }],
    email: { address: 'info@firat.dns.rysh.ai', incoming_email_address: 'info@firat.dns.rysh.ai', outgoing_email_address: 'info@letchat.ai', reply_address: '', state: 'active' },
    phone: null,
    services: [], channels: [], activity: [],
    link: { connected: true, live: true, auth_failed: false, last_fetch: now },
    fetched_at: now,
  };
}

afterEach(() => {
  sent.length = 0;
  act(() => { useStore.setState({ companySnapshot: null }); });
});

describe('CompanyView', () => {
  it('asks the daemon once when it has no snapshot and says it is waiting', () => {
    render(<CompanyView paneId="p1" />);
    expect(screen.getByText(/waiting for the company follower/)).toBeInTheDocument();
    expect(sent).toEqual([{ action: 'company_query', params: undefined }]);
  });

  it('renders the header, the counted tabs and the orders, and opens a detail on click', () => {
    act(() => { useStore.getState().setCompanySnapshot(snapshot()); });
    render(<CompanyView paneId="p1" />);
    expect(screen.getByText(/Modern Bistro/)).toBeInTheDocument();
    expect(screen.getByText(/firat\.dns\.rysh\.ai/)).toBeInTheDocument();
    expect(screen.getByText(/^live/)).toBeInTheDocument();
    expect(screen.getByText('Orders (1)')).toBeInTheDocument();
    expect(screen.getByText('Enquiries (1)')).toBeInTheDocument();
    const row = screen.getByTitle(/ABC23/);
    expect(row.textContent).toContain('£18.50');
    fireEvent.click(row);
    expect(screen.getByText(/customer Ada/)).toBeInTheDocument();
    expect(sent.some((s) => s.action === 'company_query')).toBe(false);
    fireEvent.click(screen.getByText('Enquiries (1)'));
    expect(screen.getByTitle(/QRS45/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('refresh'));
    expect(sent).toEqual([{ action: 'company_refresh', params: undefined }]);
  });

  it('shows a refused key as a warning, not as an empty company', () => {
    const s = snapshot();
    s.link = { connected: false, live: false, auth_failed: true, last_error: 'the server rejected this key', last_fetch: s.fetched_at };
    act(() => { useStore.getState().setCompanySnapshot(s); });
    render(<CompanyView paneId="p1" />);
    expect(screen.getByText(/key refused — reconnect from the dashboard/)).toBeInTheDocument();
    expect(screen.getByText('Orders (1)')).toBeInTheDocument();
  });
});

describe('buildRows / helpers', () => {
  it('formats money and link states like the terminal view', () => {
    expect(money(1850, 'GBP')).toBe('£18.50');
    expect(money(700, 'usd')).toBe('$7.00');
    expect(money(5, 'CHF')).toBe('0.05 CHF');
    const s = snapshot();
    expect(describeLink(s)).toBe('live');
    s.link.live = false;
    expect(describeLink(s)).toBe('connected (polling)');
    s.link.connected = false;
    expect(describeLink(s)).toBe('connecting…');
  });

  it('never invents rows and folds kind-specific fields into the detail', () => {
    expect(buildRows(null, 'orders')).toEqual([]);
    const s = snapshot();
    expect(buildRows(s, 'phone')[0].line).toBe('no business number yet');
    expect(buildRows(s, 'enquiries')[0].detail).toContain('party size 4');
    expect(buildRows(s, 'email').map((r) => r.line.trim())).toContain('receives at  info@firat.dns.rysh.ai');
  });
});
