/**
 * Power dialer session persistence (sessionStorage, per browser tab and user).
 * Keeps the work list, position, results and skipped count so a reload, a deploy or a trip to another page
 * does not lose the session. Only a small carrier snapshot is stored; fresh data is fetched on resume.
 */
const VERSION = 1;
export const SESSION_MAX_AGE_MS = 12 * 3600 * 1000;
const keyFor = (userId) => `dd.dialer.session.${userId}`;

const CARRIER_FIELDS = ['id', 'companyName', 'phone', 'email', 'city', 'state', 'timezone', 'doNotCall', 'doNotEmail', 'mcNumber', 'dotNumber', 'priority', 'fleetSize', 'equipment'];

export function snapshotItem(i) {
  const carrier = {};
  for (const k of CARRIER_FIELDS) if (i.carrier?.[k] !== undefined) carrier[k] = i.carrier[k];
  if (i.carrier?.stage) carrier.stage = { key: i.carrier.stage.key, name: i.carrier.stage.name, color: i.carrier.stage.color };
  return {
    key: i.key, carrier, dueAt: i.dueAt ?? null, enrollmentId: i.enrollmentId ?? null,
    step: i.step ? { type: i.step.type, number: i.step.number, index: i.step.index } : null, reason: i.reason || '',
  };
}

export function saveSession(userId, { source, includeUpcoming, session }) {
  if (!userId || !session) return;
  try {
    const data = {
      v: VERSION, savedAt: Date.now(), source, includeUpcoming: !!includeUpcoming,
      index: session.index, skipped: session.skipped, results: (session.results || []).slice(-1000),
      items: session.items.slice(0, 1000).map(snapshotItem),
    };
    window.sessionStorage.setItem(keyFor(userId), JSON.stringify(data));
  } catch { /* storage full or blocked: the session still works, it just will not survive a reload */ }
}

export function loadSession(userId, now = Date.now()) {
  if (!userId) return null;
  try {
    const raw = window.sessionStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const s = JSON.parse(raw);
    const fresh = s && s.v === VERSION && Array.isArray(s.items) && Number.isInteger(s.index) && now - s.savedAt < SESSION_MAX_AGE_MS;
    if (!fresh) { clearSession(userId); return null; }
    return { ...s, results: Array.isArray(s.results) ? s.results : [], skipped: Number(s.skipped) || 0 };
  } catch { return null; }
}

export function clearSession(userId) {
  try { window.sessionStorage.removeItem(keyFor(userId)); } catch { /* blocked storage */ }
}

/**
 * Rebuild a saved session against a fresh copy of its source: items already worked stay (for the progress count),
 * the current item stays, and later items are kept only if they are still in the source (with fresh data).
 */
export function mergeResumed(saved, freshItems) {
  const items = saved.items;
  const index = Math.min(saved.index, items.length);
  if (!Array.isArray(freshItems)) return { items, index };
  const byKey = new Map(freshItems.map((i) => [i.key, i]));
  const done = items.slice(0, index);
  const current = items[index] ? [byKey.get(items[index].key) || items[index]] : [];
  const later = items.slice(index + 1).filter((i) => byKey.has(i.key)).map((i) => byKey.get(i.key));
  return { items: [...done, ...current, ...later], index };
}
