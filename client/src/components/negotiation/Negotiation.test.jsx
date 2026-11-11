import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: NegotiationView } = await import('./NegotiationView.jsx');
const { LoadNegotiations } = await import('./NegotiationList.jsx');
const { default: StartForm } = await import('./StartForm.jsx');

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></MemoryRouter></QueryClientProvider>);
}

const NEG = {
  id: 'n1', status: 'needs_review', mode: 'approve', canWrite: true, toEmail: 'loads@summit.test',
  lane: { originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', miles: 800 },
  offerCents: 170000, targetCents: 210000, floorCents: 180000, lastCounterCents: 210000, rounds: 1, maxRounds: 3,
  broker: { id: 'b1', companyName: 'Summit Logistics' }, carrier: { id: 'c1', companyName: 'Blue Line' },
  nextAction: { kind: 'counter', cents: 190000, subject: 'Re: Dallas to Atlanta', body: 'Hi Sam,\n\nWe can do $1,900 all in.\n\nThanks', emailId: 'e2', aiWritten: true, reason: 'Their offer is below your walk-away', createdAt: '2026-11-12T10:00:00Z' },
  history: [
    { at: '2026-11-12T09:00:00Z', from: 'dispatcher', kind: 'start', text: 'Offer $1,900, target $2,100, walk-away $1,800 (from carrier rules).' },
    { at: '2026-11-12T09:01:00Z', from: 'dispatcher', kind: 'sent', action: 'counter', cents: 210000, emailId: 'e1', subject: 'Dallas to Atlanta' },
    { at: '2026-11-12T09:30:00Z', from: 'broker', kind: 'reply', source: 'paste', text: 'Best I can do is 1700.', intent: 'counter', cents: 170000 },
  ],
};
const EMAILS = [
  { id: 'e1', subject: 'Dallas to Atlanta', body: 'Hi Sam,\n\nCan you do $2,100?', status: 'sent', aiGenerated: true },
  { id: 'e2', subject: 'Re: Dallas to Atlanta', body: 'Hi Sam,\n\nWe can do $1,900 all in.', status: 'review', aiGenerated: true },
];

describe('NegotiationView', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); });

  it('shows the limits, the thread with AI badges and the waiting counter; approve sends it', async () => {
    api.get.mockResolvedValue({ negotiation: NEG, emails: EMAILS });
    api.post.mockResolvedValue({ negotiation: { ...NEG, status: 'active', nextAction: null, rounds: 2 }, emails: EMAILS, outcome: 'sent' });
    wrap(<NegotiationView id="n1" />);
    expect(await screen.findByText('Counter at $1,900')).toBeInTheDocument();
    expect(screen.getByText('The AI never accepts a rate or books a load on its own.')).toBeInTheDocument();
    expect(screen.getByText('Best I can do is 1700.')).toBeInTheDocument();
    expect(screen.getAllByTitle('Written by AI').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('$1,800')).toBeInTheDocument(); // walk-away
    fireEvent.click(screen.getByRole('button', { name: 'Approve and send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/negotiations/n1/approve', {}));
  });

  it('keeps an edited counter inside the limits', async () => {
    api.get.mockResolvedValue({ negotiation: NEG, emails: EMAILS });
    wrap(<NegotiationView id="n1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const amount = screen.getByLabelText('Counter');
    fireEvent.change(amount, { target: { value: '2500' } });
    expect(screen.getByText('Keep it between $1,800 and $2,100, or change your limits')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send edited email' })).toBeDisabled();
    fireEvent.change(amount, { target: { value: '1950' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send edited email' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/negotiations/n1/approve', expect.objectContaining({ cents: 195000 })));
  });

  it('reads a pasted reply and offers the manual form when the AI is unavailable', async () => {
    api.get.mockResolvedValue({ negotiation: { ...NEG, nextAction: null }, emails: EMAILS });
    api.post.mockResolvedValue({ negotiation: { ...NEG, nextAction: null }, emails: EMAILS, aiError: { code: 'AI_QUOTA', message: 'AI limit reached' } });
    wrap(<NegotiationView id="n1" />);
    fireEvent.change(await screen.findByLabelText('Paste the broker’s reply'), { target: { value: 'We can do 1750' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read reply' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/negotiations/n1/reply', { text: 'We can do 1750' }));
    expect(await screen.findByLabelText('What did they say')).toBeInTheDocument();
    expect(await screen.findByText(/AI unavailable: AI limit reached/)).toBeInTheDocument();
  });

  it('accept proposals book through the accept dialog, never by themselves', async () => {
    api.get.mockResolvedValue({ negotiation: { ...NEG, nextAction: { kind: 'accept', cents: 185000, reason: 'The broker offered a rate at or above your walk-away', createdAt: 'x' } }, emails: EMAILS });
    api.post.mockResolvedValue({ negotiation: { ...NEG, status: 'agreed', agreedCents: 185000, nextAction: null, canWrite: false }, emails: EMAILS, load: { id: 'l9' } });
    wrap(<NegotiationView id="n1" />);
    expect(await screen.findByText('Accept $1,850 and book')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept & book' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept and book' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/negotiations/n1/accept-book', { cents: 185000, sendEmail: true }));
  });
});

describe('negotiation entry points', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

  it('offers "Negotiate with AI" on a planned load and shows the walk-away from carrier rules', async () => {
    api.get.mockImplementation((url) => Promise.resolve(url === '/api/negotiations' ? { items: [], total: 0 }
      : url === '/api/negotiations/defaults' ? { walkAwayCents: 180000, walkAwayBasis: 'min_rpm', rulesSet: true, targetCents: 210000, targetBasis: 'offer_plus_10', laneSampleSize: 0 }
        : {}));
    const load = { id: 'l1', status: 'planned', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 800, rateCents: 190000, carrierId: 'c1', carrier: { id: 'c1', companyName: 'Blue Line' }, broker: { id: 'b1', companyName: 'Summit', email: 'loads@summit.test' } };
    wrap(<LoadNegotiations load={load} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Negotiate with AI' }));
    expect(await screen.findByText(/From carrier rules: \$1,800/)).toBeInTheDocument();
    expect(screen.getByText(/Suggested \$2,100/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Send counters automatically within my limits' })).toBeInTheDocument();
  });

  it('hides the button once the load is booked and nothing was negotiated', async () => {
    api.get.mockResolvedValue({ items: [], total: 0 });
    const { container } = wrap(<LoadNegotiations load={{ id: 'l2', status: 'booked' }} />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('starts from a broker page with a typed lane', async () => {
    api.get.mockResolvedValue({});
    api.post.mockResolvedValue({ negotiation: { ...NEG, id: 'n7' }, emails: [] });
    const onStarted = vi.fn();
    wrap(<StartForm broker={{ id: 'b1', companyName: 'Summit', email: 'loads@summit.test' }} onStarted={onStarted} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Pickup city/), { target: { value: 'Dallas' } });
    fireEvent.change(screen.getByLabelText(/Delivery city/), { target: { value: 'Atlanta' } });
    fireEvent.change(screen.getByLabelText('Loaded miles'), { target: { value: '800' } });
    fireEvent.change(screen.getByLabelText(/Walk-away rate/), { target: { value: '1800' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft the first email' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/negotiations', expect.objectContaining({
      brokerId: 'b1', floorCents: 180000, mode: 'approve', maxRounds: 3, lane: expect.objectContaining({ originCity: 'Dallas', destCity: 'Atlanta', miles: 800 }),
    })));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('n7'));
  });
});
