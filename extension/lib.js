// Shared helpers for the popup, side panel, options page and background worker.

export const DEFAULT_CONFIG = { appUrl: '', token: '' };

/** App URL from storage, else from the config.json shipped in the downloaded zip. */
export async function getConfig() {
  const stored = await chrome.storage.local.get(['appUrl', 'token']);
  let appUrl = stored.appUrl || '';
  if (!appUrl) {
    try {
      const res = await fetch(chrome.runtime.getURL('config.json'));
      if (res.ok) appUrl = (await res.json()).appUrl || '';
    } catch { /* no bundled config */ }
  }
  return { appUrl: appUrl.replace(/\/$/, ''), token: stored.token || '' };
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Authenticated JSON request to the DispatchDesk API using the personal access token. */
export async function api(method, path, body) {
  const { appUrl, token } = await getConfig();
  if (!appUrl || !token) throw new ApiError(0, 'Not connected. Open the extension options and add your app URL and token.');
  let res;
  try {
    res = await fetch(`${appUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, `Cannot reach ${appUrl}. Check the URL and that the extension has permission for it.`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

export const digits = (s) => String(s || '').replace(/\D/g, '');

/** Normalise a US phone to 10 digits, or null. */
export function usPhone(s) {
  let d = digits(s);
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 && /^[2-9]/.test(d) ? d : null;
}

export const prettyPhone = (d) => {
  const x = usPhone(d) || digits(d);
  return x.length === 10 ? `(${x.slice(0, 3)}) ${x.slice(3, 6)}-${x.slice(6)}` : String(d || '');
};

/** Session-scoped window/tab bookkeeping (workspace windows, the tab calls open in). */
export async function getSessionState() {
  return chrome.storage.session.get(['workspace', 'dialTabId']);
}

async function tabAlive(id) {
  if (id == null) return false;
  try { await chrome.tabs.get(id); return true; } catch { return false; }
}

/**
 * Open a provider link. https links (Google Voice, Teams) reuse the workspace's right-hand window
 * or the tab a previous call opened, instead of piling up new tabs. App schemes (tel:, callto:, sip:)
 * are handed to the OS by navigating a tab, which the OS intercepts.
 */
const GV = /^https:\/\/voice\.google\.com\//i;

/** Google Voice: use the account chosen in options (u/0, u/1, …) and an already-open, signed-in Voice tab when there is one. */
export async function googleVoiceUrl(url) {
  const { gvAccount = '0' } = await chrome.storage.local.get('gvAccount');
  return url.replace(/voice\.google\.com\/u\/\d+\//i, `voice.google.com/u/${gvAccount}/`);
}

/** The open Google Voice tab for the account in `url`, if any. */
export async function findVoiceTab(url) {
  const account = (url.match(/\/u\/(\d+)\//) || [])[1] || '0';
  const tabs = await chrome.tabs.query({ url: 'https://voice.google.com/*' }).catch(() => []);
  return tabs.find((t) => (t.url || '').includes(`/u/${account}/`)) || (account === '0' ? tabs.find((t) => !/\/u\/\d+\//.test(t.url || '')) : null) || null;
}

async function openVoiceTab(url) {
  const same = await findVoiceTab(url);
  if (!same) return false;
  await chrome.tabs.update(same.id, { url, active: true });
  await chrome.windows.update(same.windowId, { focused: true }).catch(() => {});
  await chrome.storage.session.set({ dialTabId: same.id });
  return true;
}

export async function openDialUrl(url) {
  if (!url) return;
  if (GV.test(url)) url = await googleVoiceUrl(url);
  const { workspace, dialTabId } = await getSessionState();
  if (/^https?:/i.test(url)) {
    if (workspace?.rightTabId != null && await tabAlive(workspace.rightTabId)) {
      await chrome.tabs.update(workspace.rightTabId, { url, active: true });
      if (workspace.rightWindowId != null) await chrome.windows.update(workspace.rightWindowId, { focused: true }).catch(() => {});
      return;
    }
    if (GV.test(url) && await openVoiceTab(url)) return;
    if (await tabAlive(dialTabId)) {
      const tab = await chrome.tabs.update(dialTabId, { url, active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return;
    }
    const tab = await chrome.tabs.create({ url });
    await chrome.storage.session.set({ dialTabId: tab.id });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null && /^https?:/i.test(tab.url || '')) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url, active: false });
}

/**
 * Place a call through the user's configured provider (server decides: tel/Google Voice/… link or Twilio bridge).
 * Always the result of a user click. Returns { message, attempt, carrier }.
 */
export async function dial({ phone, carrierId }) {
  const out = await api('POST', '/api/telephony/dial', carrierId ? { carrierId } : { phone });
  const url = out.url || out.link || out.dialUrl;
  if (url) await openDialUrl(url);
  const message = out.message || (out.mode === 'bridge' ? 'Your phone will ring first, then the call connects' : 'Call started');
  return { message, attempt: out.attempt || null, carrier: out.attempt?.carrier || null, mode: out.mode };
}

/** Hand a carrier (and the call attempt, if any) to the side panel so disposition is one click away. */
export async function focusPanel(payload) {
  await chrome.storage.session.set({ panelFocus: { ...payload, at: Date.now() } });
}

export const CALL_OUTCOMES = ['no_answer', 'busy', 'voicemail', 'interested', 'not_interested', 'call_back', 'follow_up', 'converted'];
export const label = (k) => String(k || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * Themed dropdown (no native <select>). options: [{ value, label }]. Returns { el, value(), set(v), setOptions(opts) }.
 * Keyboard: Enter/Space/ArrowDown opens, arrows move, Enter picks, Escape closes.
 */
export function dropdown({ options = [], value = '', placeholder = 'Choose', onChange, ariaLabel }) {
  let opts = options;
  let current = value;
  let active = -1;
  const wrap = document.createElement('div');
  wrap.className = 'dd';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  const list = document.createElement('ul');
  list.className = 'dd-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.append(btn, list);

  const text = () => opts.find((o) => o.value === current)?.label || placeholder;
  const render = () => {
    btn.textContent = text();
    btn.classList.toggle('placeholder', !opts.some((o) => o.value === current));
    list.replaceChildren(...opts.map((o, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(o.value === current));
      li.className = i === active ? 'active' : '';
      li.textContent = o.label;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(o.value); });
      return li;
    }));
  };
  const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => { active = Math.max(0, opts.findIndex((o) => o.value === current)); list.hidden = false; btn.setAttribute('aria-expanded', 'true'); render(); };
  const pick = (v) => { current = v; close(); render(); onChange?.(v); btn.focus(); };
  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('blur', () => setTimeout(close, 120));
  btn.addEventListener('keydown', (e) => {
    if (list.hidden && ['Enter', ' ', 'ArrowDown'].includes(e.key)) { e.preventDefault(); open(); return; }
    if (list.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(opts.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opts[active]) pick(opts[active].value); }
  });
  render();
  return { el: wrap, value: () => current, set: (v) => { current = v; render(); }, setOptions: (o) => { opts = o; render(); } };
}

/** Themed segmented choice (chips). Returns { el, value(), set(v) }. */
export function chips({ options, value, onChange, ariaLabel }) {
  let current = value;
  const el = document.createElement('div');
  el.className = 'chips';
  el.setAttribute('role', 'radiogroup');
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
  const render = () => {
    el.replaceChildren(...options.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(o.value === current));
      b.textContent = o.label;
      b.addEventListener('click', () => { current = o.value; render(); onChange?.(o.value); });
      return b;
    }));
  };
  render();
  return { el, value: () => current, set: (v) => { current = v; render(); } };
}
