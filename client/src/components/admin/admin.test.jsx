import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const data = vi.hoisted(() => ({
  setup: {
    progress: { done: 0, total: 1 },
    appUrl: 'https://dispatch.example.test',
    items: [{
      key: 'platform_email', title: 'Platform email (verification, password reset, invites)', status: 'partial', required: true,
      summary: 'Sending as no-reply@example.test through smtp.example.test.', steps: [], values: [], links: [], testService: 'smtp', settingsGroup: 'email',
      mail: { limit: 300, reserve: 90, otherLimit: 210, day: '2026-11-10', sent: 4, other: 1, refused: 2, failed: 1, lastError: 'Greeting never received', lastErrorAt: '2026-11-10T15:00:00.000Z' },
    }],
  },
  settings: {
    appUrl: 'https://dispatch.example.test',
    webhookUrl: 'https://dispatch.example.test/api/billing/webhook',
    oauth: {},
    settings: [
      { key: 'smtp.host', group: 'email', type: 'string', secret: false, value: 'smtp.example.test', isSet: true, source: 'database' },
      { key: 'smtp.dailyLimit', group: 'email', type: 'string', secret: false, value: '300', isSet: true, source: 'environment' },
      { key: 'search.provider', group: 'ai', type: 'string', secret: false, value: '', isSet: false, source: 'unset' },
    ],
  },
}));

vi.mock('../../lib/api.js', () => ({
  api: { get: vi.fn(async (url) => (url === '/api/admin/setup' ? data.setup : url === '/api/admin/settings' ? data.settings : { items: [] })), post: vi.fn(), put: vi.fn() },
}));
vi.mock('../../lib/hooks.js', () => ({ useApiMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../Modal.jsx', () => ({ Modal: ({ children }) => children, useConfirm: () => vi.fn(async () => false) }));
vi.mock('./OAuthSetupGuide.jsx', () => ({ default: () => null }));

const { default: AdminSetup } = await import('./Setup.jsx');
const { default: SystemSettings } = await import('./SystemSettings.jsx');

function renderWithQuery(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('Admin setup: platform email', () => {
  it("shows today's platform mail use, budget refusals, failures and the last error", async () => {
    renderWithQuery(<AdminSetup onTab={() => {}} />);
    expect(await screen.findByText('Sent today')).toBeInTheDocument();
    expect(screen.getByText('4 of 300')).toBeInTheDocument();
    expect(screen.getByText('Kept for sign-in and reset').nextSibling).toHaveTextContent('90');
    expect(screen.getByText('Digests and notices').nextSibling).toHaveTextContent('1 of 210');
    expect(screen.getByText('Held back by the budget').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Failed').nextSibling).toHaveTextContent('1');
    expect(screen.getByText(/Last error .*Greeting never received/)).toBeInTheDocument();
  });
});

describe('System settings', () => {
  it('labels each field and offers the platform mail budget as a whole number', async () => {
    renderWithQuery(<SystemSettings />);
    const limit = await screen.findByLabelText(/Platform emails per day/);
    expect(limit).toHaveAttribute('type', 'number');
    expect(limit).toHaveAttribute('min', '1');
    expect(limit).toHaveValue(300);
    expect(screen.getByText(/kept for verification and password reset mail/)).toBeInTheDocument();
    expect(screen.getByLabelText(/SMTP host/)).toHaveValue('smtp.example.test');
  });
});
