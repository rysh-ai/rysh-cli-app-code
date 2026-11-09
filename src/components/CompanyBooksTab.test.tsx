import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CompanyBooksTab, formatPence } from './CompanyBooksTab';
import type { CompanyBooks } from '../types';

// S2.4 (sprint 0.2.16, design 037): company mode gets a read-only Books tab. The
// daemon's snapshot carries `books` (rysh-cli internal/company fetchBooks): the
// server's JSON passed through — deadlines (Companies House), and while the
// bookkeeping assistant is on the 6-month summary and the newest 20 ledger
// entries. Writes stay on the web. Wording: "Books" / "bookkeeping assistant",
// never "your accountant" (U-27 Q6).
const ON: CompanyBooks = {
  enabled: true,
  deadlines: {
    linked: true,
    company_number: '12345678',
    accounts: { next_due: '2027-06-30', overdue: false },
    confirmation_statement: { next_due: '2026-10-01', overdue: true },
  },
  summary: {
    from: '2026-06',
    to: '2026-11',
    months: [
      { month: '2026-10', in_pence: 250000, out_pence: 1250, net_pence: 248750 },
      { month: '2026-11', in_pence: 0, out_pence: 99, net_pence: -99 },
    ],
  },
  ledger: {
    entries: [
      { id: 'l1', entry_date: '2026-11-02', direction: 'out', amount_pence: 1250, currency: 'GBP', category: 'software', note: 'domain renewal' },
      { id: 'l2', entry_date: '2026-10-28', direction: 'in', amount_pence: 250000, currency: 'GBP', category: 'sales', note: '<b>invoice 7</b>' },
    ],
  },
};

describe('formatPence', () => {
  it('integer pence to pounds, with sign and thousands', () => {
    expect(formatPence(250000)).toBe('£2,500.00');
    expect(formatPence(99)).toBe('£0.99');
    expect(formatPence(-99)).toBe('-£0.99');
    expect(formatPence(0)).toBe('£0.00');
  });
});

describe('CompanyBooksTab', () => {
  it('shows the filing deadlines, an overdue one marked', () => {
    render(<CompanyBooksTab books={ON} />);
    expect(screen.getByText(/Accounts due 2027-06-30/)).toBeTruthy();
    expect(screen.getByText(/Confirmation statement due 2026-10-01/).textContent).toMatch(/overdue/i);
  });
  it('shows the monthly totals in pounds', () => {
    render(<CompanyBooksTab books={ON} />);
    const row = screen.getByTestId('books-month-2026-10');
    expect(row.textContent).toContain('£2,500.00');
    expect(row.textContent).toContain('£12.50');
    expect(row.textContent).toContain('£2,487.50');
  });
  it('shows the newest ledger entries; a note is shown as text, never as markup', () => {
    const { container } = render(<CompanyBooksTab books={ON} />);
    expect(screen.getByText(/domain renewal/)).toBeTruthy();
    expect(screen.getByText(/<b>invoice 7<\/b>/)).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });
  it('says it is read only and that changes are made on the web', () => {
    render(<CompanyBooksTab books={ON} />);
    expect(screen.getByText(/read only/i).textContent).toMatch(/on the web/i);
  });
  it('Books off: says so, still shows the deadlines', () => {
    render(<CompanyBooksTab books={{ enabled: false, deadlines: ON.deadlines }} />);
    expect(screen.getByText(/bookkeeping assistant is not on/i)).toBeTruthy();
    expect(screen.getByText(/Accounts due 2027-06-30/)).toBeTruthy();
    expect(screen.queryByTestId('books-ledger')).toBeNull();
  });
  it('no books in the snapshot (an older server or daemon): says Books is not available here', () => {
    render(<CompanyBooksTab books={undefined} />);
    expect(screen.getByText(/Books is not available/i)).toBeTruthy();
  });
  it('a company with no Companies House link: no deadlines section error', () => {
    render(<CompanyBooksTab books={{ enabled: true, deadlines: { linked: false }, ledger: { entries: [] }, summary: { months: [] } }} />);
    expect(screen.getByText(/not linked to Companies House/i)).toBeTruthy();
    expect(screen.getByText(/no entries yet/i)).toBeTruthy();
  });
  it('never says "accountant"', () => {
    const { container } = render(<CompanyBooksTab books={ON} />);
    expect(container.textContent?.toLowerCase()).not.toContain('accountant');
    const off = render(<CompanyBooksTab books={{ enabled: false }} />);
    expect(off.container.textContent?.toLowerCase()).not.toContain('accountant');
  });
  it('tolerates junk in the passthrough JSON (wrong types render nothing, never throw)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const junk: any = { enabled: true, deadlines: 'x', summary: { months: 'y' }, ledger: { entries: [null, 3, { amount_pence: 'z' }] } };
    expect(() => render(<CompanyBooksTab books={junk} />)).not.toThrow();
  });
});
