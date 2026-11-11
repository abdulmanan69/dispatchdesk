import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import DriverTrack from './DriverTrack.jsx';

const stop = (loadId, kind, status, city, facility, ref) => ({
  loadId, kind, status, referenceNumber: ref, city, state: 'NE', facility, address: null, lat: null, lng: null,
  date: null, windowStart: null, windowEnd: null, tz: 'America/Chicago',
});
const INFO = {
  company: 'Granite Peak Hauling', dispatcher: 'Ivy', driverName: 'Jo', status: 'sharing', consentAt: '2026-11-11T10:00:00Z',
  expiresAt: '2026-11-12T10:00:00Z', lastAt: null, minIntervalSec: 30, pinRequired: false, pinEnabled: false, bound: true,
  uploads: { types: ['pod'], maxMb: 8, perDay: 20, left: 20 },
  trip: {
    id: 'A', status: 'in_transit', referenceNumber: 'GP-A', equipment: null, commodity: null,
    pickup: stop('A', 'pickup', 'in_transit', 'Denver', 'Front Range Foods'), delivery: stop('A', 'delivery', 'in_transit', 'Omaha', 'Omaha Grocers'),
    consolidation: {
      id: 'c1',
      stops: [
        stop('B', 'pickup', 'in_transit', 'Boulder', 'Flatiron Paper', 'GP-B'),
        stop('A', 'pickup', 'in_transit', 'Denver', 'Front Range Foods', 'GP-A'),
        stop('A', 'delivery', 'in_transit', 'Omaha', 'Omaha Grocers', 'GP-A'),
        stop('B', 'delivery', 'in_transit', 'Lincoln', 'Lincoln Office Supply', 'GP-B'),
      ],
    },
  },
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/track/tok123']}>
      <Routes><Route path="/track/:token" element={<DriverTrack />} /></Routes>
    </MemoryRouter>,
  );
}

describe('driver page with a consolidated trip', () => {
  let calls;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (String(url).endsWith('/checkin')) return new Response(JSON.stringify({ ok: true, tripStatus: 'delivered', at: new Date().toISOString() }), { status: 200 });
      return new Response(JSON.stringify(INFO), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists every stop in order and checks in at the current stop\'s load', async () => {
    renderPage();
    const list = await screen.findByRole('list', { name: 'Stops in order' });
    const items = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('Flatiron Paper');
    expect(items[1]).toContain('Front Range Foods');
    expect(items[2]).toContain('Omaha Grocers');
    expect(items[3]).toContain('Lincoln Office Supply');
    expect(screen.getByText('2 of 4 stops done')).toBeInTheDocument();
    // Both pickups are done (loads in transit): the first delivery is current, with its two check-ins.
    expect(items[2]).toContain('Current stop');
    expect(screen.queryByRole('button', { name: /Arrived at pickup/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Delivered/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/checkin'))).toBe(true));
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/checkin')).body);
    expect(sent).toMatchObject({ event: 'delivered', loadId: 'A' });
    // After delivery the page stays on that stop (its POD goes to load A) until the driver moves on.
    expect(await screen.findByText(/Get the receiver's signature or send a photo/)).toBeInTheDocument();
    expect(screen.getByText(/Stop 3: Omaha Grocers/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Get signature/ }));
    expect(within(await screen.findByRole('dialog')).getByText('Omaha Grocers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));
    fireEvent.click(screen.getByRole('button', { name: /Next stop: Lincoln Office Supply/ }));
    expect(screen.getByText(/Stop 4: Lincoln Office Supply/)).toBeInTheDocument();
  });

  it('picking another stop sends its load and "Get signature" opens the signing view', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Stops in order' });
    const getSig = screen.getAllByRole('button', { name: /Get signature/ });
    fireEvent.click(getSig[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Proof of delivery' });
    expect(within(dialog).getByText('Omaha Grocers')).toBeInTheDocument();
    // Saving needs the receiver's name and a signature.
    fireEvent.click(within(dialog).getByRole('button', { name: /Save signed POD/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter the receiver\'s printed name.');
    fireEvent.change(within(dialog).getByLabelText(/Receiver's printed name/), { target: { value: 'Pat Kim' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save signed POD/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Ask the receiver to sign in the box.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getAllByRole('button', { name: 'Check in at this stop' })[0]);
    expect(screen.getByText(/Stop 1: Flatiron Paper/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Loaded/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/checkin'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/checkin')).body)).toMatchObject({ event: 'loaded', loadId: 'B' });
  });
});
