/**
 * After a deploy, tabs opened earlier still reference the previous build's hashed chunks, which no longer exist.
 * Loading one fails; the fix is a single page reload, which fetches the new build. A sessionStorage timestamp
 * prevents reload loops (at most one automatic reload per 30 seconds per tab).
 */
const KEY = 'dd:chunk-reload';
const WINDOW_MS = 30_000;

const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed|dynamically imported module/i;

export function isChunkError(err) {
  if (!err) return false;
  if (err.name === 'ChunkLoadError') return true;
  return CHUNK_ERROR.test(String(err.message || err));
}

/** True when an automatic reload already happened in the last 30 seconds (or storage is unavailable). */
export function recentlyReloaded() {
  try {
    return Date.now() - Number(sessionStorage.getItem(KEY) || 0) < WINDOW_MS;
  } catch {
    return true; // cannot guard against loops: do not reload automatically
  }
}

/**
 * Reload once to pick up the new version. `href`: load this same-origin path instead of reloading the current one
 * (the page the user was navigating to). Returns false when it would risk a loop.
 */
export function reloadForNewVersion(href) {
  if (recentlyReloaded()) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { return false; }
  if (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')) window.location.assign(href);
  else window.location.reload();
  return true;
}

/**
 * Wrap a dynamic import: on a chunk-load failure, reload once and keep the promise pending (the page is going away);
 * otherwise rethrow so the route's error screen can explain. `target()` may name the page being opened.
 */
export function importWithReload(load, target) {
  return () => load().catch((err) => {
    if (isChunkError(err) && reloadForNewVersion(target?.() || undefined)) return new Promise(() => {});
    throw err;
  });
}
