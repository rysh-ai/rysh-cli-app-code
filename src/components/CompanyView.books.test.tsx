import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CompanyView } from './CompanyView';
import { useStore } from '../store';
import type { CompanySnapshot } from '../types';

// S2.4: company mode has a Books tab next to Orders … Activity.
vi.mock('../utils/commands', () => ({ sendCommand: () => {} }));

function snapshot(books?: CompanySnapshot['books']): CompanySnapshot {
  const now = new Date().toISOString();
  return {
    company: { id: 'c1', workspace_id: 'w1', name: 'Modern Bistro', slug: 'firat', fqdn: 'firat.dns.rysh.ai', status: 'active', template_id: 'restaurant' },
    orders: [], enquiries: [], services: [], channels: [], activity: [],
    link: { connected: true, live: true, auth_failed: false, last_fetch: now },
    fetched_at: now,
    books,
  };
}

afterEach(() => {
  act(() => { useStore.setState({ companySnapshot: null }); });
});

describe('CompanyView Books tab', () => {
  it('a Books tab opens the read-only Books view from snapshot.books', () => {
    act(() => {
      useStore.getState().setCompanySnapshot(snapshot({ enabled: true, deadlines: { linked: true, accounts: { next_due: '2027-06-30', overdue: false } }, ledger: { entries: [] }, summary: { months: [] } }));
    });
    render(<CompanyView paneId="p1" />);
    fireEvent.click(screen.getByText('Books'));
    expect(screen.getByText(/Accounts due 2027-06-30/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing here yet/)).toBeNull();
  });
  it('Books without books in the snapshot says it is not available', () => {
    act(() => { useStore.getState().setCompanySnapshot(snapshot(undefined)); });
    render(<CompanyView paneId="p1" />);
    fireEvent.click(screen.getByText('Books'));
    expect(screen.getByText(/Books is not available/i)).toBeInTheDocument();
  });
});
