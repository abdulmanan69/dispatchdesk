// Thin fetch wrapper: same-origin cookies, CSRF header, JSON in/out, typed errors.

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)dd_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function ensureCsrf() {
  if (!csrfToken()) await fetch('/api/auth/csrf', { credentials: 'same-origin' });
}

export function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export async function request(method, url, body, { raw = false } = {}) {
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
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || res.statusText);
    return res;
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('dd:unauthorized'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
  }
  return data;
}

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url, body) => request('DELETE', url, body),
  upload: (url, formData, method = 'POST') => request(method, url, formData),
  /** Trigger a browser download for an authenticated GET endpoint. */
  async download(url, fallbackName = 'download') {
    const res = await request('GET', url, undefined, { raw: true });
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
