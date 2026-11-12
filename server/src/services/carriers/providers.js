import * as census from './fmcsaCensus.js';
import * as qc from './fmcsaQc.js';
import { checkAuthority, authorityFields, authorityView, noMcAuthority } from './authority.js';
import { normMc } from './normalize.js';

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

/**
 * Best available record: QC (live authority) merged over census when configured, then operating authority from the
 * FMCSA licensing dataset (the authority record: active only with insurance on file). When licensing does not answer,
 * QCMobile's authority (if any) stands; otherwise authorityStatus stays 'unknown'.
 */
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
  if (merged) {
    const mcNumber = normMc(merged.mcNumber || mc);
    if (!mcNumber) {
      const a = noMcAuthority();
      Object.assign(merged, authorityFields(a), { authority: authorityView(a) });
    } else {
      const a = (await checkAuthority([{ mc: mcNumber, dot: merged.dotNumber || dot }])).get(mcNumber);
      if (a) {
        Object.assign(merged, authorityFields(a), { authority: authorityView(a) });
        sources.push('fmcsa_licensing');
      } else {
        sources.push('fmcsa_licensing:error:did not answer');
        merged.authority = authorityView({ status: merged.authorityStatus || 'unknown', label: merged.operatingStatus || 'Authority not verified', insuranceOnFile: null, revocationPending: null, source: null });
      }
    }
  }
  return { record: merged, sources };
}
