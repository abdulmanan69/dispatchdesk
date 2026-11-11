import { useSyncExternalStore } from 'react';

/**
 * Installable app support.
 * - The browser's install prompt (beforeinstallprompt, Chrome/Edge/Android) is captured early and offered from the
 *   account menu. iPhone and iPad have no prompt: people add the app from Safari's Share menu instead.
 * - The service worker (/sw.js) handles push notifications and a small offline screen for /app and the driver page.
 */
let deferred = null;
let installed = false;
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());
let snapshot = { canInstall: false, installed: false };
const update = () => {
  snapshot = { canInstall: !!deferred, installed };
  emit();
};

export function isStandalone() {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  } catch { return false; }
}

export function isIos() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

let started = false;
/** Call once at startup, before React renders, so an early beforeinstallprompt is not missed. */
export function initInstallPrompt() {
  if (started || typeof window === 'undefined') return;
  started = true;
  installed = isStandalone();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own menu item instead of the browser's mini-infobar
    deferred = e;
    update();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    update();
  });
  update();
}

/** Show the browser's install dialog. Resolves to 'accepted', 'dismissed' or 'unavailable'. */
export async function promptInstall() {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;
  update();
  try {
    await e.prompt();
    const choice = await e.userChoice;
    return choice?.outcome || 'dismissed';
  } catch {
    return 'unavailable';
  }
}

const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const getSnapshot = () => snapshot;

/** { canInstall, installed, iosHint } — iosHint: iPhone/iPad Safari where the app can be added to the Home Screen. */
export function useInstallPrompt() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...s, iosHint: !s.installed && !isStandalone() && isIos() };
}

// ---- Service worker ----

let registration = null;
/** Register /sw.js (scope /). Resolves to the registration, or null when service workers are unavailable. */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (registration) return registration;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return registration;
  } catch (err) {
    console.warn('[sw] registration failed', err?.message || err);
    return null;
  }
}

/** Register the service worker after the page has loaded, on app and driver pages (production builds only). */
export function registerServiceWorkerWhenIdle() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const path = window.location.pathname;
  if (!(path === '/app' || path.startsWith('/app/') || path.startsWith('/track/'))) return;
  const go = () => { registerServiceWorker(); };
  if (document.readyState === 'complete') setTimeout(go, 1000);
  else window.addEventListener('load', () => setTimeout(go, 1000), { once: true });
}
