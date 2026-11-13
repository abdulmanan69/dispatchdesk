import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const post = vi.fn();
const download = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', async (importOriginal) => ({ ...(await importOriginal()), api: { get: (...a) => get(...a), post: (...a) => post(...a), download: (...a) => download(...a) } }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../components/Modal.jsx', () => ({ useConfirm: () => vi.fn(), Modal: () => null }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', team: null } }) }));
vi.mock('../../components/calling/CallButton.jsx', () => ({ default: ({ phone }) => <span>{phone}</span> }));
vi.mock('../../components/carriers/CarrierForm.jsx', () => ({ default: () => null }));
vi.mock('../../components/carriers/EnrollModal.jsx', () => ({ default: () => null }));
vi.mock('../../components/carriers/BulkEmailModal.jsx', () => ({ default: () => null }));

const { default: CarrierList } = await import('./CarrierList.jsx');

const CARRIER = {
  id: 'c1', companyName: 'Lone Star Haulers', dotNumber: '123456', mcNumber: '654321', phone: '2145550101', city: 'Dallas', state: 'TX',
  equipment: 'dry_van', fleetSize: 3, authorityStatus: 'active', stage: { key: 'lead', name: 'All Leads', color: '#64748b' }, tags: [],
  doNotCall: false, priority: 0, lastCallAt: null, lastActivityAt: null,
};
const PAGE = { items: [CARRIER], total: 1, page: 1, pages: 1, pageSize: 25 };

function renderIt(path) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><CarrierList /></MemoryRouter></QueryClientProvider>);
  return qc;
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); download.mockReset(); Object.values(toast).forEach((f) => f.mockReset());
  get.mockImplementation(async (url) => (url === '/api/carriers' ? PAGE : { items: [] }));
});

describe('Carrier list', () => {
  it('exports with the filters and order on screen, and shows why an export was refused', async () => {
    download.mockRejectedValueOnce(Object.assign(new Error('An export is already running for your account. Try again when it finishes.'), { status: 409 }));
    renderIt('/app/carriers?state=TX&sort=companyName&dir=asc');
    await waitFor(() => expect(screen.getAllByText('Lone Star Haulers').length).toBeGreaterThan(0));
    expect(get).toHaveBeenCalledWith('/api/carriers', expect.objectContaining({ state: 'TX', sort: 'companyName', dir: 'asc' }), expect.objectContaining({ signal: expect.anything() }));
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ status: 409 })));
    expect(download).toHaveBeenCalledWith('/api/carriers/export.csv?state=TX&sort=companyName&dir=asc', 'carriers.csv');
  });

  it('shows the lead score, sorts by it and filters by tier', async () => {
    get.mockImplementation(async (url) => (url === '/api/carriers' ? { ...PAGE, items: [{ ...CARRIER, leadScore: 82, leadTier: 'A' }] } : { items: [] }));
    renderIt('/app/carriers');
    expect((await screen.findAllByText('A · 82')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Lead score' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/carriers', expect.objectContaining({ sort: 'leadScore', dir: 'asc' }), expect.anything()));
    fireEvent.click(screen.getByLabelText('Lead tier'));
    fireEvent.click(screen.getByRole('option', { name: 'Tier A (75+)' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/carriers', expect.objectContaining({ leadTier: 'A' }), expect.anything()));
    fireEvent.click(screen.getByLabelText('Lead tier'));
    fireEvent.click(screen.getByRole('option', { name: 'Not scored' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/carriers', expect.objectContaining({ leadTier: 'unscored' }), expect.anything()));
  });

  it('keeps the loaded page on screen when a refresh fails', async () => {
    const qc = renderIt('/app/carriers');
    await waitFor(() => expect(screen.getAllByText('Lone Star Haulers').length).toBeGreaterThan(0));
    get.mockImplementation(async (url) => { if (url === '/api/carriers') throw Object.assign(new Error('Bad gateway'), { status: 502 }); return { items: [] }; });
    await act(async () => { await qc.invalidateQueries({ queryKey: ['carriers'] }); });
    expect(await screen.findByText(/Couldn't refresh/)).toBeInTheDocument();
    expect(screen.getAllByText('Lone Star Haulers').length).toBeGreaterThan(0);
    expect(screen.queryByText('Could not load this')).toBeNull();
  });
});
