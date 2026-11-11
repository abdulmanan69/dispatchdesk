import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u-gs' } }) }));
const get = vi.fn();
const post = vi.fn(async () => ({}));
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: (...a) => post(...a) } }));

const { default: GettingStarted } = await import('./GettingStarted.jsx');

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><GettingStarted /></MemoryRouter></QueryClientProvider>);
}
const urls = () => get.mock.calls.map((c) => c[0]);

beforeEach(() => {
  get.mockReset();
  post.mockClear();
  localStorage.clear();
});

describe('GettingStarted', () => {
  it('puts the sequence step before generating leads', async () => {
    get.mockImplementation(async (url) => (url === '/api/tours' ? { state: { welcome: { done: true } } } : { steps: { calling: true, mailbox: false } }));
    renderIt();
    await waitFor(() => expect(screen.getByText('Getting started')).toBeInTheDocument());
    // One status request covers every step.
    expect(urls().sort()).toEqual(['/api/onboarding/status', '/api/tours']);
    expect(get.mock.calls.find((c) => c[0] === '/api/onboarding/status')[1]).toEqual({ steps: 'calling,mailbox,sequence,leads,dialer,extension,fleet' });
    expect(screen.getByText('1 of 7 done')).toBeInTheDocument();
    const titles = screen.getAllByRole('listitem').map((li) => li.textContent);
    const seq = titles.findIndex((t) => t.includes('Create a sequence'));
    const leads = titles.findIndex((t) => t.includes('Generate your first leads'));
    expect(seq).toBeGreaterThanOrEqual(0);
    expect(seq).toBeLessThan(leads);
  });

  it('sends no requests once the checklist is hidden', async () => {
    get.mockImplementation(async (url) => (url === '/api/tours' ? { state: { 'getting-started': { done: true } } } : { items: [] }));
    const { container } = renderIt();
    await waitFor(() => expect(urls()).toContain('/api/tours'));
    await new Promise((r) => setTimeout(r, 30));
    expect(urls()).toEqual(['/api/tours']);
    expect(container).toBeEmptyDOMElement();
  });

  it('never refetches steps that are already done, and records completion', async () => {
    localStorage.setItem('dd:getting-started:u-gs', JSON.stringify({ calling: true, mailbox: true, sequence: true, leads: true, dialer: true, extension: true }));
    get.mockImplementation(async (url) => {
      if (url === '/api/tours') return { state: {} };
      if (url === '/api/onboarding/status') return { steps: { fleet: true } };
      throw new Error(`unexpected ${url}`);
    });
    renderIt();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/tours/getting-started', { status: 'done' }));
    expect(urls().sort()).toEqual(['/api/onboarding/status', '/api/tours']);
    // Only the step that is not cached as done is asked for.
    expect(get.mock.calls.find((c) => c[0] === '/api/onboarding/status')[1]).toEqual({ steps: 'fleet' });
  });
});
