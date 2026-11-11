import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn(), del: vi.fn() } }));
const { default: ConsolidateModal } = await import('./ConsolidateModal.jsx');

const load = (id, ref, from, to, pickup, delivery) => ({
  id, referenceNumber: ref, status: 'booked', carrierId: 'c1', rateCents: 150000, broker: { id: 'b', companyName: 'Acme Logistics' },
  origin: { city: from, state: 'TX', lat: 32.7, lng: -96.8 }, dest: { city: to, state: 'TN', lat: 35.1, lng: -90 },
  pickupWindowStart: pickup, pickupWindowEnd: null, pickupDate: null, deliveryWindowStart: delivery, deliveryWindowEnd: null, deliveryDate: null,
  consolidation: null,
});

function renderModal(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><ToastProvider><ConfirmProvider>
      <ConsolidateModal carrierId="c1" carrierName="Two Rivers Freight" onClose={() => {}} {...props} />
    </ConfirmProvider></ToastProvider></QueryClientProvider>,
  );
}

describe('Consolidate dialog', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({
      carrier: { id: 'c1', companyName: 'Two Rivers Freight' }, maxLoads: 6, unassigned: [],
      loads: [load('l1', '101', 'Dallas', 'Memphis', '2026-11-12T14:00:00Z', '2026-11-13T20:00:00Z'), load('l2', '102', 'Waco', 'Nashville', '2026-11-12T16:00:00Z', '2026-11-13T15:00:00Z')],
    });
  });

  it('orders the stops by time, blocks a delivery before its pickup, and sends the order', async () => {
    renderModal({ initialLoadIds: ['l1', 'l2'] });
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(2));
    const stops = () => within(screen.getAllByRole('list').at(-1)).getAllByRole('listitem').map((li) => li.textContent);
    expect(stops()[0]).toContain('Pickup · Dallas, TX');
    expect(stops()[1]).toContain('Pickup · Waco, TX');
    expect(stops()[2]).toContain('Delivery · Nashville, TN');
    expect(screen.getByText(/Straight-line estimate/)).toBeInTheDocument();

    // Move the Nashville delivery above the Waco pickup: not allowed.
    fireEvent.click(screen.getByRole('button', { name: 'Move stop 3 up' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Load #102 is delivered before it is picked up');
    expect(screen.getByRole('button', { name: 'Create trip' })).toBeDisabled();

    // Back below its pickup, then the Memphis delivery before the Nashville one.
    fireEvent.click(screen.getByRole('button', { name: 'Move stop 2 down' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move stop 4 up' }));
    expect(screen.queryByRole('alert')).toBeNull();
    post.mockResolvedValue({ consolidation: { id: 't1', route: { miles: 900, minutes: 840 } } });
    fireEvent.click(screen.getByRole('button', { name: 'Create trip' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/consolidations');
    expect(body.loadIds).toEqual(['l1', 'l2']);
    expect(body.stops.map((s) => `${s.loadId}:${s.kind}`)).toEqual(['l1:pickup', 'l2:pickup', 'l1:delivery', 'l2:delivery']);
  });

  it('needs two loads before a trip can be made', async () => {
    renderModal({ initialLoadIds: ['l1'] });
    await waitFor(() => expect(screen.getByText('Pick at least 2 loads to set the stop order.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create trip' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Pick Load #102' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create trip' })).toBeEnabled());
  });
});
