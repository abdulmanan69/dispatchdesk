import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
const { default: TextLogModal } = await import('./TextLogModal.jsx');

function renderIt(carrier) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><TextLogModal carrier={carrier} onClose={() => {}} initialBody="Hi there" /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(async (url) => {
    if (url === '/api/telephony/settings') return { settings: { provider: 'tel' } };
    if (url === '/api/carriers/c1') return { carrier: { id: 'c1', doNotCall: true } };
    throw new Error(`unexpected ${url}`);
  });
});

describe('TextLogModal', () => {
  it('looks up do-not-call when the list did not include it, and blocks opening the messaging app', async () => {
    renderIt({ id: 'c1', companyName: 'Red River', phone: '3185550100' }); // follow-up rows carry no doNotCall
    expect(await screen.findByText(/Do-not-call is on for this carrier/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/carriers/c1');
    expect(screen.getByRole('button', { name: /open messaging app and log/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /log only/i })).toBeDisabled();
  });

  it('does not look the carrier up when the flag is known', async () => {
    renderIt({ id: 'c1', companyName: 'Red River', phone: '3185550100', doNotCall: false });
    expect(await screen.findByRole('button', { name: /open messaging app and log/i })).toBeEnabled();
    expect(api.get).not.toHaveBeenCalledWith('/api/carriers/c1');
  });
});
