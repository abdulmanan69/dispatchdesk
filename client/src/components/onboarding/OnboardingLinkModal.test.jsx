import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';
import { insertAt } from './onboardingLinks.js';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: OnboardingLinkModal } = await import('./OnboardingLinkModal.jsx');
const { default: OnboardingPanel, linkSummary } = await import('./OnboardingPanel.jsx');

const TEMPLATE = {
  title: 'Dispatch service agreement',
  body: 'This agreement between {{dispatcher_company}} and {{carrier_company}} sets a fee of {{fee_percent}}% of gross line haul.',
  defaultBody: 'This agreement between {{dispatcher_company}} and {{carrier_company}} sets a fee of {{fee_percent}}% of gross line haul.',
  isDefault: true,
  fields: [{ key: 'carrier_company', label: 'Carrier company name' }, { key: 'fee_percent', label: 'Dispatch fee %' }],
  docs: [],
  days: { default: 14, max: 30 },
};
const CARRIER = { id: 'c1', companyName: 'Cedar Creek Carriers', email: 'owner@cedar.test' };

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></QueryClientProvider>);
}

describe('OnboardingLinkModal', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.get.mockImplementation((url) => Promise.resolve(url.endsWith('/template') ? TEMPLATE : { items: [] }));
  });

  it('shows the legal note, edits the agreement and creates the link', async () => {
    api.post.mockResolvedValue({
      link: 'https://app.test/onboard/tok', onboardingLink: { id: 'l1', expiresAt: new Date().toISOString() },
      message: { text: 'Please sign here: https://app.test/onboard/tok', subject: 'Dispatch agreement', sms: 'sms:?&body=x', toEmail: 'owner@cedar.test' }, email: null,
    });
    wrap(<OnboardingLinkModal open onClose={() => {}} carrier={CARRIER} feePercent={6} />);
    expect(await screen.findByText('This is a template, not legal advice. Have your own agreement reviewed by an attorney.')).toBeInTheDocument();
    expect(screen.getByLabelText(/dispatch fee/i)).toHaveValue(6);
    fireEvent.click(screen.getByLabelText('Voided check'));
    fireEvent.click(screen.getByLabelText('W-9'));
    fireEvent.click(screen.getByRole('button', { name: '{{carrier_company}}' }));
    expect(screen.getByLabelText('Agreement').value).toContain('{{carrier_company}}');
    // No mailbox: emailing is off and explained.
    expect(screen.getByLabelText(/email it from my mailbox/i)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/api/onboarding-links');
    expect(body).toMatchObject({ carrierId: 'c1', feePercent: 6, requestedDocs: ['coi', 'mc_authority', 'voided_check'], days: 14, sendEmail: false, toEmail: null });
    expect(await screen.findByText('https://app.test/onboard/tok')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /text message/i })).toHaveAttribute('href', 'sms:?&body=x');
  });
});

describe('OnboardingPanel', () => {
  it('lists links with status, record link and turn off', async () => {
    const now = new Date().toISOString();
    api.get.mockResolvedValue({
      items: [
        { id: 's1', status: 'signed', agreementTitle: 'Dispatch service agreement', signerName: 'Maria Lopez', signedAt: now, feePercent: 7, requestedDocs: ['w9', 'coi'], uploadedDocs: ['w9'], expiresAt: now },
        { id: 'p1', status: 'viewed', agreementTitle: 'Dispatch service agreement', viewedAt: now, feePercent: 7, requestedDocs: [], uploadedDocs: [], expiresAt: now },
      ],
    });
    api.post.mockResolvedValue({ item: { id: 'p1', status: 'revoked' } });
    wrap(<OnboardingPanel carrier={CARRIER} showCreate={false} />);
    expect(await screen.findByText('Signed')).toBeInTheDocument();
    expect(screen.getByText('Opened')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view record/i })).toHaveAttribute('href', '/api/onboarding-links/s1/record');
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));
    await screen.findByText(/will no longer be able to open or sign it/);
    const buttons = screen.getAllByRole('button', { name: 'Turn off' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/onboarding-links/p1/revoke'));
  });

  it('summarizes documents and fee', () => {
    expect(linkSummary({ status: 'pending', viewedAt: null, expiresAt: new Date().toISOString(), feePercent: 8, requestedDocs: ['w9', 'coi'], uploadedDocs: ['coi'] }))
      .toMatch(/Not opened yet .* fee 8% · documents 1 of 2$/);
  });

  it('inserts merge fields at the cursor', () => {
    expect(insertAt('Hello world', '{{x}}', 6)).toEqual({ value: 'Hello {{x}}world', cursor: 11 });
    expect(insertAt('abc', '!', undefined)).toEqual({ value: 'abc!', cursor: 4 });
  });
});
