import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../components/Logo.jsx', () => ({ Logo: () => null }));
const { default: CarrierAccount } = await import('./CarrierAccount.jsx');

const ME = {
  account: { dotNumber: '3636864', legalName: "DEAN'S LOGISTICS LLC", email: 'de***@gmail.com', verifiedAt: '2026-11-13T10:00:00Z' },
  documents: [{ id: 'v1', type: 'coi', label: 'Certificate of insurance', originalName: 'coi.pdf', sizeBytes: 100, expiresAt: '2027-06-30T23:59:59Z', createdAt: '2026-11-13T10:00:00Z' }],
  connections: [{ id: 'c1', dispatcher: { name: 'Tina', company: 'Blue Line Dispatch', phone: '2145550188', email: 't@x.com' }, relationship: 'invited', agreement: { status: 'pending' }, statements: false, share: null }],
  types: [{ value: 'w9', label: 'W-9' }, { value: 'coi', label: 'Certificate of insurance' }],
  defaultShare: ['w9', 'coi'],
};

let routes;
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  document.cookie = 'dd_csrf=tok123';
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) return json(404, { error: `no route ${key}` });
    return handler(opts);
  }));
});
afterEach(() => vi.unstubAllGlobals());

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><CarrierAccount /></MemoryRouter></QueryClientProvider>);
}

describe('CarrierAccount', () => {
  it('signs in with the USDOT number and the code sent to the FMCSA email', async () => {
    let signedIn = false;
    routes['GET /api/public/carrier/me'] = () => (signedIn ? json(200, ME) : json(401, { error: 'Sign in' }));
    routes['POST /api/public/carrier/login/start'] = (opts) => {
      expect(JSON.parse(opts.body)).toEqual({ number: 'MC 1248213' });
      expect(opts.headers['X-CSRF-Token']).toBe('tok123');
      return json(200, { dot: '3636864', maskedEmail: 'de***@gmail.com', expiresInMinutes: 10 });
    };
    routes['POST /api/public/carrier/login/verify'] = (opts) => {
      expect(JSON.parse(opts.body)).toEqual({ number: '3636864', code: '123456' });
      signedIn = true;
      return json(200, { ok: true });
    };
    renderIt();
    fireEvent.change(await screen.findByLabelText('USDOT number (or MC number)'), { target: { value: 'MC 1248213' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send my code' }));
    expect(await screen.findByText('de***@gmail.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '12a3456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: "DEAN'S LOGISTICS LLC" })).toBeInTheDocument();
    expect(screen.getByText('Blue Line Dispatch')).toBeInTheDocument();
  });

  it('shares documents with one dispatcher', async () => {
    routes['GET /api/public/carrier/me'] = () => json(200, ME);
    routes['PUT /api/public/carrier/connections/c1/share'] = (opts) => {
      expect(JSON.parse(opts.body)).toEqual({ docTypes: ['coi'], autoUpdate: true });
      return json(200, { ok: true, copied: 1, connections: [{ ...ME.connections[0], share: { docTypes: ['coi'], autoUpdate: true, hidden: false, active: true, filesShared: 1 } }] });
    };
    renderIt();
    fireEvent.click(await screen.findByRole('button', { name: 'Share documents' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share with Blue Line Dispatch' });
    // Only documents the carrier has are offered; the COI is ticked by default.
    expect(within(dialog).queryByLabelText('W-9')).toBeNull();
    expect(within(dialog).getByLabelText('Certificate of insurance')).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Share/ }));
    expect(await screen.findByText(/Sharing Certificate of insurance/)).toBeInTheDocument();
  });
});
