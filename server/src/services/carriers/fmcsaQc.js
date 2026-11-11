import { getSetting } from '../../lib/settings.js';
import { HttpError } from '../../lib/errors.js';
import { normDot, normMc, normPhone, normState, intOrNull, trimOrNull } from './normalize.js';
import { timezoneForState } from '../../lib/timezones.js';

/**
 * FMCSA QCMobile API (https://mobile.fmcsa.dot.gov/qc/services). Requires a free "webKey"
 * from FMCSA. Provides live operating-authority status, which the census file does not.
 */
export const id = 'fmcsa_qc';
export const label = 'FMCSA QCMobile (live authority)';
const BASE = 'https://mobile.fmcsa.dot.gov/qc/services';

export async function status() {
  const key = await getSetting('fmcsa.webKey');
  return {
    id, label, available: !!key, configured: !!key, requiresKey: true,
    note: key ? 'Configured.' : 'Not configured — add an FMCSA webKey (FMCSA_WEBKEY or Admin → Integrations) to enable live authority checks.',
  };
}

async function get(path, fetchImpl = globalThis.fetch) {
  const key = await getSetting('fmcsa.webKey');
  if (!key) throw new HttpError(503, 'FMCSA QCMobile is not configured (missing webKey).');
  let res;
  try {
    res = await fetchImpl(`${BASE}${path}${path.includes('?') ? '&' : '?'}webKey=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new HttpError(502, `FMCSA QCMobile unreachable: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'FMCSA QCMobile rejected the webKey.');
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `FMCSA QCMobile error (${res.status})`);
  return res.json().catch(() => null);
}

const authorityFrom = (list) => {
  const a = Array.isArray(list) ? list.map((x) => x.carrierAuthority || x).find(Boolean) : null;
  if (!a) return null;
  const vals = [a.commonAuthorityStatus, a.contractAuthorityStatus].map((v) => String(v || '').toUpperCase());
  if (vals.includes('A')) return 'active';
  if (vals.includes('P') || String(a.authorizedForProperty || '').toUpperCase() === 'P') return 'pending';
  if (vals.some((v) => v === 'I' || v === 'N')) return 'inactive';
  return 'unknown';
};

export function mapCarrier(c, authority) {
  if (!c) return null;
  const state = normState(c.phyState);
  return {
    companyName: trimOrNull(c.legalName, 200),
    dbaName: trimOrNull(c.dbaName, 200),
    dotNumber: normDot(c.dotNumber),
    phone: normPhone(c.telephone || c.phone),
    address: trimOrNull(c.phyStreet, 300),
    city: trimOrNull(c.phyCity, 100),
    state,
    zip: trimOrNull(c.phyZipcode, 12),
    timezone: timezoneForState(state),
    fleetSize: intOrNull(c.totalPowerUnits),
    drivers: intOrNull(c.totalDrivers),
    authorityStatus: authority || (c.allowedToOperate === 'Y' ? 'active' : c.allowedToOperate === 'N' ? 'inactive' : 'unknown'),
    operatingStatus: c.allowedToOperate === 'Y' ? 'Allowed to operate' : c.allowedToOperate === 'N' ? 'Not allowed to operate' : null,
  };
}

const thousands = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? Math.round(n * 1000) : null;
};
const yn = (v) => (String(v || '').toUpperCase() === 'Y' ? true : String(v || '').toUpperCase() === 'N' ? false : null);

/**
 * Insurance and operating status on file with FMCSA for one USDOT number (QCMobile, needs the webKey).
 * Amounts are dollars (QCMobile reports thousands). Returns null when not configured or not found; fields QCMobile
 * leaves out stay null so the UI can say "unknown" instead of guessing.
 */
export async function readinessDetails(dot, fetchImpl) {
  const dotNumber = normDot(dot);
  if (!dotNumber || !(await getSetting('fmcsa.webKey'))) return null;
  const res = await get(`/carriers/${dotNumber}`, fetchImpl);
  const c = res?.content?.carrier;
  if (!c) return null;
  const auth = await get(`/carriers/${dotNumber}/authority`, fetchImpl).catch(() => null);
  return {
    authorityStatus: authorityFrom(auth?.content),
    allowedToOperate: yn(c.allowedToOperate),
    bipdOnFile: thousands(c.bipdInsuranceOnFile),
    bipdRequired: thousands(c.bipdRequiredAmount),
    cargoOnFile: thousands(c.cargoInsuranceOnFile),
    cargoRequired: yn(c.cargoInsuranceRequired),
    bondOnFile: thousands(c.bondInsuranceOnFile),
    outOfServiceDate: trimOrNull(c.oosDate, 40),
    safetyRating: trimOrNull(c.safetyRating, 40),
  };
}

export async function lookup({ dot, mc }, fetchImpl) {
  let dotNumber = normDot(dot);
  if (!dotNumber && mc) {
    const res = await get(`/carriers/docket-number/${normMc(mc)}`, fetchImpl);
    const c = Array.isArray(res?.content) ? res.content[0]?.carrier : res?.content?.carrier;
    dotNumber = normDot(c?.dotNumber);
    if (!dotNumber) return null;
  }
  if (!dotNumber) return null;
  const res = await get(`/carriers/${dotNumber}`, fetchImpl);
  const carrier = res?.content?.carrier;
  if (!carrier) return null;
  const auth = await get(`/carriers/${dotNumber}/authority`, fetchImpl).catch(() => null);
  return mapCarrier(carrier, authorityFrom(auth?.content));
}
