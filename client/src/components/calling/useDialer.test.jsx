import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../Modal.jsx', () => ({ useConfirm: () => async () => true }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

const { useDialer, openDialLink } = await import('./useDialer.js');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function startBridgeCall(result) {
  api.post.mockResolvedValueOnce({ mode: 'bridge', attempt: { id: 'a1', status: 'queued', createdAt: new Date().toISOString() } });
  await act(async () => { await result.current.dial({ carrierId: 'c1' }); });
}

describe('useDialer polling', () => {
  beforeEach(() => { vi.useFakeTimers(); api.get.mockReset(); api.post.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a reset during an in-flight poll never restarts polling or brings back the old attempt', async () => {
    const { result } = renderHook(() => useDialer());
    await startBridgeCall(result);
    const pending = deferred();
    api.get.mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(api.get).toHaveBeenCalledTimes(1);

    act(() => result.current.reset());
    await act(async () => {
      pending.resolve({ attempt: { id: 'a1', status: 'no_answer', callId: 'call-1' } });
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(result.current.attempt).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('aborts the poll request in flight when the dialer is reset', async () => {
    toast.error.mockClear();
    const { result } = renderHook(() => useDialer());
    await startBridgeCall(result);
    const pending = deferred();
    api.get.mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const { signal } = api.get.mock.calls[0][2];
    expect(signal.aborted).toBe(false);
    act(() => result.current.reset());
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.reject(new DOMException('The request was cancelled.', 'AbortError'));
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stops on a 4xx error and backs off on other errors', async () => {
    const { result } = renderHook(() => useDialer());
    await startBridgeCall(result);
    api.get.mockRejectedValueOnce(Object.assign(new Error('Server error'), { status: 502 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.get).toHaveBeenCalledTimes(1); // backing off (4 s after the first failure)
    api.get.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('keeps polling until the call is final, then stops', async () => {
    const { result } = renderHook(() => useDialer());
    await startBridgeCall(result);
    api.get
      .mockResolvedValueOnce({ attempt: { id: 'a1', status: 'ringing' } })
      .mockResolvedValueOnce({ attempt: { id: 'a1', status: 'completed', durationSec: 42 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(result.current.attempt.status).toBe('ringing');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.attempt).toMatchObject({ status: 'completed', durationSec: 42 });
    expect(result.current.isFinal).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('unmounting during a poll stops it', async () => {
    const { result, unmount } = renderHook(() => useDialer());
    await startBridgeCall(result);
    const pending = deferred();
    api.get.mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    unmount();
    await act(async () => {
      pending.resolve({ attempt: { id: 'a1', status: 'ringing' } });
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe('link providers', () => {
  afterEach(() => { vi.restoreAllMocks(); toast.info.mockReset(); });

  it('opens the provider tab without giving it a handle on this page', () => {
    const tab = { opener: 'app' };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    expect(openDialLink('https://voice.google.com/u/0/calls?a=nc,%2B12145550100')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://voice.google.com/u/0/calls?a=nc,%2B12145550100', '_blank');
    expect(tab.opener).toBeNull();
  });

  it('offers an Open call action when the browser blocks the tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    api.post.mockResolvedValueOnce({ mode: 'link', url: 'https://voice.google.com/u/0/calls?a=nc,%2B12145550100', attempt: { id: 'a9' } });
    const { result } = renderHook(() => useDialer());
    await act(async () => { await result.current.dial({ carrierId: 'c1' }); });
    expect(toast.info).toHaveBeenCalledTimes(1);
    const [message, opts] = toast.info.mock.calls[0];
    expect(message).toMatch(/blocked the call tab/);
    open.mockReturnValue({ opener: 'app' });
    opts.action.onClick();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
