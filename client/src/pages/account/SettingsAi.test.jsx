import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const data = vi.hoisted(() => ({
  settings: {
    platform: { available: true, provider: 'openai', model: 'gpt-4o-mini' },
    mine: { provider: 'anthropic', baseUrl: null, model: null, keyHint: 'AbCd', active: true },
    usage: { thisMonth: 4, limit: 30, byokThisMonth: 12 },
  },
  mutations: [],
}));

vi.mock('../../lib/api.js', () => ({
  api: { get: vi.fn(async (url) => (url === '/api/ai-settings' ? data.settings : {})), put: vi.fn(), post: vi.fn(), del: vi.fn() },
}));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Dee', timezone: 'America/Chicago' }, setUser: vi.fn() }) }));
vi.mock('../../lib/hooks.js', () => ({
  useApiMutation: (fn) => { const m = { mutate: vi.fn((v) => fn(v)), isPending: false }; data.mutations.push(m); return m; },
  errorToast: vi.fn(),
}));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../../components/Modal.jsx', () => ({ Modal: ({ children }) => children, useConfirm: () => vi.fn(async () => false) }));
vi.mock('../../components/settings/SecurityPanel.jsx', () => ({ default: () => null }));
vi.mock('../../components/calling/CallingSettings.jsx', () => ({ default: () => null }));

const { api } = await import('../../lib/api.js');
const { default: Settings } = await import('./Settings.jsx');

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/app/settings?tab=ai']}><Settings /></MemoryRouter></QueryClientProvider>);
}

describe('Settings → AI', () => {
  it('shows the saved key by its last 4 characters, the usage line and the billing note', async () => {
    renderTab();
    const key = await screen.findByLabelText('API key');
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', 'Saved ending in AbCd');
    expect(screen.getByText(/billed by your provider and don't count against your plan/)).toBeInTheDocument();
    expect(screen.getByText(/DispatchDesk AI this month: 4 of 30 calls on your plan\. Your own key this month: 12 calls\./)).toBeInTheDocument();
    expect(screen.getByText('Using your own key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('fills the base URL from a preset and saves the form', async () => {
    renderTab();
    fireEvent.click(await screen.findByLabelText('Provider'));
    fireEvent.click(screen.getByRole('option', { name: 'Groq' }));
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.groq.com/openai/v1');
    expect(screen.getByLabelText('Model')).toHaveValue('llama-3.3-70b-versatile');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'gsk_live_key_123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.put).toHaveBeenCalledWith('/api/ai-settings', { provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_live_key_123' });
  });
});
