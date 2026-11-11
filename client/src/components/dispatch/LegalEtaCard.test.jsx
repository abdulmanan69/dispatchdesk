import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(async () => ({ items: [] })), post: vi.fn(), patch: vi.fn(), upload: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', timezone: 'America/Chicago' } }) }));
const { default: LegalEtaCard, hoursLeftFrom, planEtaBody, summaryLine, VERDICT } = await import('./LegalEtaCard.jsx');
const { formToEtaInput, loadToForm } = await import('./LoadForm.jsx');

const DAL = { city: 'Dallas', state: 'TX', lat: 32.777, lng: -96.797 };
const MEM = { city: 'Memphis', state: 'TN' };

const RESULT = {
  miles: 452, minutes: 410, routeSource: 'osrm', verdict: 'at_risk', breaks: 1, resets: 0, restarts: 0,
  driveEta: '2026-11-16T22:50:00.000Z', legalEta: '2026-11-16T23:20:00.000Z', deliveryTz: 'America/New_York', pickupTz: 'America/Chicago',
  pickup: null, hours: { source: 'assumed', clocks: null },
  explanation: 'The driver can legally arrive only 40 min before the delivery appointment ends, with 1 30-minute break on the way, so any delay makes it late.',
  assumptions: ['No hours left entered: this assumes a rested driver with 11 h drive, 14 h duty and 70 h cycle.'],
};

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('legal ETA card logic', () => {
  it('reads hours left as 6:30 or 6.5 and refuses unreadable or impossible values', () => {
    expect(hoursLeftFrom({ drive: '', duty: '', cycle: '' })).toEqual({ hoursLeft: null, error: null });
    expect(hoursLeftFrom({ drive: '6:30', duty: '9.5', cycle: '' })).toEqual({ hoursLeft: { drive: 6.5, duty: 9.5 }, error: null });
    expect(hoursLeftFrom({ cycle: '70' }).hoursLeft).toEqual({ cycle: 70 });
    expect(hoursLeftFrom({ drive: 'six' }).error).toBe('Write hours as 6:30 or 6.5');
    expect(hoursLeftFrom({ drive: '12' }).error).toBe('At most 11, 14 and 70 hours');
    expect(hoursLeftFrom({ cycle: '71' }).hoursLeft).toBeNull();
  });

  it('builds the request only once pickup and delivery are known', () => {
    expect(planEtaBody(null)).toBeNull();
    expect(planEtaBody({ origin: DAL, dest: { city: 'Memphis', state: '' } })).toBeNull();
    expect(planEtaBody({ origin: { city: ' ', state: 'TX' }, dest: MEM })).toBeNull();
    const body = planEtaBody({
      origin: DAL, dest: MEM, carrierId: 'c1', loadId: null, startAt: '', pickupWindowStart: '', deliveryWindowStart: '2026-11-16T18:00',
      deadhead: { from: { lat: 32.35, lng: -95.3 } },
    }, { drive: 6.5 });
    expect(body).toEqual({
      origin: { city: 'Dallas', state: 'TX', lat: 32.777, lng: -96.797 }, dest: { city: 'Memphis', state: 'TN' }, carrierId: 'c1',
      pickupWindowStart: null, deliveryWindowStart: '2026-11-16T18:00', deadhead: { from: { lat: 32.35, lng: -95.3 } }, hoursLeft: { drive: 6.5 },
    });
    // Window keys left out of the input stay out (the server may fall back to the saved load).
    expect(Object.keys(planEtaBody({ origin: DAL, dest: MEM }))).toEqual(['origin', 'dest']);
  });

  it('summarizes the trip and maps verdicts to badge colors', () => {
    expect(summaryLine(RESULT)).toBe('452 mi · 6 h 50 min driving · 1 break · road route');
    expect(summaryLine({ ...RESULT, breaks: 2, resets: 2, restarts: 1, routeSource: 'estimate' })).toBe('452 mi · 6 h 50 min driving · 2 breaks · 2 10 h resets · 34 h restart · straight-line estimate');
    expect(VERDICT.on_time.color).toBe('green');
    expect(VERDICT.at_risk.color).toBe('amber');
    expect(VERDICT.late.color).toBe('red');
  });

  it('takes the load form input only with origin, destination and a delivery appointment', () => {
    const f = loadToForm({ originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', status: 'booked', carrierId: 'c1' });
    expect(formToEtaInput(f)).toBeNull();
    const withAppt = { ...f, deliveryWindowStart: '2026-11-17T08:00', pickupDate: '2026-11-16' };
    expect(formToEtaInput(withAppt, { loadId: 'l1' })).toMatchObject({
      loadId: 'l1', carrierId: 'c1', origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' },
      deliveryWindowStart: '2026-11-17T08:00', deliveryWindowEnd: null, pickupWindowStart: null, startAt: '2026-11-16T08:00', deadhead: null,
    });
    const truck = { lat: 32.35, lng: -95.3, status: 'available' };
    // No deadhead without a pickup time, for a busy truck, or once the load is under way.
    expect(formToEtaInput(withAppt, { truck }).deadhead).toBeNull();
    const timed = { ...withAppt, pickupWindowStart: '2026-11-16T09:00' };
    expect(formToEtaInput(timed, { truck })).toMatchObject({ deadhead: { from: { lat: 32.35, lng: -95.3 } }, startAt: null });
    expect(formToEtaInput(timed, { truck: { ...truck, status: 'loaded' } }).deadhead).toBeNull();
    expect(formToEtaInput({ ...timed, status: 'in_transit' }, { truck }).deadhead).toBeNull();
  });
});

describe('LegalEtaCard', () => {
  beforeEach(() => { api.post.mockReset(); });

  it('shows the verdict, drive and legal ETA in the delivery time zone and the explanation', async () => {
    api.post.mockResolvedValue(RESULT);
    wrap(<LegalEtaCard input={{ origin: DAL, dest: MEM, deliveryWindowStart: '2026-11-16T19:00:00.000Z' }} />);
    expect(await screen.findByText('At risk')).toBeInTheDocument();
    expect(screen.getByText('Nov 16, 5:50 PM EST')).toBeInTheDocument();
    expect(screen.getByText('Nov 16, 6:20 PM EST')).toBeInTheDocument();
    expect(screen.getByText(RESULT.explanation)).toBeInTheDocument();
    expect(screen.getByText('Full hours assumed')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/plan-eta', expect.objectContaining({ origin: expect.objectContaining({ city: 'Dallas' }) }), expect.anything());
  });

  it('asks for the stops while they are missing and never calls the API', () => {
    wrap(<LegalEtaCard input={{ origin: DAL, dest: null }} />);
    expect(screen.getByText('Set the pickup and delivery to check the hours of service.')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends typed hours left after a short pause, and Enter does not submit the surrounding form', async () => {
    api.post.mockResolvedValue({ ...RESULT, verdict: 'late', hours: { source: 'entered' } });
    const onSubmit = vi.fn((e) => e.preventDefault());
    wrap(<form onSubmit={onSubmit}><LegalEtaCard input={{ origin: DAL, dest: MEM }} /></form>);
    await screen.findByText('Late');
    fireEvent.click(screen.getByRole('button', { name: 'Hours left' }));
    const drive = screen.getByLabelText('Drive hours left');
    fireEvent.change(drive, { target: { value: '4' } });
    fireEvent.change(drive, { target: { value: '4:30' } });
    fireEvent.keyDown(drive, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/plan-eta', expect.objectContaining({ hoursLeft: { drive: 4.5 } }), expect.anything()));
    // Debounced: the intermediate "4" was never sent.
    expect(api.post.mock.calls.some(([, b]) => b.hoursLeft?.drive === 4)).toBe(false);
    expect(screen.getByText('Hours left as entered')).toBeInTheDocument();
    fireEvent.change(drive, { target: { value: '15' } });
    expect(screen.getByText('At most 11, 14 and 70 hours')).toBeInTheDocument();
  });

  it('shows an error without blocking anything', async () => {
    api.post.mockRejectedValue(new Error('Server busy'));
    wrap(<LegalEtaCard input={{ origin: DAL, dest: MEM }} />);
    expect(await screen.findByText('Could not check the legal ETA: Server busy')).toBeInTheDocument();
  });
});
