import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: TemplatePicker } = await import('./TemplatePicker.jsx');

const TEXTS = [
  { id: 't1', name: 'Check call', category: 'driver', body: 'Hi {{first_name}}, where are you?', useCount: 3 },
  { id: 't2', name: 'Load offer', category: 'carrier', body: 'Load {{pickup_city}} to {{delivery_city}}', useCount: 9 },
  { id: 't3', name: 'ETA request', category: 'driver', body: 'What is your ETA?', useCount: 0 },
];

function setup(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPick = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <TemplatePicker channel="sms" carrierId="car1" loadId="load1" extra={{ track_link: 'https://x.test/t/1' }} onPick={onPick} {...props} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onPick };
}

describe('TemplatePicker', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

  it('lists templates grouped by category, filters by search, and returns the rendered text on pick', async () => {
    api.get.mockResolvedValue({ items: TEXTS });
    api.post.mockResolvedValue({ body: 'Hi Marcus, where are you?', unresolved: [], unknown: [], fallbacks: [] });
    const { onPick } = setup();
    fireEvent.click(screen.getByRole('button', { name: /templates/i }));
    expect(await screen.findByText('Check call')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/templates/text');
    // Category headers, most used first inside a group.
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toMatch(/Load offer/);
    expect(options[1]).toMatch(/Check call/);

    fireEvent.change(screen.getByLabelText(/search text templates/i), { target: { value: 'eta' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/search text templates/i), { target: { value: '' } });

    fireEvent.click(screen.getByText('Check call'));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/api/templates/render', expect.objectContaining({
      channel: 'sms', templateId: 't1', carrierId: 'car1', loadId: 'load1', extra: { track_link: 'https://x.test/t/1' }, use: true,
    }));
    expect(onPick.mock.calls[0][0]).toMatchObject({ body: 'Hi Marcus, where are you?', template: { id: 't1' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('supports the keyboard and closes on Escape', async () => {
    api.get.mockResolvedValue({ items: TEXTS });
    api.post.mockResolvedValue({ body: 'Load Dallas, TX to Atlanta, GA', unresolved: [] });
    const { onPick } = setup();
    fireEvent.click(screen.getByRole('button', { name: /templates/i }));
    const search = await screen.findByLabelText(/search text templates/i);
    await screen.findByText('Load offer');
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1].templateId).toBe('t2');

    fireEvent.click(screen.getByRole('button', { name: /templates/i }));
    const again = await screen.findByLabelText(/search text templates/i);
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers the starter pack when there are no templates', async () => {
    api.get.mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: TEXTS });
    api.post.mockResolvedValue({ created: 15 });
    setup();
    fireEvent.click(screen.getByRole('button', { name: /templates/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add starter templates/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/templates/starter', { channel: 'sms' }));
    expect(await screen.findByText('Check call')).toBeInTheDocument();
  });

  it('uses the email template list for the email channel', async () => {
    api.get.mockResolvedValue({ items: [{ id: 'e1', name: 'Intro', category: 'carrier', subject: 'Dispatch for {{company}}', body: 'Hi', useCount: 0 }] });
    setup({ channel: 'email' });
    fireEvent.click(screen.getByRole('button', { name: /templates/i }));
    expect(await screen.findByText('Dispatch for {{company}}')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/email/templates');
  });
});
