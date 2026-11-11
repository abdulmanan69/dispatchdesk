import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { api, ApiError, qs } from './api.js';

const json = (body, { headers = {}, ...init } = {}) => new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...headers } });

/** A fetch that never answers until its signal aborts. */
const hangingFetch = () => vi.fn((url, opts) => new Promise((resolve, reject) => {
  opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
}));

beforeEach(() => { document.cookie = 'dd_csrf=test-token'; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('api request', () => {
  it('sends JSON with the CSRF header and returns data', async () => {
    const fetch = vi.fn(async () => json({ ok: 1 }));
    vi.stubGlobal('fetch', fetch);
    expect(await api.post('/api/x', { a: 1 })).toEqual({ ok: 1 });
    const [, opts] = fetch.mock.calls[0];
    expect(opts.headers['X-CSRF-Token']).toBe('test-token');
    expect(opts.body).toBe('{"a":1}');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('times out a stalled request with a clear error', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const err = await api.get('/api/slow', undefined, { timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.timeout).toBe(true);
    expect(err.message).toMatch(/took too long/i);
  });

  it('passes a caller abort (TanStack signal) through as an AbortError, not a network error', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const p = api.get('/api/search', { q: 'acme' }, { signal: controller.signal });
    controller.abort();
    const err = await p.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it('reports network failures as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await api.get('/api/x').catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.network).toBe(true);
  });

  it('keeps the status, server message and Retry-After of failed requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '7' } })));
    const err = await api.get('/api/x').catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.message).toBe('Too many requests');
    expect(err.retryAfterMs).toBe(7000);
  });

  it('announces a lost session (401) outside the auth routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Authentication required' }, { status: 401 })));
    const seen = vi.fn();
    window.addEventListener('dd:unauthorized', seen);
    await api.get('/api/carriers').catch(() => {});
    await api.get('/api/auth/me').catch(() => {});
    window.removeEventListener('dd:unauthorized', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('builds query strings without empty values', () => {
    expect(qs({ a: 1, b: '', c: null, d: undefined, e: ['x', 'y'] })).toBe('?a=1&e=x&e=y');
    expect(qs({})).toBe('');
  });
});
