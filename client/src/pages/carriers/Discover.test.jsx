import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const post = vi.fn();
const confirm = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: (...a) => post(...a) } }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../components/Modal.jsx', () => ({ useConfirm: () => confirm, Modal: () => null }));
vi.mock('../../components/carriers/SaveAndCall.jsx', () => ({ default: ({ record }) => <span>call {record.dotNumber}</span>, claimText: () => 'Ana already has this carrier.' }));

const { default: Discover } = await import('./Discover.jsx');

const rec = (dot, extra = {}) => ({
  dotNumber: dot, companyName: `CARRIER ${dot} LLC`, dbaName: null, mcNumber: `9${dot}`, phone: '6145550101', email: `ops${dot}@carrier.test`,
  city: 'COLUMBUS', state: 'OH', fleetSize: 3, equipment: null, authorityStatus: 'active', authorityDate: '2026-06-01T12:00:00.000Z',
  existsInCrm: false, existingId: null, teamClaims: [], ...extra,
});
const RESULTS = {
  source: 'FMCSA Company Census (public)', retrievedAt: '2026-11-10T12:00:00Z', note: null, offset: 0, limit: 50, hasMore: false,
  items: [rec('1000001'), rec('1000002', { existsInCrm: true, existingId: 'c2' }), rec('1000003', { teamClaims: [{ ownerName: 'Ana' }] })],
};

const FILTER_OPTIONS = { equipmentOptions: [{ value: 'dry_van', label: 'Dry van' }, { value: 'reefer', label: 'Reefer' }], insurerSuggestions: ['Progressive', 'Canal'] };

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/app/discover?state=OH']}><Discover /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); confirm.mockReset(); Object.values(toast).forEach((f) => f.mockReset());
  get.mockImplementation(async (url) => {
    if (url === '/api/sequences') return { items: [] };
    if (url === '/api/discovery/providers') return { items: [] };
    if (url === '/api/discovery/filter-options') return FILTER_OPTIONS;
    if (url === '/api/discovery/search') return RESULTS;
    throw new Error(`unexpected ${url}`);
  });
});

describe('Find carriers page', () => {
  it('shows phone cards: a checkbox only for carriers not in the list, with call and status on each card', async () => {
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /Find leads/ }));
    await waitFor(() => expect(screen.getAllByText('CARRIER 1000001 LLC').length).toBeGreaterThan(0));
    expect(get).toHaveBeenCalledWith('/api/discovery/search', expect.objectContaining({ state: 'OH', offset: 0, limit: 50 }), expect.objectContaining({ signal: expect.anything() }));
    expect(screen.getByLabelText('Select CARRIER 1000001 LLC')).toBeInTheDocument();
    expect(screen.getByLabelText('Select CARRIER 1000003 LLC')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select CARRIER 1000002 LLC')).toBeNull();
    // Both the table and the cards render in the DOM (CSS picks one by width).
    expect(screen.getAllByText('In your list')).toHaveLength(2);
    expect(screen.getAllByText('call 1000003')).toHaveLength(2);
    expect(screen.getAllByText('COLUMBUS, OH · 3 trucks · registered Jun 1, 2026').length).toBe(3);
  });

  it('selecting on a card saves that carrier after the teammate warning', async () => {
    confirm.mockResolvedValue(true);
    post.mockResolvedValue({ created: 1, skipped: 0, limited: 0, notFound: 0, items: [] });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /Find leads/ }));
    fireEvent.click(await screen.findByLabelText('Select CARRIER 1000003 LLC'));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 to my list' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/discovery/save', { dotNumbers: ['1000003'], sequenceId: null }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Save anyway' }));
  });

  it('shows the authority badge and how many carriers were hidden for inactive authority', async () => {
    get.mockImplementation(async (url) => {
      if (url === '/api/discovery/search') return { ...RESULTS, hiddenInactive: 3, items: [rec('1000001', { authority: { status: 'active', label: 'Authority active · insurance on file' } }), rec('1000004', { authorityStatus: 'pending' })] };
      return { items: [] };
    });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /Find leads/ }));
    expect(await screen.findByText(/3 carriers hidden: authority not active/)).toBeInTheDocument();
    expect(screen.getAllByText('Authority pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Active')[0]).toHaveAttribute('title', 'Authority active · insurance on file');
  });

  it('asks "Authority is not active. Save anyway?" for a carrier the server refused, then saves it with allowInactive', async () => {
    confirm.mockResolvedValue(true);
    post.mockResolvedValueOnce({ created: 0, skipped: 0, limited: 0, notFound: 0, inactiveAuthority: 1, unverified: 0, ids: [], items: [{ dotNumber: '1000001', id: null, status: 'inactive_authority', companyName: 'CARRIER 1000001 LLC', authority: { status: 'inactive', label: 'No insurance on file' } }] })
      .mockResolvedValueOnce({ created: 1, skipped: 0, limited: 0, notFound: 0, inactiveAuthority: 0, unverified: 0, ids: ['c1'], items: [{ dotNumber: '1000001', id: 'c1', status: 'created' }] });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /Find leads/ }));
    fireEvent.click(await screen.findByLabelText('Select CARRIER 1000001 LLC'));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 to my list' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Authority is not active', confirmLabel: 'Save anyway', message: expect.stringContaining('CARRIER 1000001 LLC: No insurance on file') }));
    expect(post).toHaveBeenLastCalledWith('/api/discovery/save', { dotNumbers: ['1000001'], sequenceId: null, allowInactive: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved 1 carrier'));
  });

  it('sends the shared lead filters with the search (only what differs from the defaults)', async () => {
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /^Location/ }));
    fireEvent.change(screen.getByLabelText('ZIP prefixes'), { target: { value: '773, 750' } });
    fireEvent.click(screen.getByRole('button', { name: /^Operation/ }));
    fireEvent.click(screen.getByLabelText('Interstate only'));
    fireEvent.click(screen.getByRole('button', { name: /^Contact quality/ }));
    fireEvent.click(screen.getByLabelText('Leave out shared contacts'));
    fireEvent.click(screen.getByLabelText('Has a cell phone'));
    fireEvent.click(screen.getByRole('button', { name: /^Size and equipment/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reefer' }));
    fireEvent.click(screen.getByLabelText('Order'));
    fireEvent.click(screen.getByRole('option', { name: 'Best leads first (each page)' }));
    fireEvent.click(screen.getByRole('button', { name: /Find leads/ }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/discovery/search', expect.objectContaining({
      state: 'OH', order: 'score', zipPrefixes: '773,750', interstateOnly: 'true', excludeSharedContacts: 'false', requireCell: 'true', equipment: 'reefer',
    }), expect.anything()));
    const params = get.mock.calls.find(([url]) => url === '/api/discovery/search')[1];
    expect(params).not.toHaveProperty('excludeRatings');
    expect(params).not.toHaveProperty('hazmat');
  });

  it('shows each lead tier with its signal chips and how many carriers the filters hid', async () => {
    get.mockImplementation(async (url) => {
      if (url === '/api/discovery/search') {
        return {
          ...RESULTS, hiddenByFilters: 4, hiddenReasons: { sharedContact: 3, unsafe: 0, filtered: 1 },
          items: [rec('1000001', { score: 82, tier: 'A', signals: [{ key: 'new_authority', label: 'New MC · 45 days', points: 25, group: 'need', tone: 'good' }, { key: 'cell_phone', label: 'Cell phone', points: 14, group: 'reach', tone: 'good' }] })],
        };
      }
      return url === '/api/discovery/filter-options' ? FILTER_OPTIONS : { items: [] };
    });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /Find leads/ }));
    expect(await screen.findByText('4 hidden by filters (3 shared contact, 1 outside the filters).')).toBeInTheDocument();
    // Table and phone cards both render (CSS picks one by width).
    expect(screen.getAllByText('A · 82')).toHaveLength(2);
    expect(screen.getAllByText('New MC · 45 days')).toHaveLength(2);
    expect(screen.getAllByText('Cell phone').length).toBe(2);
  });
});
