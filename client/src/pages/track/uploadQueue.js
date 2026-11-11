/**
 * Upload queue for the driver page. Photos waiting for signal are kept in IndexedDB, so they survive a reload or the
 * browser discarding the tab; when IndexedDB is not available (private mode on some phones) they stay in memory until
 * the page closes. Items: { id, token, loadId, type, pages, name, mime, blob, createdAt, attempts, error }
 * (loadId: the trip the driver's page showed when the file was added).
 */
const DB_NAME = 'dd-driver-uploads';
const STORE = 'queue';
const memory = new Map();
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function enqueue(item) {
  const row = { attempts: 0, error: null, createdAt: Date.now(), ...item, id: item.id || newId() };
  const db = await openDb();
  if (db) {
    try { await tx(db, 'readwrite', (s) => s.put(row)); return row; } catch { /* storage full or blocked: keep it in memory */ }
  }
  memory.set(row.id, row);
  return row;
}

export async function update(row) {
  if (memory.has(row.id)) { memory.set(row.id, row); return; }
  const db = await openDb();
  if (db) { try { await tx(db, 'readwrite', (s) => s.put(row)); } catch { memory.set(row.id, row); } } else memory.set(row.id, row);
}

export async function remove(id) {
  memory.delete(id);
  const db = await openDb();
  if (db) { try { await tx(db, 'readwrite', (s) => s.delete(id)); } catch { /* already gone */ } }
}

/** Items waiting for this link, oldest first. */
export async function list(token) {
  const out = [...memory.values()].filter((x) => x.token === token);
  const db = await openDb();
  if (db) {
    try {
      const rows = await tx(db, 'readonly', (s) => s.getAll());
      for (const r of rows || []) if (r.token === token && !memory.has(r.id)) out.push(r);
    } catch { /* unreadable: memory only */ }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** For tests. */
export function _reset() { memory.clear(); dbPromise = null; }
