import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sharedQueryFn, setSharedSink, clearShared, onTabMessage, postTabMessage } from './tabSync.js';

const ctx = (over = {}) => ({ queryKey: ['notifications', 'unread', 'u1'], client: { getQueryState: () => ({ isInvalidated: false }) }, signal: new AbortController().signal, ...over });
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => { clearShared(); setSharedSink(null); });

describe('tab sync', () => {
  it('shares one poll result between tabs', async () => {
    const other = new BroadcastChannel('dd-tabs'); // stands in for another tab
    const seen = [];
    other.onmessage = (e) => seen.push(e.data);
    const fetcher = vi.fn(async () => ({ unread: 3 }));
    const fn = sharedQueryFn('unread:u1', fetcher, 50_000);
    expect(await fn(ctx())).toEqual({ unread: 3 });
    await flush();
    expect(seen.at(-1)).toMatchObject({ type: 'poll', key: 'unread:u1', data: { unread: 3 }, queryKey: ['notifications', 'unread', 'u1'] });
    // A fresh result from this tab is reused by the next poll.
    expect(await fn(ctx())).toEqual({ unread: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    other.close();
  });

  it('uses a result posted by another tab, and lands it in this tab cache', async () => {
    const sink = vi.fn();
    setSharedSink(sink);
    const other = new BroadcastChannel('dd-tabs');
    other.postMessage({ type: 'poll', key: 'unread:u2', queryKey: ['notifications', 'unread', 'u2'], at: Date.now(), data: { unread: 9 } });
    await flush();
    expect(sink).toHaveBeenCalledWith(['notifications', 'unread', 'u2'], { unread: 9 });
    const fetcher = vi.fn(async () => ({ unread: 1 }));
    expect(await sharedQueryFn('unread:u2', fetcher, 50_000)(ctx({ queryKey: ['notifications', 'unread', 'u2'] }))).toEqual({ unread: 9 });
    expect(fetcher).not.toHaveBeenCalled();
    other.close();
  });

  it('always fetches after an invalidation (a mutation just changed the data)', async () => {
    const fetcher = vi.fn(async () => ({ unread: 0 }));
    const fn = sharedQueryFn('unread:u3', fetcher, 50_000);
    await fn(ctx());
    await fn(ctx({ client: { getQueryState: () => ({ isInvalidated: true }) } }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not reuse stale results', async () => {
    const fetcher = vi.fn(async () => ({ n: 1 }));
    const fn = sharedQueryFn('k:stale', fetcher, 1);
    await fn(ctx());
    await new Promise((r) => setTimeout(r, 5));
    await fn(ctx());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('delivers sign-out messages from other tabs', async () => {
    const got = vi.fn();
    const off = onTabMessage(got);
    const other = new BroadcastChannel('dd-tabs');
    other.postMessage({ type: 'logout' });
    await flush();
    expect(got).toHaveBeenCalledWith({ type: 'logout' });
    off();
    other.close();
    // A tab does not receive its own messages.
    const self = vi.fn();
    const off2 = onTabMessage(self);
    postTabMessage({ type: 'login', userId: 'x' });
    await flush();
    expect(self).not.toHaveBeenCalled();
    off2();
  });
});
