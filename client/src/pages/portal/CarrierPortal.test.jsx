import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../components/Logo.jsx', () => ({ Logo: () => null }));

const { default: CarrierPortal } = await import('./CarrierPortal.jsx');

function renderAt(path) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/portal/:token" element={<CarrierPortal />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('CarrierPortal', () => {
  it('encodes the link token and never sends the session cookie', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'This link is not valid.' }) }));
    vi.stubGlobal('fetch', fetchMock);
    // React Router decodes %2F, so a crafted link would otherwise point the page at /api/carriers.
    renderAt('/portal/..%2F..%2Fcarriers');
    expect(await screen.findByText('This link is not available')).toBeTruthy();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/public/portal/..%2F..%2Fcarriers');
    expect(opts).toMatchObject({ credentials: 'omit' });
  });
});
