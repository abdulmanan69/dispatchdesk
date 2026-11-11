/**
 * Short per-user cache for report responses (per worker process). Reports are summaries over many loads, so a 45 s
 * window keeps page reloads and tab switches cheap; a request with `Cache-Control: no-cache` (a manual refresh)
 * recomputes. Keys always start with the user id, so one user never gets another user's numbers.
 */
export const REPORT_TTL_MS = 45_000;
const MAX_ENTRIES = 5000;
const store = new Map();

export async function cachedReport(req, parts, compute) {
  const key = `${req.user.id}|${parts.join('|')}`;
  const fresh = req.get('cache-control') !== 'no-cache';
  const hit = store.get(key);
  if (fresh && hit && Date.now() - hit.at < REPORT_TTL_MS) return hit.value;
  const value = await compute();
  if (store.size >= MAX_ENTRIES) store.clear();
  store.set(key, { at: Date.now(), value });
  return value;
}

export function clearReportCache() {
  store.clear();
}
