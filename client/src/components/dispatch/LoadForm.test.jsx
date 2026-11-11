import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(async () => ({ items: [] })), post: vi.fn(), patch: vi.fn(), upload: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', timezone: 'America/Chicago' } }) }));
const { default: LoadFormModal } = await import('./LoadForm.jsx');

const LOAD = {
  id: 'l1', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', rateCents: 200000, loadedMiles: 800,
  status: 'booked', referenceNumber: 'R-1', fit: { warnings: [] },
};

describe('LoadFormModal', () => {
  it('keeps unsaved edits when the open load is refetched, and starts from the saved load when reopened', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (load, open = true) => (
      <QueryClientProvider client={qc}><ToastProvider><ConfirmProvider>
        <LoadFormModal open={open} load={load} onClose={() => {}} />
      </ConfirmProvider></ToastProvider></QueryClientProvider>
    );
    const { rerender } = render(wrap(LOAD));
    const ref = await screen.findByLabelText('Reference #');
    expect(ref).toHaveValue('R-1');
    fireEvent.change(ref, { target: { value: 'R-2 typed' } });

    // The parent refetched the same load (e.g. after acknowledging warnings): a new object, same id.
    rerender(wrap({ ...LOAD, fit: { warnings: [], acknowledgedAt: '2026-11-10T00:00:00Z' } }));
    expect(screen.getByLabelText('Reference #')).toHaveValue('R-2 typed');

    rerender(wrap(LOAD, false));
    rerender(wrap(LOAD));
    expect(await screen.findByLabelText('Reference #')).toHaveValue('R-1');
  });
});
