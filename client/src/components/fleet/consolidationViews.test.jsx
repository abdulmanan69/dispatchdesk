import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

vi.mock('maplibre-gl', () => ({ default: {} }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('../calling/CallButton.jsx', () => ({ default: () => null }));
vi.mock('../carriers/ReloadIdeas.jsx', () => ({ default: () => null }));
vi.mock('./TripPlan.jsx', () => ({ default: () => null }));
const get = vi.fn();
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: vi.fn(), patch: vi.fn(), del: vi.fn() } }));

const { buildTrips } = await import('./FleetMap.jsx');
const { default: TruckPanel } = await import('./TruckPanel.jsx');

const trip = (id, status, from, to) => ({ id, status, origin: { city: from[2], lat: from[0], lng: from[1] }, dest: { city: to[2], lat: to[0], lng: to[1] }, rateCents: 1000, route: null });
const DAL = [32.78, -96.8, 'Dallas'];
const MEM = [35.15, -90.05, 'Memphis'];
const WACO = [31.55, -97.15, 'Waco'];
const NSH = [36.16, -86.78, 'Nashville'];
const CONS = {
  id: 'k1', carrierId: 't1', status: 'in_transit', loadIds: ['a', 'b'], estimate: false,
  points: [[-96.8, 32.78], [-97.15, 31.55], [-90.05, 35.15], [-86.78, 36.16]],
  stops: [
    { n: 1, kind: 'pickup', lat: 32.78, lng: -96.8, city: 'Dallas', done: true },
    { n: 2, kind: 'pickup', lat: 31.55, lng: -97.15, city: 'Waco' },
    { n: 3, kind: 'delivery', lat: 35.15, lng: -90.05, city: 'Memphis' },
    { n: 4, kind: 'delivery', lat: 36.16, lng: -86.78, city: 'Nashville' },
  ],
};

describe('consolidated trips on the fleet map', () => {
  it('draws one route with numbered stops instead of the grouped loads, and keeps other trips', () => {
    const truck = { id: 't1', location: { lat: 31.9, lng: -97.0 }, trips: [trip('a', 'in_transit', DAL, MEM), trip('b', 'booked', WACO, NSH), trip('c', 'planned', MEM, DAL)] };
    const out = buildTrips([truck], new Map(), new Map(), [{ ...CONS, stops: [...CONS.stops, { n: 5, kind: 'delivery', lat: 36.16, lng: -86.78, city: 'Nashville' }] }]);
    const ids = new Set(out.lines.features.map((f) => f.properties.id));
    expect(ids.has('c:k1')).toBe(true);
    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(false);
    expect(ids.has('c')).toBe(true);
    // In transit with a known position: split at the truck into driven and ahead.
    expect(out.lines.features.filter((f) => f.properties.id === 'c:k1').map((f) => f.properties.part).sort()).toEqual(['ahead', 'done']);
    // Stops at the same place share one marker.
    expect(out.stops.features.map((f) => f.properties.label)).toEqual(['1', '2', '3', '4, 5']);
    expect(out.stops.features[0].properties.done).toBe(true);
    // The grouped loads' own ends are not drawn; the other trip's are.
    expect(out.ends.features).toHaveLength(2);
  });

  it('shows the consolidated trip in the truck panel with numbered stops and the next stop action', async () => {
    get.mockImplementation(async (url) => {
      if (url === '/api/consolidations') {
        return { items: [{
          id: 'k1', carrierId: 't1', name: null, title: 'Dallas, TX → Nashville, TN · 2 loads', status: 'in_transit', loadIds: ['a', 'b'], risk: 'at_risk',
          loads: [{ id: 'a', status: 'in_transit' }, { id: 'b', status: 'booked' }],
          route: { miles: 912, minutes: 830, estimate: false, current: true, pending: false },
          stops: [
            { n: 1, loadId: 'a', kind: 'pickup', done: true, city: 'Dallas', state: 'TX', facility: 'North dock', window: null, load: { referenceNumber: '101', broker: { companyName: 'Acme' } } },
            { n: 2, loadId: 'b', kind: 'pickup', done: false, city: 'Waco', state: 'TX', facility: null, window: { start: '2026-11-12T16:00:00Z', end: '2026-11-12T18:00:00Z', tz: 'America/Chicago' }, eta: '2026-11-12T17:00:00Z', risk: 'at_risk', load: { referenceNumber: '102', broker: { companyName: 'Blue Freight' } } },
            { n: 3, loadId: 'a', kind: 'delivery', done: false, city: 'Memphis', state: 'TN', window: null, load: { referenceNumber: '101', broker: null } },
            { n: 4, loadId: 'b', kind: 'delivery', done: false, city: 'Nashville', state: 'TN', window: null, load: { referenceNumber: '102', broker: null } },
          ],
        }] };
      }
      return { plan: null };
    });
    const onAdvance = vi.fn();
    const truck = {
      id: 't1', companyName: 'Two Rivers Freight', truckStatus: 'loaded', live: {}, location: { city: 'Waco', state: 'TX', lat: 31.5, lng: -97.1 },
      trips: [trip('a', 'in_transit', DAL, MEM), trip('b', 'booked', WACO, NSH)],
    };
    truck.currentTrip = truck.trips[0];
    truck.nextTrip = truck.trips[1];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter><QueryClientProvider client={qc}><ToastProvider><ConfirmProvider>
        <TruckPanel truck={truck} onClose={() => {}} onPlan={() => {}} onEdit={() => {}} onAdvance={onAdvance} onShowRoute={() => {}} onTrail={() => {}} />
      </ConfirmProvider></ToastProvider></QueryClientProvider></MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Dallas, TX → Nashville, TN · 2 loads')).toBeInTheDocument());
    expect(screen.getByText(/912 road mi/)).toBeInTheDocument();
    expect(screen.getByText('Pickup · Waco, TX')).toBeInTheDocument();
    expect(screen.getByText('Load #102 · Blue Freight')).toBeInTheDocument();
    expect(screen.getAllByText('At risk').length).toBeGreaterThan(0);
    // Grouped loads already: no second Consolidate button, but the trip's stops can be edited.
    expect(screen.queryByRole('button', { name: 'Consolidate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit stops' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark stop 2 picked up' }));
    expect(onAdvance).toHaveBeenCalledWith('b', 'in_transit');
  });
});
