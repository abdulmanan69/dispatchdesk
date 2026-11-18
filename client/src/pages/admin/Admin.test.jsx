import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const auth = vi.hoisted(() => ({ perms: null }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ can: (p) => !auth.perms || auth.perms.includes(p), user: { id: 'u1' } }) }));
const settings = [
  { key: 'billing.provider', group: 'billing', type: 'string', secret: false, value: 'manual', isSet: true, source: 'database' },
  { key: 'manual.bank', group: 'billing', type: 'string', secret: false, value: 'IBAN: PK00TEST', isSet: true, source: 'database' },
  { key: 'paddle.environment', group: 'billing', type: 'string', secret: false, value: 'live', isSet: true, source: 'database' },
  { key: 'paddle.apiKey', group: 'billing', type: 'string', secret: true, value: '', isSet: true, preview: 'pdl_…abcd', source: 'database' },
];
vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn(async (url) => {
      if (url === '/api/admin/attention') return { paymentsToCheck: 3, openReports: 0, setupTodo: 0, failedJobs: 1 };
      if (url === '/api/admin/settings') return { settings, webhookUrl: 'https://x.test/api/billing/webhook', oauth: {}, appUrl: 'https://x.test' };
      return { items: [], total: 0, page: 1, pages: 1 };
    }),
    post: vi.fn(), put: vi.fn(),
  },
}));
vi.mock('../../lib/hooks.js', async (orig) => ({ ...(await orig()), useApiMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const { default: Admin } = await import('./Admin.jsx');
const { searchAdmin, visibleMenu } = await import('../../components/admin/adminPages.js');

const renderAt = (url) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><Admin /></MemoryRouter>
  </QueryClientProvider>,
);

describe('admin search', () => {
  const all = visibleMenu(() => true);
  it('finds pages by purpose and settings by name', () => {
    expect(searchAdmin(all, 'backup')[0]).toMatchObject({ kind: 'page', label: 'Jobs & backups' });
    expect(searchAdmin(all, 'coupon')[0]).toMatchObject({ kind: 'page', label: 'Codes & discounts' });
    expect(searchAdmin(all, 'iban')[0]).toMatchObject({ kind: 'setting', settingKey: 'manual.bank', sub: 'Payment settings → Manual payment details' });
    expect(searchAdmin(all, 'trial days')[0]).toMatchObject({ kind: 'setting', settingKey: 'app.trialDays' });
    expect(searchAdmin(all, 'zzqx')).toEqual([]);
  });
  it('only offers what the role may open', () => {
    const billingOnly = visibleMenu((p) => ['admin.access', 'admin.billing'].includes(p));
    expect(billingOnly.map((g) => g.group)).toEqual(['Home', 'Billing']);
    expect(searchAdmin(billingOnly, 'iban')).toEqual([]);
  });
});

describe('Admin page', () => {
  it('shows the menu in groups with counts and opens a setting from the search', async () => {
    renderAt('/app/admin?tab=audit');
    expect(await screen.findByRole('heading', { name: 'Audit log', level: 2 })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    for (const g of ['Home', 'People', 'Billing', 'Settings', 'System']) expect(within(nav).getByText(g)).toBeInTheDocument();
    expect(await within(nav).findByLabelText('3 need attention')).toBeInTheDocument();
    expect(within(nav).getByLabelText('1 need attention')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Find a page or setting' }), { target: { value: 'iban' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Bank wire details/ }));
    expect(await screen.findByRole('heading', { name: 'Payment settings', level: 2 })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Bank wire details/)).toHaveValue('IBAN: PK00TEST');
    // The provider in use is open; the others fold away until opened.
    expect(screen.getByText('In use')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Paddle API key/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Paddle/ }));
    expect(screen.getByLabelText(/Paddle API key/)).toBeInTheDocument();
  });

  it('shows the save bar only after a change', async () => {
    renderAt('/app/admin?tab=settings&section=billing');
    const bank = await screen.findByLabelText(/Bank wire details/);
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.change(bank, { target: { value: 'IBAN: PK00CHANGED' } });
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 unsaved change');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(bank).toHaveValue('IBAN: PK00TEST');
  });
});
