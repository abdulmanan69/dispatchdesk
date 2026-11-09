import { calculateLoad } from '../loads/rateCalc.js';

/**
 * Dollar-denominated view of the canonical load calculator (services/loads/rateCalc.js),
 * used by the AI load-analysis tool so both features share one formula source.
 * RPM = total load rate / loaded miles. All-in RPM includes deadhead miles.
 */
const cents = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 100));
const dollars = (c) => (c == null ? null : Math.round(c) / 100);

export function analyzeLoadNumbers(input) {
  const c = calculateLoad({
    rateCents: cents(input.rate),
    loadedMiles: input.loadedMiles,
    deadheadMiles: input.deadheadMiles,
    detentionHours: input.detentionHours,
    detentionRateCents: cents(input.detentionRate),
    otherCostsCents: cents(input.otherCosts),
    fuelPricePerGallon: input.fuelPricePerGallon || null,
    mpg: input.mpg || null,
    dispatchFeePercent: input.dispatchFeePercent ?? 0,
  });
  const totalMiles = c.totalMiles;
  const net = c.carrierNetCents;
  return {
    rate: dollars(cents(input.rate)),
    loadedMiles: Number(input.loadedMiles) || 0,
    deadheadMiles: Number(input.deadheadMiles) || 0,
    totalMiles,
    ratePerMile: c.ratePerMile,
    allInRatePerMile: c.allInRatePerMile,
    detentionPay: dollars(c.detentionPayCents),
    grossRevenue: dollars(c.grossCents),
    fuelCost: dollars(c.fuelCostCents),
    otherCosts: dollars(c.otherCostsCents),
    dispatchFee: dollars(c.dispatchFeeCents ?? 0),
    estimatedNet: dollars(net),
    netPerTotalMile: totalMiles > 0 ? Math.round((net / 100 / totalMiles) * 100) / 100 : null,
    deadheadPercent: c.deadheadPercent ?? 0,
  };
}
