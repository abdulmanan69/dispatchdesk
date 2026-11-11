import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', timezone: 'America/Chicago' } }) }));
vi.mock('./FitCard.jsx', () => ({ default: () => null }));
vi.mock('./DetentionPanel.jsx', () => ({ default: () => null }));
vi.mock('./LoadForm.jsx', () => ({ default: () => null }));
vi.mock('./LoadStatus.jsx', () => ({ LoadStatusSelect: () => <span>status picker</span> }));
vi.mock('../documents/DocumentsPanel.jsx', () => ({ default: ({ types }) => <p>Document types: {types.join(',')}</p> }));
vi.mock('../carriers/TextLogModal.jsx', () => ({
  default: ({ carrier, loadId, category, title }) => <p>{`Texting: ${title} | ${carrier.phone} | ${loadId} | ${category}`}</p>,
}));
vi.mock('../carriers/ReloadIdeas.jsx', () => ({
  default: ({ state, city, equipment, title }) => <p>{`${title}: ${city}, ${state}, ${equipment}`}</p>,
}));

const { default: LoadDetailModal } = await import('./LoadDetail.jsx');

const LOAD = {
  id: 'l1', status: 'booked', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', equipment: 'reefer',
  rateCents: 200000, loadedMiles: 800, deadheadMiles: 0, createdAt: '2026-11-09T12:00:00Z', documents: [],
  carrier: { id: 'c1', companyName: 'Blue Line Trucking', phone: '2145550100', doNotCall: false, state: 'TX' },
  broker: null, fit: { warnings: [] }, calc: { ratePerMile: 2.5, grossCents: 200000, carrierNetCents: 184000 },
};

function show(load) {
  api.get.mockImplementation((url) => Promise.resolve(url === '/api/loads/l1'
    ? { load, events: [], detention: { running: false }, invoices: [] }
    : {}));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><ToastProvider><ConfirmProvider>
      <LoadDetailModal id="l1" onClose={() => {}} />
    </ConfirmProvider></ToastProvider></MemoryRouter></QueryClientProvider>,
  );
}

describe('LoadDetailModal', () => {
  beforeEach(() => api.get.mockReset());

  it('shows reload ideas near the delivery for a booked load and texts the carrier with driver templates', async () => {
    show(LOAD);
    expect(await screen.findByText('Reload ideas near delivery: Atlanta, GA, reefer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Text carrier' }));
    expect(screen.getByText('Texting: Text Blue Line Trucking | 2145550100 | l1 | driver')).toBeInTheDocument();
  });

  it('leaves reload ideas out once the load is delivered, and has no text action without a carrier', async () => {
    show({ ...LOAD, status: 'delivered', carrier: null });
    expect(await screen.findByRole('button', { name: 'Edit load' })).toBeInTheDocument();
    expect(screen.queryByText(/Reload ideas near delivery/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Text carrier' })).not.toBeInTheDocument();
  });

  it('lists receipts sent from the driver link with the load documents', async () => {
    show(LOAD);
    fireEvent.click(await screen.findByRole('tab', { name: /Documents/ }));
    expect(screen.getByText(/Document types: .*lumper_receipt,scale_ticket,fuel_receipt/)).toBeInTheDocument();
  });
});
