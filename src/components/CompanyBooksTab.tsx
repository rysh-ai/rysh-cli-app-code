import type { CompanyBooks } from '../types';

/**
 * CompanyBooksTab (S2.4, design 037) — the read-only Books view of company mode.
 * It paints snapshot.books, which the daemon's follower reads with the connect
 * key (rysh-cli internal/company fetchBooks) and passes through unchanged:
 * deadlines from Companies House, and while the bookkeeping assistant is on the
 * monthly totals and the newest ledger entries. Nothing here talks to the server
 * and nothing writes: changes are made on the web. The JSON is the server's, so
 * every field is checked before use and a wrong type renders nothing.
 */
export function CompanyBooksTab({ books }: { books: CompanyBooks | undefined | null }) {
  if (!books || typeof books !== 'object') {
    return (
      <div className="px-3 py-2 text-[#8a8a8a]">
        Books is not available for this company here yet (the server or the bundled daemon does not offer it).
      </div>
    );
  }
  const deadlines = obj(books.deadlines);
  const months = arr(obj(books.summary)?.months).map(obj).filter((m): m is Record<string, unknown> => !!m);
  const entries = arr(obj(books.ledger)?.entries).map(obj).filter((e): e is Record<string, unknown> => !!e);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
      <section>
        <h3 className="text-[11px] uppercase tracking-wider text-[#666] mb-1">Filing deadlines</h3>
        <Deadlines d={deadlines} />
      </section>
      {books.enabled !== true ? (
        <div className="text-[#8a8a8a]">
          The bookkeeping assistant is not on for this company. Turn it on from the company page on the web to see
          its totals and entries here.
        </div>
      ) : (
        <>
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-[#666] mb-1">Money in and out by month</h3>
            {months.length === 0 ? (
              <div className="text-[#8a8a8a]">no months yet</div>
            ) : (
              <table className="font-mono">
                <thead>
                  <tr className="text-[#8a8a8a]">
                    <th className="text-left pr-4 font-normal">month</th>
                    <th className="text-right pr-4 font-normal">in</th>
                    <th className="text-right pr-4 font-normal">out</th>
                    <th className="text-right font-normal">net</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m, i) => (
                    <tr key={`${str(m.month)}-${i}`} data-testid={`books-month-${str(m.month)}`}>
                      <td className="pr-4">{str(m.month)}</td>
                      <td className="text-right pr-4">{pence(m.in_pence)}</td>
                      <td className="text-right pr-4">{pence(m.out_pence)}</td>
                      <td className="text-right">{pence(m.net_pence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section data-testid="books-ledger">
            <h3 className="text-[11px] uppercase tracking-wider text-[#666] mb-1">Newest entries</h3>
            {entries.length === 0 ? (
              <div className="text-[#8a8a8a]">no entries yet</div>
            ) : (
              <ul className="font-mono">
                {entries.map((e, i) => (
                  <li key={`${str(e.id)}-${i}`} className="whitespace-pre truncate" title={str(e.note)}>
                    {str(e.entry_date)}  {e.direction === 'in' ? 'in ' : 'out'}  {pence(e.amount_pence).padStart(12)}  {str(e.category)}
                    {str(e.note) ? `  ${str(e.note)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <div className="text-[11px] text-[#8a8a8a]">Books here is read only: add or change entries on the web.</div>
    </div>
  );
}

function Deadlines({ d }: { d: Record<string, unknown> | null }) {
  if (!d) return <div className="text-[#8a8a8a]">no deadlines read yet</div>;
  if (d.linked === false) return <div className="text-[#8a8a8a]">This company is not linked to Companies House yet.</div>;
  const rows: Array<[string, Record<string, unknown> | null]> = [
    ['Accounts', obj(d.accounts)],
    ['Confirmation statement', obj(d.confirmation_statement)],
  ];
  return (
    <ul>
      {rows.map(([label, f]) =>
        f && str(f.next_due) ? (
          <li key={label} className={f.overdue === true ? 'text-[#ff8787]' : ''}>
            {label} due {str(f.next_due)}
            {f.overdue === true ? ' (overdue)' : ''}
          </li>
        ) : null
      )}
    </ul>
  );
}

/** formatPence: integer pence to pounds, e.g. 250000 -> "£2,500.00", -99 -> "-£0.99". */
export function formatPence(p: number): string {
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(p));
  const pounds = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}£${pounds}.${(abs % 100).toString().padStart(2, '0')}`;
}

function pence(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? formatPence(v) : '';
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
