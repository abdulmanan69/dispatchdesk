/**
 * Messages between open tabs of the app (same browser profile): sign-out and sign-in, and shared poll results.
 * Uses BroadcastChannel, with a localStorage "storage" event fallback for browsers without it.
 * A tab never receives its own messages.
 */
const CHANNEL = 'dd-tabs';
const STORAGE_KEY = 'dd:tab-message';
const listeners = new Set();
let channel; // undefined = not set up yet, null = unavailable

function emit(msg) {
  if (!msg || typeof msg !== 'object') return;
  for (const fn of listeners) {
    try { fn(msg); } catch (err) { console.error('[tabs]', err); }
  }
}

function setup() {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e) => emit(e.data);
      return channel;
    }
  } catch { channel = null; }
  try {
    window.addEventListener('storage', (e) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try { emit(JSON.parse(e.newValue).msg); } catch { /* ignore malformed */ }
    });
  } catch { /* no storage events */ }
  return channel;
}

export function postTabMessage(msg) {
  const ch = setup();
  try {
    if (ch) ch.postMessage(msg);
    else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ msg, at: Date.now(), n: Math.random() }));
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* storage full or blocked; other tabs catch up on their next request */ }
}

export function onTabMessage(fn) {
  setup();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- Shared polling: when several tabs are visible, the first to poll shares the result with the others. ----

const shared = new Map(); // key -> { at, data }

onTabMessage((msg) => {
  if (msg.type === 'poll' && msg.key) {
    shared.set(msg.key, { at: msg.at, data: msg.data });
    sharedSink?.(msg.queryKey, msg.data);
  } else if (msg.type === 'logout') {
    shared.clear();
  }
});

let sharedSink = null;
/** Register how shared results reach this tab's query cache (set once from the app root). */
export function setSharedSink(fn) { sharedSink = fn; }
export function clearShared() { shared.clear(); }

/**
 * Wrap a queryFn so that tabs share one poll: when another tab fetched the same key less than maxAgeMs ago, use its
 * result instead of asking the server. Explicit invalidations (after a mutation) always fetch.
 * `key` must identify the user too (for example `notifications:unread:<userId>`).
 */
export function sharedQueryFn(key, fn, maxAgeMs) {
  return async (ctx) => {
    const invalidated = ctx?.client?.getQueryState?.(ctx.queryKey)?.isInvalidated;
    const hit = shared.get(key);
    if (!invalidated && hit && Date.now() - hit.at < maxAgeMs) return hit.data;
    const data = await fn(ctx);
    const at = Date.now();
    shared.set(key, { at, data });
    postTabMessage({ type: 'poll', key, queryKey: ctx?.queryKey, at, data });
    return data;
  };
}
