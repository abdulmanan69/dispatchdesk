// Thin fetch wrapper: same-origin cookies, CSRF header, JSON in/out, typed errors, timeouts and cancellation.
//
// Timeouts: reads give up after 30 s; writes after 2 minutes (aborting a write the server may still finish invites a
// duplicate retry, so writes wait longer); uploads and downloads after 10 minutes. Pass { timeoutMs } to change it.
// Cancellation: pass TanStack Query's signal through, e.g. queryFn: ({ signal }) => api.get(url, params, { signal }).

export class ApiError extends Error {
  constructor(status, message, details, extra = {}) {
    super(message);
    this.status = status;
    this.details = details;
    Object.assign(this, extra);
  }
}

export const TIMEOUTS = { read: 30_000, write: 120_000, transfer: 600_000 };

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)dd_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function ensureCsrf() {
  if (!csrfToken()) await fetch('/api/auth/csrf', { credentials: 'same-origin' });
}

export function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** One signal that aborts when the caller's signal aborts or the timeout passes. */
function combineSignals(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => { if (timer) clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); },
  };
}

/** Seconds or HTTP-date from a Retry-After header, as milliseconds (capped at 5 minutes). */
function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const secs = Number(v);
  const ms = Number.isFinite(secs) ? secs * 1000 : new Date(v).getTime() - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 300_000) : undefined;
}

export async function request(method, url, body, { raw = false, signal, timeoutMs } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET' && method !== 'HEAD') {
    await ensureCsrf();
    opts.headers['X-CSRF-Token'] = csrfToken();
  }
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const limit = timeoutMs ?? (raw || body instanceof FormData ? TIMEOUTS.transfer : method === 'GET' || method === 'HEAD' ? TIMEOUTS.read : TIMEOUTS.write);
  const abort = combineSignals(signal, limit);
  opts.signal = abort.signal;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    abort.done();
    if (abort.timedOut()) throw new ApiError(0, 'The server took too long to answer. Try again.', undefined, { timeout: true });
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The request was cancelled.', 'AbortError');
    throw new ApiError(0, 'Network error — check your connection and try again.', undefined, { network: true, cause: err });
  }
  try {
    if (raw) {
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || res.statusText, undefined, { retryAfterMs: retryAfterMs(res) });
      return res;
    }
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('dd:unauthorized'));
      throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details, { retryAfterMs: retryAfterMs(res) });
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (abort.timedOut()) throw new ApiError(0, 'The server took too long to answer. Try again.', undefined, { timeout: true });
    throw err;
  } finally {
    abort.done();
  }
}

export const api = {
  get: (url, params, opts) => request('GET', url + qs(params), undefined, opts),
  post: (url, body, opts) => request('POST', url, body ?? {}, opts),
  put: (url, body, opts) => request('PUT', url, body ?? {}, opts),
  patch: (url, body, opts) => request('PATCH', url, body ?? {}, opts),
  del: (url, body, opts) => request('DELETE', url, body, opts),
  upload: (url, formData, method = 'POST', opts) => request(method, url, formData, opts),
  /** Trigger a browser download for an authenticated GET endpoint. */
  async download(url, fallbackName = 'download', opts) {
    const res = await request('GET', url, undefined, { ...opts, raw: true });
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const name = decodeURIComponent((cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1] || fallbackName);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};
