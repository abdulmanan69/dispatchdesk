/* DispatchDesk service worker.
 *
 * 1. Push notifications: shows each push and opens the right page when it is clicked.
 * 2. Small offline shell: navigations to /app and the driver page /track/* go to the network first; when the device is
 *    offline, the last copy of the page shell is shown (the app then shows its own "can't connect" states), or a short
 *    offline notice. Hashed build files under /assets/ are cached (they never change).
 *
 * Never cached: anything under /api/ (user data), other origins, and non-GET requests.
 */
const VERSION = 'v1';
const SHELL_CACHE = `dd-shell-${VERSION}`;
const ASSET_CACHE = `dd-assets-${VERSION}`;
const MAX_ASSETS = 120;

const kindOf = (pathname) => (pathname === '/app' || pathname.startsWith('/app/') ? 'app' : pathname.startsWith('/track/') ? 'track' : null);
const shellKey = (kind) => `/__shell/${kind}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dd-') && k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Keep a copy of the shell for the pages that are open now, so they can start offline next time.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const seen = new Set();
    for (const w of windows) {
      const url = new URL(w.url);
      const kind = kindOf(url.pathname);
      if (!kind || seen.has(kind)) continue;
      seen.add(kind);
      await warmShell(kind, kind === 'app' ? '/app' : url.pathname).catch(() => {});
    }
  })());
});

async function trimAssets(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

async function cacheAsset(cache, request, response) {
  if (!response || !response.ok || response.type !== 'basic') return;
  await cache.put(request, response);
  await trimAssets(cache);
}

const assetsIn = (html) => [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];

/**
 * Store a shell page and make sure the build files it references are cached and counted as recent (the asset cache
 * trims the oldest entries first, so files of the current build are moved to the end).
 */
async function storeShell(kind, response) {
  const html = await response.clone().text();
  await (await caches.open(SHELL_CACHE)).put(shellKey(kind), response);
  const cache = await caches.open(ASSET_CACHE);
  for (const url of assetsIn(html)) {
    const hit = await cache.match(url);
    if (hit) {
      await cache.delete(url);
      await cache.put(url, hit);
      continue;
    }
    const r = await fetch(url, { credentials: 'same-origin' }).catch(() => null);
    await cacheAsset(cache, url, r);
  }
}

/** Fetch the shell HTML for a page kind and store it with its build files. */
async function warmShell(kind, path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-cache' });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return;
  await storeShell(kind, res);
}

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline · DispatchDesk</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#fafafa;color:#171717;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#141415;color:#ededed}a{color:#5eead4}}
main{max-width:420px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;line-height:1.5;margin:0 0 16px;opacity:.75}a{color:#0f766e;font-weight:600;font-size:14px}</style></head>
<body><main><h1>You're offline</h1><p>DispatchDesk needs a connection to load this page. Check your signal, then try again.</p><a href="">Try again</a></main></body></html>`;

const offline = () => new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

async function networkFirstShell(event, kind) {
  let res;
  try {
    res = await fetch(event.request);
  } catch {
    return (await caches.match(shellKey(kind), { cacheName: SHELL_CACHE })) || offline();
  }
  const html = (res.headers.get('content-type') || '').includes('text/html');
  if (res.ok && html) {
    event.waitUntil(storeShell(kind, res.clone()).catch(() => {}));
    return res;
  }
  // While the server restarts during a deploy (502/503/504), the saved shell starts the app, which retries on its own.
  if (res.status >= 500) {
    const cached = await caches.match(shellKey(kind), { cacheName: SHELL_CACHE });
    if (cached) return cached;
  }
  return res;
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  cacheAsset(cache, request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // user data is never cached
  if (request.mode === 'navigate') {
    const kind = kindOf(url.pathname);
    if (kind) event.respondWith(networkFirstShell(event, kind));
    return;
  }
  if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirstAsset(request));
});

// ---- Push notifications ----

const safePath = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '/app/notifications');

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try { data = { body: event.data ? event.data.text() : '' }; } catch { data = {}; }
  }
  const title = String(data.title || 'DispatchDesk').slice(0, 200);
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  const options = {
    body: String(data.body || '').slice(0, 500),
    icon: '/icons/icon-192.png',
    data: { url: safePath(data.url), id: data.id || null },
    timestamp: Date.now(),
  };
  if (tag) {
    options.tag = tag; // one visible notification per kind; a newer one replaces it
    options.renotify = data.renotify !== false;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data?.url), self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const inApp = windows.find((w) => kindOf(new URL(w.url).pathname) === 'app');
    if (inApp) {
      // The open app navigates itself (keeps unsaved work in other parts of the app shell).
      inApp.postMessage({ type: 'dd:navigate', href: target.pathname + target.search });
      await inApp.focus().catch(() => {});
      return;
    }
    const any = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (any && 'navigate' in any) {
      try {
        const w = await any.navigate(target.href);
        if (w) { await w.focus().catch(() => {}); return; }
      } catch { /* not controlled by this worker: open a new window */ }
    }
    await self.clients.openWindow(target.href);
  })());
});

// The browser replaced the subscription: subscribe again with the same key. The app sends the new subscription to
// the server the next time it opens (it cannot be sent from here: the API needs the page's CSRF token).
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription && event.oldSubscription.options;
  if (!options || !options.applicationServerKey) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey }).catch(() => {}));
});
