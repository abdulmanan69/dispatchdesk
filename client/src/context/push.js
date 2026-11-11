import { api } from '../lib/api.js';
import { isIos, isStandalone, registerServiceWorker } from './pwa.js';

/**
 * Browser side of Web Push: permission, subscribe/unsubscribe and keeping the server's copy in sync.
 * The server never returns endpoints; this browser remembers its own endpoint, device id and the account it belongs
 * to, so a shared computer never shows one person's notifications to the next person who signs in.
 */
const ENDPOINT_KEY = 'dd:push-endpoint';
const ID_KEY = 'dd:push-device';
const USER_KEY = 'dd:push-user';

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};
const forget = () => { store.del(ENDPOINT_KEY); store.del(ID_KEY); store.del(USER_KEY); };

/**
 * What this browser can do:
 * - supported: service worker + Push API + Notification API are present
 * - needsInstall: iPhone/iPad Safari, where push works only from the Home Screen app (iOS 16.4+)
 * - permission: 'default' | 'granted' | 'denied' | 'unsupported'
 */
export function pushSupport() {
  const hasApis = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return {
    supported: hasApis,
    needsInstall: !hasApis && isIos() && !isStandalone(),
    permission: hasApis ? Notification.permission : 'unsupported',
  };
}

export const thisDeviceId = () => store.get(ID_KEY);

export function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(subscription, publicKey) {
  const key = subscription?.options?.applicationServerKey;
  if (!key) return true; // older browsers do not expose it; assume it matches
  const a = new Uint8Array(key);
  const b = urlBase64ToUint8Array(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function currentSubscription() {
  if (!pushSupport().supported) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

async function upload(subscription, userId) {
  const json = subscription.toJSON();
  const previous = store.get(ENDPOINT_KEY);
  const res = await api.post('/api/push/subscriptions', {
    endpoint: json.endpoint,
    keys: json.keys,
    previousEndpoint: previous && previous !== json.endpoint ? previous : undefined,
  });
  store.set(ENDPOINT_KEY, json.endpoint);
  if (res?.id) store.set(ID_KEY, res.id);
  if (userId) store.set(USER_KEY, userId);
  return res;
}

/** Ask for permission (call from a click), subscribe this browser and register it for this account. */
export async function enablePush(userId) {
  const support = pushSupport();
  if (!support.supported) throw new Error(support.needsInstall ? 'Add DispatchDesk to your Home Screen first, then open it from there.' : 'This browser does not support push notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.' : 'Notifications were not allowed.');
  }
  if (!(await registerServiceWorker())) throw new Error('This browser could not start the DispatchDesk service worker.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.get('/api/push/vapid-public-key');
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  return upload(sub, userId);
}

/** Stop push on this browser: remove it on the server (while signed in), then unsubscribe locally. */
export async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  const endpoint = sub?.endpoint || store.get(ENDPOINT_KEY);
  if (endpoint) await api.del('/api/push/subscriptions', { endpoint }).catch(() => {});
  if (sub) await sub.unsubscribe().catch(() => {});
  forget();
}

/**
 * Once per app load for the signed-in user:
 * - the subscription belongs to another account (shared computer, session expired before sign-out): unsubscribe it
 *   here, so the push service tells the server it is gone; this account can turn push on itself.
 * - the browser rotated its subscription: send the new one (replacing the old row).
 */
export async function syncPushSubscription(userId) {
  try {
    if (!pushSupport().supported) return;
    const sub = await currentSubscription();
    const owner = store.get(USER_KEY);
    if (!sub) { if (owner) forget(); return; }
    if (!owner || owner !== userId) {
      if (owner) { await sub.unsubscribe().catch(() => {}); forget(); }
      return;
    }
    if (Notification.permission !== 'granted') return;
    if (store.get(ENDPOINT_KEY) === sub.endpoint && store.get(ID_KEY)) return;
    await upload(sub, userId);
  } catch { /* best effort */ }
}

/** "Chrome on Android", "Safari on iPhone", "Home Screen app on iPhone" from a stored user agent. */
export function deviceLabel(ua = '') {
  const s = String(ua || '');
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /CrOS/.test(s) ? 'ChromeOS'
    : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari'
      : /iPhone|iPad/.test(s) ? 'Home Screen app' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}
