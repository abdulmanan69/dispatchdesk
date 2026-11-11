import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../../components/Toast.jsx';
import { ConfirmProvider } from '../../components/Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', emailSignature: '' }, setUser: () => {}, can: () => true }) }));
const { default: EmailCenter } = await import('./EmailCenter.jsx');

const TEMPLATES = [
  { id: 't1', name: 'Check call', subject: 'Where are you', body: 'Send your location', category: 'driver', useCount: 3, lastUsedAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: new Date().toISOString() },
  { id: 't2', name: 'Intro', subject: 'Trucks available', body: 'Hello', category: 'carrier', useCount: 0, lastUsedAt: null, updatedAt: new Date().toISOString() },
];

function setup() {
  api.get.mockImplementation(async (url) => {
    if (url === '/api/email/status') return { mailboxesConnected: 1, sentToday: 0, scheduled: 0, limit: 50, planName: 'Free' };
    if (url === '/api/email/templates') return { items: TEMPLATES };
    if (url === '/api/email/merge-fields') return { fields: { company: 'Company name', first_name: 'Contact first name' }, presets: [] };
    throw new Error(`unexpected GET ${url}`);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/app/email?tab=templates']}>
            <EmailCenter />
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('EmailCenter templates tab', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); });

  it('shows categories from the shared list and real usage instead of the edit time', async () => {
    setup();
    expect(await screen.findByText('Check call')).toBeInTheDocument();
    expect(screen.getByText('Driver')).toBeInTheDocument();
    expect(screen.getByText(/^Used 3 times, last /)).toBeInTheDocument();
    expect(screen.getByText('Not used yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Template library' })).toHaveAttribute('href', '/app/templates');
  });

  it('inserts merge fields into the subject or the body, whichever was focused last, and saves the driver category', async () => {
    api.post.mockResolvedValue({ template: { id: 't3' } });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'ETA request' } });
    const subject = screen.getByLabelText(/^Subject/);
    const body = screen.getByLabelText(/^Body/);
    await screen.findByRole('button', { name: 'Insert Company name' });

    fireEvent.focus(subject);
    fireEvent.click(screen.getByRole('button', { name: 'Insert Company name' }));
    expect(subject).toHaveValue('{{company}}');
    expect(body).toHaveValue('');

    fireEvent.focus(body);
    fireEvent.click(screen.getByRole('button', { name: 'Insert Contact first name' }));
    expect(body).toHaveValue('{{first_name}}');
    expect(subject).toHaveValue('{{company}}');

    fireEvent.click(screen.getByLabelText('Category'));
    fireEvent.click(await screen.findByRole('option', { name: 'Driver' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/email/templates', {
      name: 'ETA request', subject: '{{company}}', body: '{{first_name}}', category: 'driver',
    }));
  });
});
