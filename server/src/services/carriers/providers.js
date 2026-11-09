import * as census from './fmcsaCensus.js';
import * as qc from './fmcsaQc.js';

/**
 * Carrier-data provider registry. A provider module exports:
 *   id, label, status() -> { id, label, available, configured, requiresKey, note }
 *   lookup({ dot, mc }) -> mapped carrier fields | null
 *   search(filters)     -> { items, retrievedAt, source }   (optional)
 * Add new providers (paid data vendors etc.) by appending to PROVIDERS.
 */
export const PROVIDERS = [census, qc];

export const getProvider = (pid) => PROVIDERS.find((p) => p.id === pid);

export async function providerStatuses() {
  return Promise.all(PROVIDERS.map((p) => p.status()));
}

/** Best available record: QC (live authority) merged over census when configured. */
export async function enrichLookup({ dot, mc }) {
  const sources = [];
  let merged = null;
  const c = await census.lookup({ dot, mc });
  if (c) { merged = { ...c }; sources.push(census.id); }
  const qcStatus = await qc.status();
  if (qcStatus.configured) {
    const q = await qc.lookup({ dot: dot || merged?.dotNumber, mc }).catch((err) => { sources.push(`${qc.id}:error:${err.message}`); return null; });
    if (q) {
      merged = { ...(merged || {}), ...Object.fromEntries(Object.entries(q).filter(([, v]) => v != null)) };
      sources.push(qc.id);
    }
  }
  return { record: merged, sources };
}
