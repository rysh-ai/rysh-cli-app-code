import { describe, expect, it } from 'vitest';
import { describeGrants } from './CompanyView';
import type { CompanySnapshot } from '../types';

// CD5 (0.2.16, settled contract; server rysh-server cede9ab5): the company view
// says what this device may change, from the follower's copy of the key's own
// GET .../connect/permissions, so the owner sees it before an agent tries.
const NOW = Date.parse('2026-11-05T12:00:00Z');
const base = { link: { connected: true, live: true, auth_failed: false, last_fetch: '' } } as unknown as CompanySnapshot;
const snap = (extra: Partial<CompanySnapshot>) => ({ ...base, ...extra }) as CompanySnapshot;

describe('describeGrants', () => {
  it('nothing until the follower has read the grants (field absent)', () => {
    expect(describeGrants(base, NOW)).toBeNull();
  });
  it('an empty list reads "read only"', () => {
    expect(describeGrants(snap({ permissions: [] }), NOW)).toBe('This device: read only');
  });
  it('each permission with its date', () => {
    const s = snap({ permissions: ['enquiry.update', 'order.status'], permissions_expire_at: { 'enquiry.update': '2026-12-05T12:00:00Z', 'order.status': '2026-12-01T12:00:00Z' } });
    expect(describeGrants(s, NOW)).toBe('This device may: enquiry.update (until 5 Dec 2026), order.status (until 1 Dec 2026)');
  });
  it('7 days or fewer left reads "expires in N days"', () => {
    const s = snap({ permissions: ['order.status'], permissions_expire_at: { 'order.status': '2026-11-08T11:00:00Z' } });
    expect(describeGrants(s, NOW)).toBe('This device may: order.status (expires in 3 days)');
  });
  it('a permission without a date shows no date; a date for a name not granted is ignored; a bad date is no date', () => {
    const s = snap({ permissions: ['order.status', 'enquiry.update'], permissions_expire_at: { 'enquiry.update': 'not a date', 'other.thing': '2026-12-01T00:00:00Z' } });
    expect(describeGrants(s, NOW)).toBe('This device may: order.status, enquiry.update');
  });
  it('a non-string entry in permissions is dropped, never rendered', () => {
    const s = snap({ permissions: ['order.status', 42 as unknown as string] });
    expect(describeGrants(s, NOW)).toBe('This device may: order.status');
  });
});

describe('describeGrants: the follower lists read as well (cli-core 9ffcda9d)', () => {
  it("['read'] alone is read only", () => {
    expect(describeGrants(snap({ permissions: ['read'] }), NOW)).toBe('This device: read only');
  });
  it("read is the baseline, never shown as a grant", () => {
    expect(describeGrants(snap({ permissions: ['read', 'order.status'] }), NOW)).toBe('This device may: order.status');
  });
});
