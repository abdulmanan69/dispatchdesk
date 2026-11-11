import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import TodayItem, { tripFromItem } from './TodayItem.jsx';

vi.mock('../calling/CallButton.jsx', () => ({ default: ({ phone, label }) => <button type="button">{label} {phone}</button> }));

const load = { id: 'L1', referenceNumber: 'ACME-778', status: 'in_transit', origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' } };
const carrier = { id: 'C1', companyName: 'Lone Star Haulers', phone: '2145550101' };
const wrap = (ui) => render(<MemoryRouter><ul>{ui}</ul></MemoryRouter>);

describe('Today board rows', () => {
  it('a late delivery offers a call, a check call, a tracking link and the map', () => {
    const onCheckCall = vi.fn();
    const onTrackingLink = vi.fn();
    const item = {
      id: 'appt:L1:delivery', section: 'appointments', kind: 'delivery', priority: 0, risk: 'late', title: 'Delivery in Memphis, TN',
      window: { start: '2026-11-10T15:00:00Z', end: '2026-11-10T15:00:00Z', tz: 'America/Chicago' }, eta: '2026-11-10T20:00:00Z', legalEta: '2026-11-11T08:00:00Z', load, carrier,
    };
    wrap(<TodayItem item={item} onCheckCall={onCheckCall} onTrackingLink={onTrackingLink} />);
    expect(screen.getByText('Late')).toBeInTheDocument();
    expect(screen.getByText(/Call 2145550101/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Log check call/ }));
    expect(onCheckCall).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole('button', { name: /Tracking link/ }));
    expect(onTrackingLink).toHaveBeenCalledWith(item);
    expect(screen.getByRole('link', { name: /Map/ })).toHaveAttribute('href', '/app/fleet?truck=C1&trip=L1');
    expect(screen.getByText(/ETA/)).toBeInTheDocument();
  });

  it('an empty truck offers posting it; an overdue invoice links to invoices', () => {
    const truck = { id: 'truck:C2', section: 'available_trucks', priority: 1, title: 'Idle Wheels needs a load', location: 'Tulsa, OK', carrier: { id: 'C2', companyName: 'Idle Wheels', phone: null } };
    const inv = { id: 'invoice:I1', section: 'invoices', priority: 0, title: 'Invoice #4 overdue: Slow Pay', at: '2026-11-01T00:00:00Z', invoice: { id: 'I1', number: 4, balanceCents: 120000, dueAt: '2026-11-01T00:00:00Z' } };
    wrap(<><TodayItem item={truck} onCheckCall={() => {}} onTrackingLink={() => {}} /><TodayItem item={inv} onCheckCall={() => {}} onTrackingLink={() => {}} /></>);
    expect(screen.getByRole('link', { name: 'Post truck' })).toHaveAttribute('href', '/app/truck-posts?truck=C2');
    expect(screen.getByText(/In Tulsa, OK/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open invoice/ })).toHaveAttribute('href', '/app/invoices?status=overdue&open=I1');
    expect(screen.getByText(/\$1,200.00 open/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Log check call/ })).toBeNull();
  });

  it('detention and a missing POD open the load on the matching tab', () => {
    const dwell = { id: 'dwell:L1:pickup', section: 'detention', priority: 0, title: 'Detention running at pickup', running: true, dwellMin: 200, freeMin: 120, detentionMin: 80, load, carrier: { id: 'C1', companyName: 'Fast Freight', phone: null } };
    const pod = { id: 'pod:L1', section: 'missing_pod', priority: 2, title: 'POD missing', at: '2026-11-01T00:00:00Z', load, carrier: null };
    wrap(<><TodayItem item={dwell} onCheckCall={() => {}} onTrackingLink={() => {}} /><TodayItem item={pod} onCheckCall={() => {}} onTrackingLink={() => {}} /></>);
    expect(screen.getByRole('link', { name: /Stop times/ })).toHaveAttribute('href', '/app/loads?load=L1&tab=stops');
    expect(screen.getByRole('link', { name: /Add POD/ })).toHaveAttribute('href', '/app/loads?load=L1&tab=documents');
  });

  it('turns a row into the trip shape the modals use', () => {
    expect(tripFromItem({ load, broker: { id: 'B1', companyName: 'Acme' } })).toMatchObject({ id: 'L1', origin: { city: 'Dallas' }, broker: { companyName: 'Acme' } });
    expect(tripFromItem({})).toBeNull();
  });
});
