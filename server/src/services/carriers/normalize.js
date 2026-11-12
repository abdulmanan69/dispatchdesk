import { timezoneForState } from '../../lib/timezones.js';

/** Keep only keys the client actually sent (validate.optStr() turns missing keys into null). */
export function onlySent(parsed, raw) {
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => raw && Object.prototype.hasOwnProperty.call(raw, k)));
}

export const digits =(v) => String(v ?? '').replace(/\D/g, '');

/** Normalise a US phone to 10 digits (drops leading country code 1). Returns null when not plausible. */
export function normPhone(v) {
  let d = digits(v);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length >= 7 ? d : null;
}

export function normDot(v) {
  const d = digits(v).replace(/^0+/, '');
  return d || null;
}

/** MC / docket numbers are stored as digits only (no "MC" prefix, no leading zeros). */
export function normMc(v) {
  const d = digits(v).replace(/^0+/, '');
  return d || null;
}

export function normState(v) {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

const EQUIP_ALIASES = {
  dry_van: ['dry van', 'van', 'dryvan', 'dv', 'dry_van'],
  reefer: ['reefer', 'refrigerated', 'temp controlled', 'rf'],
  flatbed: ['flatbed', 'flat bed', 'fb', 'flat'],
  step_deck: ['step deck', 'stepdeck', 'step_deck', 'sd', 'drop deck'],
  power_only: ['power only', 'power_only', 'po'],
  hotshot: ['hotshot', 'hot shot'],
  box_truck: ['box truck', 'box_truck', 'straight truck', 'box'],
  tanker: ['tanker', 'tank'],
  car_hauler: ['car hauler', 'car_hauler', 'auto transport', 'auto'],
  conestoga: ['conestoga'],
  lowboy: ['lowboy', 'rgn'],
  other: ['other'],
};

/** Parse free text like "Dry Van, Reefer" into canonical keys joined by comma. */
export function normEquipment(v) {
  if (!v) return null;
  const parts = String(v).toLowerCase().split(/[,;/|]+/).map((s) => s.trim()).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    for (const [key, aliases] of Object.entries(EQUIP_ALIASES)) {
      if (aliases.includes(p) || p === key) out.add(key);
    }
  }
  return out.size ? [...out].join(',') : null;
}

export function normAuthority(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['a', 'active', 'authorized', 'yes', 'y'].includes(s)) return 'active';
  if (['i', 'inactive', 'revoked', 'not authorized', 'no', 'n'].includes(s)) return 'inactive';
  if (['p', 'pending'].includes(s)) return 'pending';
  if (['none', 'no mc', 'no mc authority'].includes(s)) return 'none';
  return 'unknown';
}

export function intOrNull(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n) : null;
}

export function dateOrNull(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const trimOrNull = (v, max = 300) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
export { trimOrNull };

/** Apply canonical normalisation to a carrier input object (used by create, import and providers). */
export function normalizeCarrier(input) {
  const state = normState(input.state);
  const out = {
    companyName: trimOrNull(input.companyName, 200),
    dbaName: trimOrNull(input.dbaName, 200),
    dotNumber: normDot(input.dotNumber),
    mcNumber: normMc(input.mcNumber),
    phone: normPhone(input.phone),
    email: trimOrNull(input.email, 254)?.toLowerCase() ?? null,
    address: trimOrNull(input.address, 300),
    city: trimOrNull(input.city, 100),
    state,
    zip: trimOrNull(input.zip, 12),
  };
  if (state) out.timezone = timezoneForState(state);
  return out;
}

/** Find existing carriers of an owner matching DOT, MC or phone. */
export async function findDuplicates(prisma, ownerId, { dotNumber, mcNumber, phone }, excludeId) {
  const or = [];
  if (dotNumber) or.push({ dotNumber });
  if (mcNumber) or.push({ mcNumber });
  if (phone) or.push({ phone });
  if (!or.length) return [];
  return prisma.carrier.findMany({
    where: { ownerId, OR: or, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true, companyName: true, dotNumber: true, mcNumber: true, phone: true },
    take: 5,
  });
}
