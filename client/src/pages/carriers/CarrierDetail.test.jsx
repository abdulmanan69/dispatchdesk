import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const post = vi.fn();
const confirm = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn(), del: vi.fn() } }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../components/Modal.jsx', () => ({ useConfirm: () => confirm, Modal: () => null }));
vi.mock('../../components/calling/CallButton.jsx', () => ({ default: ({ phone }) => <span>{phone}</span> }));
for (const path of ['CarrierForm', 'LogCallModal', 'FollowUpModal', 'EnrollModal', 'EnrichModal', 'TextLogModal', 'DieselCard', 'ActivityRail']) {
  vi.doMock(`../../components/carriers/${path}.jsx`, () => ({ default: () => null }));
}
vi.mock('../../components/documents/DocumentsPanel.jsx', () => ({ default: ({ carrierId }) => <div data-testid="documents-panel">{carrierId}</div> }));
vi.mock('../../components/email/ComposeModal.jsx', () => ({ default: () => null }));

const { default: CarrierDetail } = await import('./CarrierDetail.jsx');

const CARRIER = {
  id: 'c1', companyName: 'Lone Star Haulers', dbaName: null, dotNumber: '123456', mcNumber: '654321', phone: '2145550101', email: 'ops@lonestar.test',
  city: 'Dallas', state: 'TX', zip: null, address: null, timezone: 'America/Chicago', equipment: 'dry_van', fleetSize: 3, drivers: 3,
  authorityStatus: 'active', authorityDate: null, operatingStatus: null, classification: null, carrierOperation: null, source: 'manual', verifiedAt: null,
  stage: { key: 'prospecting', name: 'Prospecting', color: '#64748b' }, owner: { id: 'u1', name: 'Me' }, assignedTo: null, priority: 0,
  doNotCall: false, doNotEmail: false, lastContactedAt: null, nextFollowUpAt: null, createdAt: '2026-11-01T12:00:00Z',
  contacts: [], notes: [], calls: [], followUps: [], lists: [], tags: [], opportunity: null, customer: null,
  enrollments: [{
    id: 'e1', status: 'active', currentStep: 1, nextStepAt: '2026-11-10T15:00:00Z', startedAt: '2026-11-05T12:00:00Z', stopReason: null,
    sequence: { id: 's1', name: 'New authority intro', stepCount: 3 }, step: { type: 'call', dayOffset: 2, order: 2 },
  }],
  _count: { emails: 0, documents: 0, loads: 0, activities: 0, calls: 0, notes: 0, contacts: 0 }, followUpCounts: { pending: 0 }, activityCounts: { calls: 0, emails: 0, texts: 0 },
};
const DETAIL = { carrier: CARRIER, callWindow: { timezone: 'America/Chicago', callable: true, localTime: '10:00 AM', localWeekday: 'Tue', recommendation: 'Good time to call' }, canWrite: true };

function renderIt(path = '/app/carriers/c1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><Routes><Route path="/app/carriers/:id" element={<CarrierDetail />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); confirm.mockReset(); Object.values(toast).forEach((f) => f.mockReset());
  get.mockImplementation(async (url) => (url === '/api/carriers/c1' ? DETAIL : { items: [] }));
  post.mockResolvedValue({ ok: true, stopped: 1 });
  confirm.mockResolvedValue(true);
});

describe('Carrier profile', () => {
  it('opens the Documents tab from a document link (?doc=)', async () => {
    renderIt('/app/carriers/c1?doc=d1');
    await waitFor(() => expect(screen.getByRole('tab', { name: /Documents/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByTestId('documents-panel')).toHaveTextContent('c1');
  });

  it('sends the step on screen with "Mark step done" and "Skip step", so a stale click gets refused', async () => {
    renderIt();
    fireEvent.click(await screen.findByRole('tab', { name: /Sequences/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark step done' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/sequences/enrollments/e1/complete-step', { stepIndex: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip step' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/sequences/enrollments/e1/skip-step', { stepIndex: 1 }));
  });

  it('"Mark replied" asks first when a sequence is running, then logs the reply for the carrier', async () => {
    renderIt();
    fireEvent.click(await screen.findByRole('tab', { name: /Sequences/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark replied' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/carriers/c1/replied'));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Mark replied' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reply logged and 1 sequence stopped'));
  });

  it('shows who a customer factors with in the header, and nothing for a carrier that does not factor', async () => {
    renderIt();
    expect(await screen.findByRole('heading', { name: 'Lone Star Haulers' })).toBeInTheDocument();
    expect(screen.queryByText(/^Factors with/)).toBeNull();
    const customer = { id: 'cu1', status: 'active', signedAt: '2026-11-01T12:00:00Z', dispatchFeePercent: 8, factoringCompanyId: 'f1', factoringCompany: { id: 'f1', name: 'Apex Capital' } };
    get.mockImplementation(async (url) => (url === '/api/carriers/c2' ? { ...DETAIL, carrier: { ...CARRIER, id: 'c2', customer } } : { items: [] }));
    renderIt('/app/carriers/c2');
    expect(await screen.findByText('Factors with Apex Capital')).toBeInTheDocument();
  });

  it('keeps the profile on screen when a refresh fails', async () => {
    const qc = renderIt();
    expect(await screen.findByRole('heading', { name: 'Lone Star Haulers' })).toBeInTheDocument();
    get.mockImplementation(async () => { throw Object.assign(new Error('Bad gateway'), { status: 502 }); });
    await act(async () => { await qc.invalidateQueries({ queryKey: ['carrier', 'c1'] }); });
    expect(await screen.findByText(/Couldn't refresh/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lone Star Haulers' })).toBeInTheDocument();
  });
});
