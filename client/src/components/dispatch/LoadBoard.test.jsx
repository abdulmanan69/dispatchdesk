import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: LoadBoard, moveCheck, moveCard, appendPage, stopLabel } = await import('./LoadBoard.jsx');

const card = (id, status, extra = {}) => ({ id, status, referenceNumber: id.toUpperCase(), originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', rateCents: 200000, loadedMiles: 800, ratePerMile: 2.5, ...extra });
const columns = () => [
  { status: 'planned', total: 2, page: 1, pageSize: 50, items: [card('a', 'planned'), card('b', 'planned')] },
  { status: 'booked', total: 1, page: 1, pageSize: 50, items: [card('c', 'booked')] },
  { status: 'in_transit', total: 0, page: 1, pageSize: 50, items: [] },
  { status: 'delivered', total: 0, page: 1, pageSize: 50, items: [] },
  { status: 'invoiced', total: 0, page: 1, pageSize: 50, items: [] },
  { status: 'paid', total: 0, page: 1, pageSize: 50, items: [] },
];

describe('board move rules', () => {
  it('lets forward moves through and asks before backward moves, reopening or canceling finished work', () => {
    expect(moveCheck('planned', 'booked')).toEqual({ ok: true });
    expect(moveCheck('booked', 'paid')).toEqual({ ok: true });
    expect(moveCheck('booked', 'booked')).toMatchObject({ noop: true });
    expect(moveCheck('in_transit', 'canceled')).toEqual({ ok: true });
    expect(moveCheck('delivered', 'booked')).toMatchObject({ needsConfirm: true, reason: 'Move this load back from delivered to booked?' });
    expect(moveCheck('paid', 'canceled')).toMatchObject({ needsConfirm: true, reason: 'This load is already paid. Cancel it anyway?' });
    expect(moveCheck('canceled', 'planned')).toMatchObject({ needsConfirm: true, reason: 'This load was canceled. Reopen it as planned?' });
    expect(moveCheck('planned', 'lost')).toMatchObject({ ok: false });
  });

  it('moves a card to the top of its new column and keeps totals in step', () => {
    const next = moveCard(columns(), 'b', 'booked');
    expect(next[0]).toMatchObject({ total: 1 });
    expect(next[0].items.map((l) => l.id)).toEqual(['a']);
    expect(next[1].total).toBe(2);
    expect(next[1].items.map((l) => [l.id, l.status])).toEqual([['b', 'booked'], ['c', 'booked']]);
    // Canceled while that column is hidden: the card just leaves the board.
    const gone = moveCard(columns(), 'c', 'canceled');
    expect(gone[1]).toMatchObject({ total: 0, items: [] });
    expect(gone.flatMap((c) => c.items).map((l) => l.id)).toEqual(['a', 'b']);
    // Unknown card or same status: unchanged.
    const cols = columns();
    expect(moveCard(cols, 'zzz', 'paid')).toBe(cols);
    expect(moveCard(cols, 'a', 'planned')).toBe(cols);
  });

  it('appends a "load more" page without repeating cards', () => {
    const next = appendPage(columns(), { status: 'planned', total: 3, page: 2, items: [card('b', 'planned'), card('d', 'planned')] });
    expect(next[0]).toMatchObject({ total: 3, page: 2 });
    expect(next[0].items.map((l) => l.id)).toEqual(['a', 'b', 'd']);
  });

  it('labels stops in the facility time zone, or by date', () => {
    expect(stopLabel(card('a', 'planned', { pickupWindowStart: '2026-11-12T15:00:00Z', pickupTz: 'America/Denver' }), 'pickup')).toBe('Nov 12, 8:00 AM MST');
    expect(stopLabel(card('a', 'planned'), 'delivery')).toBeNull();
  });
});

describe('LoadBoard', () => {
  const wrap = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><ToastProvider><ConfirmProvider><LoadBoard onOpen={() => {}} /></ConfirmProvider></ToastProvider></QueryClientProvider>);
  };
  const column = (name) => screen.getByRole('region', { name: new RegExp(`^${name},`) });
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.get.mockResolvedValue({ columns: columns() });
  });

  it('moves a card from the menu and puts it back with an error toast when the server refuses', async () => {
    let fail;
    api.post.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    wrap();
    await screen.findByText('#A');
    fireEvent.click(within(column('Planned')).getByRole('button', { name: 'Move load A' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Booked' }));
    // Optimistic: already in Booked while the request runs.
    await waitFor(() => expect(within(column('Booked')).getByText('#A')).toBeInTheDocument());
    expect(within(column('Planned')).queryByText('#A')).toBeNull();
    expect(api.post).toHaveBeenCalledWith('/api/loads/a/status', { status: 'booked' });
    fail(Object.assign(new Error('Read-only access'), { status: 403 }));
    await waitFor(() => expect(within(column('Planned')).getByText('#A')).toBeInTheDocument());
    expect(within(column('Booked')).queryByText('#A')).toBeNull();
    expect(await screen.findByText('Read-only access')).toBeInTheDocument();
  });

  it('keeps the move and confirms it when the server accepts', async () => {
    api.post.mockResolvedValue({ load: { id: 'c', status: 'in_transit' }, paperwork: { missing: [] } });
    wrap();
    await screen.findByText('#C');
    fireEvent.click(within(column('Booked')).getByRole('button', { name: 'Move load C' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'In Transit' }));
    expect(await screen.findByText('Load marked In Transit')).toBeInTheDocument();
    expect(within(column('In Transit')).getByText('#C')).toBeInTheDocument();
    expect(within(column('Booked')).queryByText('#C')).toBeNull();
  });
});
