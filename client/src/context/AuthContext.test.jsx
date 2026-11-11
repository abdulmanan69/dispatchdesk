import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthContext.jsx';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const USER = { id: 'u1', name: 'Dana Dispatch', theme: 'light', permissions: [] };

function Probe() {
  const { user, loading, connection, retryNow } = useAuth();
  return (
    <div>
      <p data-testid="state">{loading ? 'loading' : user ? `user:${user.name}` : 'signed-out'}</p>
      <p data-testid="connection">{connection ? connection.message : 'ok'}</p>
      <button type="button" onClick={retryNow}>retry</button>
    </div>
  );
}

function renderAuth() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('AuthProvider', () => {
  it('keeps the session while the server is unreachable or busy, then recovers', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Bad gateway' }, 502))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429))
      .mockResolvedValueOnce(json({ user: USER }));
    vi.stubGlobal('fetch', fetch);
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent("Can't reach DispatchDesk."));
    expect(screen.getByTestId('state')).toHaveTextContent('loading'); // not sent to the login page
    fireEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent(/too many requests/i));
    expect(screen.getByTestId('state')).toHaveTextContent('loading');
    fireEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:Dana Dispatch'));
    expect(screen.getByTestId('connection')).toHaveTextContent('ok');
  });

  it('treats a network failure as temporary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json({ user: null })));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('connection')).not.toHaveTextContent('ok'));
    expect(screen.getByTestId('state')).toHaveTextContent('loading');
    fireEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
  });

  it('signs out only on 401 or an explicit signed-out answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: 'Authentication required' }, 401)));
    const { unmount } = renderAuth();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
    unmount();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ user: null })));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('signed-out'));
  });

  it('signs out when another tab signs out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ user: USER })));
    renderAuth();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:Dana Dispatch'));
    const otherTab = new BroadcastChannel('dd-tabs');
    await act(async () => {
      otherTab.postMessage({ type: 'logout' });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId('state')).toHaveTextContent('signed-out');
    otherTab.close();
  });
});
