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
vi.mock('../../components/carriers/ReadinessReport.jsx', () => ({ default: () => null }));

const { default: NewAuthority } = await import('./NewAuthority.jsx');

const rec = (dot, extra = {}) => ({
  dotNumber: dot, companyName: `NEW ${dot} LLC`, mcNumber: `15${dot}`, phone: '6145550101', email: null, city: 'COLUMBUS', state: 'OH',
  authorityDate: '2026-10-20T00:00:00.000Z', ageDays: 21, fleetSize: 1, existsInCrm: false, existingId: null, teamClaims: [], docketStatus: 'active', cargo: [], ...extra,
});
const LIST = {
  items: [rec('8100001'), rec('8100002', { teamClaims: [{ ownerName: 'Ana' }] }), rec('8100003', { existsInCrm: true, existingId: 'c3' })],
  window: { key: 'new30', label: 'Registered in the last 30 days' }, newestRecord: '2026-11-05', source: 'FMCSA Company Census', retrievedAt: '2026-11-10T12:00:00Z',
  note: null, offset: 0, limit: 50, hasMore: false, milestones: [], cargoOptions: [], equipmentOptions: [],
};

function renderIt(path = '/app/new-authority?state=OH') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><NewAuthority /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); confirm.mockReset(); Object.values(toast).forEach((f) => f.mockReset());
  get.mockImplementation(async (url) => (url === '/api/sequences' ? { items: [] } : LIST));
});

describe('NewAuthority page', () => {
  it('asks for a state before reading the census', () => {
    try { localStorage.removeItem('dd:new-authority:state'); } catch { /* storage unavailable */ }
    renderIt('/app/new-authority');
    expect(screen.getByText(/New registrations come from the public FMCSA census, one state at a time/)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith('/api/authority-kit/milestones', expect.anything(), expect.anything());
  });

  it('lists carriers with their CRM status and adds one after the teammate warning', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('Ana already has this carrier. Check with them before adding.'), { status: 409 }));
    post.mockResolvedValueOnce({ created: 1, skipped: 0, limited: 0, notFound: 0 });
    confirm.mockResolvedValue(true);
    renderIt();
    await waitFor(() => expect(screen.getAllByText('NEW 8100002 LLC').length).toBeGreaterThan(0));
    expect(get).toHaveBeenCalledWith('/api/authority-kit/milestones', expect.objectContaining({ state: 'OH', window: 'new30' }), expect.anything());
    expect(screen.getAllByText('In your list').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add NEW 8100002 LLC to my list' })[0]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Added 1 to your list'));
    expect(post).toHaveBeenNthCalledWith(1, '/api/authority-kit/claim', { dotNumbers: ['8100002'], sequenceId: null });
    expect(post).toHaveBeenNthCalledWith(2, '/api/authority-kit/claim', { dotNumbers: ['8100002'], sequenceId: null, force: true });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Add anyway' }));
  });
});
