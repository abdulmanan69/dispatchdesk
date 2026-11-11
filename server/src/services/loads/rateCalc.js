/**
 * Load economics. All money in integer cents, miles as integers.
 *
 *   Rate per mile (loaded)  = rate / loaded miles
 *   All-in rate per mile    = rate / (loaded + deadhead miles)
 *   Fuel cost               = (loaded + deadhead) / mpg * fuel price per gallon
 *   Detention pay           = detention hours * detention rate per hour
 *   Gross revenue           = rate + detention pay
 *   Dispatch fee            = gross * dispatch fee %
 *   Estimated profit        = gross - fuel - other costs          (carrier's operating margin before dispatch fee)
 *   Carrier net             = estimated profit - dispatch fee
 *
 * Inputs that are missing produce null outputs rather than invented numbers.
 */

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
    totalMiles,
    ratePerMile,
    allInRatePerMile,
    deadheadPercent,
    fuelGallons,
    fuelCostCents,
    fuelIncluded: fuelCostCents != null,
    detentionPayCents,
    grossCents,
    dispatchFeeCents,
    otherCostsCents,
    estProfitCents,
    carrierNetCents,
    profitPerMile,
  };
}

/**
 * Attach computed economics to a Load row. The stored road polyline (LoadRoute, 10+ KB) is never part of an API view:
 * the map gets geometry from /api/fleet/routes only. The deprecated Load.routeGeometry column (always null) and an
 * attached load.route are dropped so rows keep their API shape.
 */
export const withCalc = (load) => {
  if (!load) return load;
  const { routeGeometry: _geometry, route: _route, ...rest } = load;
  return { ...rest, calc: calculateLoad(load) };
};
