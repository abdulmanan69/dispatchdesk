import { prisma } from '../../db.js';
import { checkLoadFit, fitKey } from './fit.js';

/**
 * Server side of the load check card: the carrier's rules come from its Customer row (the rule columns) and its
 * equipment from the Carrier row. Used when a load is saved (the warnings are stored on Load.fitWarnings, and an
 * acknowledgement is kept only while the same warnings apply) and by GET /api/customers/rules.
 * Warnings never block a save.
 */
export const RULE_FIELDS = [
  'minRatePerMile', 'maxDeadheadMiles', 'maxWeightLbs', 'trailerLengthFt', 'hazmat', 'twic', 'teamDrivers',
  'avoidStates', 'homeTimeDays', 'costPerMileCents', 'minHaulMiles', 'maxHaulMiles',
];

/** Rules object for checkLoadFit from a Customer row (+ its carrier). */
export function rulesOf(customer, carrier) {
  if (!customer) return null;
  const rules = Object.fromEntries(RULE_FIELDS.map((k) => [k, customer[k] ?? null]));
  rules.equipment = carrier?.equipment || null;
  rules.carrierName = carrier?.companyName || null;
  return rules;
}

/** { customerId, dispatchFeePercent, status, rules } for a carrier that is a customer, else null. */
export async function rulesForCarrier(carrierId) {
  if (!carrierId) return null;
  const customer = await prisma.customer.findUnique({
    where: { carrierId },
    include: { carrier: { select: { companyName: true, equipment: true } } },
  });
  if (!customer) return null;
  return { customerId: customer.id, dispatchFeePercent: customer.dispatchFeePercent, status: customer.status, rules: rulesOf(customer, customer.carrier) };
}

/** Parse the stored Load.fitWarnings JSON (always an array). */
export function storedWarnings(load) {
  if (!load?.fitWarnings) return [];
  try {
    const v = JSON.parse(load.fitWarnings);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Columns to write for a load that is being saved: fitWarnings (null when there is nothing to warn about or the
 * carrier has no rules) and a cleared acknowledgement when the set of warnings changed.
 */
export async function fitColumns(load, previous = null) {
  const found = await rulesForCarrier(load.carrierId);
  const warnings = found ? checkLoadFit(load, found.rules).warnings : [];
  const data = { fitWarnings: warnings.length ? JSON.stringify(warnings) : null };
  if (previous && fitKey(storedWarnings(previous)) !== fitKey(warnings)) {
    data.fitAckAt = null;
    data.fitAckById = null;
  }
  return data;
}

/** The fit block returned with a load: stored warnings plus who acknowledged them. */
export function fitView(load) {
  const warnings = storedWarnings(load);
  return { warnings, acknowledgedAt: warnings.length ? load.fitAckAt ?? null : null, acknowledgedById: warnings.length ? load.fitAckById ?? null : null };
}
