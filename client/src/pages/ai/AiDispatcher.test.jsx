import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describeAiError, aiSourceLabel, AI_OFF } from './aiErrors.js';

const data = vi.hoisted(() => ({ status: null }));

vi.mock('../../lib/api.js', () => ({
  api: { get: vi.fn(async (url) => (url === '/api/ai/status' ? data.status : { items: [] })), post: vi.fn(), del: vi.fn() },
}));
vi.mock('../../lib/hooks.js', () => ({ useApiMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../../components/Modal.jsx', () => ({ useConfirm: () => vi.fn(async () => false) }));

// jsdom has no scrolling; the chat scrolls to its last message.
Element.prototype.scrollIntoView = vi.fn();

const { default: AiDispatcher } = await import('./AiDispatcher.jsx');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AiDispatcher /></MemoryRouter></QueryClientProvider>);
}

const base = { webSearch: false, knowledge: { own: 0, global: 0 }, suggestions: [] };

describe('AI page header and states', () => {
  it('shows platform usage against the plan', async () => {
    data.status = { ...base, configured: true, source: 'platform', provider: 'openai', model: 'gpt-4o-mini', usage: { used: 3, limit: 30 } };
    renderPage();
    expect(await screen.findByText('Using DispatchDesk AI · 3 of 30 this month')).toBeInTheDocument();
  });

  it('shows when the user\'s own key is used', async () => {
    data.status = { ...base, configured: true, source: 'byok', provider: 'anthropic', model: 'claude-opus-5-5', usage: null };
    renderPage();
    expect(await screen.findByText('Using your own key')).toHaveAttribute('title', 'Model claude-opus-5-5');
  });

  it('explains how to turn AI on when it is off', async () => {
    data.status = { ...base, configured: false, source: null, usage: null, message: 'AI not configured' };
    renderPage();
    expect(await screen.findByText(/AI is off: ask your admin or add your own key in Settings → AI\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add your own key/ })).toHaveAttribute('href', '/app/settings?tab=ai');
  });
});

describe('AI error wording', () => {
  it('maps server codes to plain messages with next steps', () => {
    expect(describeAiError({ status: 503, message: 'x', details: { code: 'AI_NOT_CONFIGURED' } })).toEqual({ message: AI_OFF, links: [{ label: 'Add your own key', to: '/app/settings?tab=ai' }] });
    const quota = describeAiError({ status: 429, message: 'Monthly AI limit reached for your plan. Upgrade or add your own key in Settings → AI.', details: { code: 'AI_QUOTA' } });
    expect(quota.message).toMatch(/Monthly AI limit reached/);
    expect(quota.links.map((l) => l.to)).toEqual(['/app/billing', '/app/settings?tab=ai']);
    expect(describeAiError({ message: 'The AI provider rejected the API key', details: { code: 'AI_KEY_REJECTED' } }).message).toBe('The AI provider rejected the API key. Check your key and model in Settings → AI.');
    expect(describeAiError({ message: 'Network error' })).toEqual({ message: 'Network error', links: [] });
  });

  it('labels the AI source', () => {
    expect(aiSourceLabel({ configured: false })).toBeNull();
    expect(aiSourceLabel({ configured: true, source: 'platform', usage: { used: 5, limit: -1 } })).toBe('Using DispatchDesk AI · 5 this month');
  });
});
