import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: ContactConsentCard, ConsentBadge, summaryText, usPhone } = await import('./ContactConsentCard.jsx');

const CARRIER = { id: 'c1', companyName: 'Cedar Creek Carriers', phone: '2145550188', contacts: [{ id: 'k1', name: 'Maria Lopez', isPrimary: true, phone: null }] };
const SINCE = '2026-11-02T15:00:00.000Z';
const ACTIVE = {
  id: 'cc1', carrierId: 'c1', phone: '2145550188', phoneDisplay: '(214) 555-0188', channels: ['sms', 'voice'], source: 'onboarding', grantedAt: SINCE,
  grantedByName: 'Maria Lopez', note: null, active: true, revokedAt: null, revokeReason: null,
};
const REVOKED = { ...ACTIVE, id: 'cc0', source: 'manual', note: 'Paper form', active: false, revokedAt: '2026-11-03T15:00:00.000Z', revokeReason: 'Asked to stop' };
const LIST = { items: [ACTIVE, REVOKED], summary: { status: 'consented', channels: ['sms', 'voice'], since: SINCE, phones: ['2145550188'] } };

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></QueryClientProvider>);
}

describe('ContactConsentCard', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.get.mockImplementation((url, params) => {
      if (url === '/api/contact-consents') return Promise.resolve(LIST);
      if (url === '/api/contact-consents/wording') return Promise.resolve({ text: `I agree that Park Dispatch LLC may call and text me at ${params.phone || '[phone number]'}.` });
      if (url === '/api/documents') return Promise.resolve({ items: [{ id: 'd1', originalName: 'Consent form.pdf' }] });
      return Promise.resolve({ items: [] });
    });
  });

  it('summarizes the status for the badge and the card', () => {
    expect(summaryText(LIST.summary)).toMatch(/^Consented · SMS \+ voice · since /);
    expect(summaryText({ status: 'revoked' })).toBe('Revoked');
    expect(summaryText({ status: 'none' })).toBe('Not consented');
    expect(summaryText(null)).toBe('Not consented');
    expect(usPhone('+1 (214) 555-0188')).toBe('2145550188');
    expect(usPhone('555-0188')).toBeNull();
  });

  it('shows status, history and proof links; revokes with a reason', async () => {
    api.post.mockResolvedValue({ item: { ...ACTIVE, active: false } });
    wrap(<ContactConsentCard carrier={CARRIER} canWrite />);
    expect(await screen.findByText('Consented')).toBeInTheDocument();
    expect(screen.getByText(/^SMS \+ voice · since/)).toBeInTheDocument();
    expect(screen.getByText('Asked to stop', { exact: false })).toBeInTheDocument();
    const proofs = screen.getAllByRole('link', { name: /view proof/i });
    expect(proofs.map((a) => a.getAttribute('href'))).toEqual(['/api/contact-consents/cc1/proof', '/api/contact-consents/cc0/proof']);
    // Only the active record can be revoked.
    const revokeButtons = screen.getAllByRole('button', { name: 'Revoke' });
    expect(revokeButtons).toHaveLength(1);
    fireEvent.click(revokeButtons[0]);
    fireEvent.change(await screen.findByLabelText(/reason or how they asked/i), { target: { value: 'Said stop on a call' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/contact-consents/cc1/revoke', { reason: 'Said stop on a call' }));
  });

  it('records a manual consent only with a note on how it was obtained', async () => {
    api.post.mockResolvedValue({ item: ACTIVE });
    wrap(<ContactConsentCard carrier={CARRIER} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: /record consent/i }));
    expect(await screen.findByLabelText(/phone number/i)).toHaveValue('2145550188');
    expect(screen.getByLabelText(/person who agreed/i)).toHaveValue('Maria Lopez');
    const submit = screen.getAllByRole('button', { name: /record consent/i }).at(-1);
    expect(submit).toBeDisabled();
    expect(await screen.findByText(/may call and text me at 2145550188/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Calls (voice)'));
    fireEvent.change(screen.getByLabelText(/how consent was obtained/i), { target: { value: 'Signed paper form at the yard' } });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/api/contact-consents');
    expect(body).toMatchObject({ carrierId: 'c1', phone: '2145550188', channels: ['sms'], note: 'Signed paper form at the yard', grantedByName: 'Maria Lopez', grantedAt: null, proofDocumentId: null });
  });

  it('read-only users see the history and can revoke, but not record', async () => {
    wrap(<ContactConsentCard carrier={CARRIER} canWrite={false} />);
    expect(await screen.findByText('Consented')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record consent/i })).toBeNull();
    // An opt-out must always be recordable (TCPA: revocation by any reasonable means).
    expect(screen.getAllByRole('button', { name: 'Revoke' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /view proof/i })).toHaveLength(2);
  });

  it('the header badge appears only with an active consent', async () => {
    const { unmount } = wrap(<ConsentBadge carrierId="c1" />);
    expect(await screen.findByText('Consent')).toBeInTheDocument();
    unmount();
    api.get.mockResolvedValue({ items: [REVOKED], summary: { status: 'revoked', channels: [] } });
    wrap(<ConsentBadge carrierId="c2" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/contact-consents', { carrierId: 'c2' }));
    expect(screen.queryByText('Consent')).toBeNull();
  });
});
