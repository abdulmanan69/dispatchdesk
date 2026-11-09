// Client mirror of server/src/services/loads/rateCalc.js — keep the formulas identical.
const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

export function calculateLoad(input = {}) {
  const rateCents = n(input.rateCents) ?? 0;
  const loadedMiles = n(input.loadedMiles) ?? 0;
  const deadheadMiles = n(input.deadheadMiles) ?? 0;
  const detentionHours = n(input.detentionHours) ?? 0;
  const detentionRateCents = n(input.detentionRateCents) ?? 0;
  const otherCostsCents = n(input.otherCostsCents) ?? 0;
  const fuelPrice = n(input.fuelPricePerGallon);
  const mpg = n(input.mpg);
  const feePct = n(input.dispatchFeePercent);

  const totalMiles = loadedMiles + deadheadMiles;
  const ratePerMile = loadedMiles > 0 ? round2(rateCents / 100 / loadedMiles) : null;
  const allInRatePerMile = totalMiles > 0 ? round2(rateCents / 100 / totalMiles) : null;
  const deadheadPercent = totalMiles > 0 ? round2((deadheadMiles / totalMiles) * 100) : null;
  const fuelGallons = mpg && mpg > 0 ? round2(totalMiles / mpg) : null;
  const fuelCostCents = fuelGallons != null && fuelPrice != null ? Math.round((totalMiles / mpg) * fuelPrice * 100) : null;
  const detentionPayCents = Math.round(detentionHours * detentionRateCents);
  const grossCents = rateCents + detentionPayCents;
  const dispatchFeeCents = feePct != null ? Math.round((grossCents * feePct) / 100) : null;
  const estProfitCents = grossCents - (fuelCostCents ?? 0) - otherCostsCents;
  const carrierNetCents = estProfitCents - (dispatchFeeCents ?? 0);
  const profitPerMile = totalMiles > 0 ? round2(estProfitCents / 100 / totalMiles) : null;
  return {
    totalMiles, ratePerMile, allInRatePerMile, deadheadPercent, fuelGallons, fuelCostCents, fuelIncluded: fuelCostCents != null,
    detentionPayCents, grossCents, dispatchFeeCents, otherCostsCents, estProfitCents, carrierNetCents, profitPerMile,
  };
}

/** Dollars string from a form → integer cents (null when blank). */
export const toCents = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));
/** Integer cents → dollars string for a form input. */
export const fromCents = (c) => (c == null ? '' : String(c / 100));

export const LOAD_STATUSES = ['planned', 'booked', 'in_transit', 'delivered', 'invoiced', 'paid', 'canceled'];
export const LOAD_STATUS_COLOR = { planned: 'gray', booked: 'blue', in_transit: 'violet', delivered: 'brand', invoiced: 'amber', paid: 'green', canceled: 'red' };
