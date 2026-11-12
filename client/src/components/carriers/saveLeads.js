import { api } from '../../lib/api.js';

/** Items the server refused because FMCSA licensing does not show active operating authority (or could not check it). */
export const refusedItems = (res) => (res?.items || []).filter((i) => i.status === 'inactive_authority' || i.status === 'unverified');

/** Confirm dialog text for refused carriers ("Authority is not active. Save anyway?"). */
export function saveAnywayPrompt(refused) {
  const unverified = refused.filter((i) => i.status === 'unverified');
  const inactive = refused.filter((i) => i.status === 'inactive_authority');
  if (!inactive.length) {
    return {
      title: 'Operating authority not verified',
      message: `Could not verify operating authority with FMCSA right now for ${unverified.length === 1 ? 'this carrier' : `${unverified.length} carriers`}. Save anyway?`,
    };
  }
  const one = inactive.length === 1 ? inactive[0] : null;
  const detail = one
    ? `${one.companyName || `USDOT ${one.dotNumber}`}: ${one.authority?.label || 'authority not active'}.`
    : `${inactive.length} of these carriers do not have active operating authority with FMCSA.`;
  return {
    title: 'Authority is not active',
    message: `${detail}${unverified.length ? ` ${unverified.length} more could not be checked right now.` : ''} A carrier cannot haul for-hire loads until FMCSA shows active authority with insurance on file. Save anyway?`,
  };
}

/** Combine the first save answer with the "save anyway" retry for the refused carriers. */
export function mergeSaveResults(first, second) {
  const retried = new Set((second.items || []).map((i) => i.dotNumber));
  const sum = (k) => (first[k] || 0) + (second[k] || 0);
  return {
    ...first,
    created: sum('created'),
    skipped: sum('skipped'),
    limited: sum('limited'),
    notFound: first.notFound || 0,
    inactiveAuthority: second.inactiveAuthority || 0,
    unverified: second.unverified || 0,
    enrolled: (first.enrolled || 0) + (second.enrolled || 0),
    sequence: first.sequence || second.sequence,
    ids: [...(first.ids || []), ...(second.ids || [])],
    items: [...(first.items || []).filter((i) => !retried.has(i.dotNumber)), ...(second.items || [])],
  };
}

/**
 * Save FMCSA census carriers to the CRM (POST /api/discovery/save). The server re-checks operating authority: carriers
 * without active authority come back refused, and this asks "Authority is not active. Save anyway?" before saving them
 * with allowInactive. `allowInactive` skips the question (e.g. pending carriers in the new-authority kit).
 * Resolves to the save result (refused carriers stay refused when the user says no).
 */
export async function saveCensusLeads({ dots, sequenceId, confirm, allowInactive = false }) {
  const body = { dotNumbers: dots, ...(sequenceId !== undefined ? { sequenceId: sequenceId || null } : {}) };
  const first = await api.post('/api/discovery/save', allowInactive ? { ...body, allowInactive: true } : body);
  const refused = refusedItems(first);
  if (!refused.length || !confirm) return first;
  const ok = await confirm({ ...saveAnywayPrompt(refused), confirmLabel: 'Save anyway' });
  if (!ok) return first;
  const second = await api.post('/api/discovery/save', { ...body, dotNumbers: refused.map((i) => i.dotNumber), allowInactive: true });
  return mergeSaveResults(first, second);
}
