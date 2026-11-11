import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { ImapSettingsModal, imapSummary } = await import('./ImapSettings.jsx');

const SMTP = {
  id: 'a1', provider: 'gmail_smtp', fromEmail: 'me@gmail.test', imapSupported: true, imapNote: null, imapEnabled: false,
  imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, imapCheckedAt: null, imapError: null,
};

function setup(account, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ImapSettingsModal account={account} onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

describe('ImapSettingsModal', () => {
  beforeEach(() => { api.post.mockReset(); api.patch.mockReset(); });

  it('tests the connection and turns detection on with the preset server', async () => {
    api.post.mockResolvedValue({ ok: true, message: 'Signed in to imap.gmail.com:993. The inbox has 12 messages.' });
    api.patch.mockResolvedValue({ account: { ...SMTP, imapEnabled: true } });
    const { onClose } = setup(SMTP);
    expect(screen.getByLabelText(/IMAP server/i)).toHaveValue('imap.gmail.com');
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
    expect(await screen.findByText(/The inbox has 12 messages/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/email/accounts/a1/imap/test', { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true });
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/email/accounts/a1', { imapEnabled: true, imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('explains why sign-in mailboxes cannot use reply detection', () => {
    setup({ ...SMTP, provider: 'gmail', imapSupported: false, imapNote: 'Google sign-in connections can only send mail.' });
    expect(screen.getByText(/can only send mail/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('does not claim detection works before the first inbox check', () => {
    setup({ ...SMTP, imapEnabled: true, imapCheckedAt: null });
    expect(screen.getByText('Waiting for the first check')).toBeInTheDocument();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
  });

  it('summarizes the state for the mailbox card', () => {
    expect(imapSummary({ ...SMTP })).toMatch(/off/);
    expect(imapSummary({ ...SMTP, imapEnabled: true, imapError: 'Sign-in failed' })).toMatch(/attention/);
    expect(imapSummary({ ...SMTP, imapSupported: false })).toMatch(/app-password/);
  });
});
