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

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/app/discover?state=OH']}><Discover /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); confirm.mockReset(); Object.values(toast).forEach((f) => f.mockReset());
  get.mockImplementation(async (url) => {
    if (url === '/api/sequences') return { items: [] };
    if (url === '/api/discovery/providers') return { items: [] };
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
});
