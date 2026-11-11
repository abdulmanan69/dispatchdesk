import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as server from '../src/services/loads/fit.js';
import { detentionSummary } from '../src/services/loads/detention.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MARKER = '// ---- SHARED (identical in client/src/components/dispatch/fit.js) ----';
const shared = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const i = text.indexOf(MARKER);
  expect(i).toBeGreaterThan(-1);
  return text.slice(i);
};

describe('load check card: client mirror parity', () => {
  it('keeps the shared part of the client mirror identical to the server module', async () => {
    const serverFile = path.resolve(here, '../src/services/loads/fit.js');
    const clientFile = path.resolve(here, '../../client/src/components/dispatch/fit.js');
    expect(shared(clientFile)).toBe(shared(serverFile));
    // And both evaluate to the same results.
    const client = await import(clientFile);
    const load = { rateCents: 185000, loadedMiles: 1000, deadheadMiles: 150, weightLbs: 46000, equipment: 'reefer', originState: 'TX', destState: 'FL', deliveryDate: '2026-11-14', commodity: 'Frozen food, TWIC required', notes: 'Team drivers required. 53 ft trailer' };
    const rules = { minRatePerMile: 2.1, maxDeadheadMiles: 100, maxWeightLbs: 44000, trailerLengthFt: 48, avoidStates: 'fl, ga', homeTimeDays: 'Sat-Sun', costPerMileCents: 160, equipment: 'dry_van', carrierName: 'Blue Line' };
    expect(client.checkLoadFit(load, rules)).toEqual(server.checkLoadFit(load, rules));
    expect(client.rulesSummary(rules)).toEqual(server.rulesSummary(rules));
  });
});

describe('checkLoadFit', () => {
  const rules = { minRatePerMile: 2.1, maxDeadheadMiles: 100, maxWeightLbs: 44000, trailerLengthFt: 48, avoidStates: 'FL,GA', homeTimeDays: 'Sat,Sun', costPerMileCents: 160, minHaulMiles: 300, maxHaulMiles: 900, equipment: 'dry_van,reefer', carrierName: 'Blue Line' };

  it('writes plain warnings for each broken rule', () => {
    const { warnings } = server.checkLoadFit({
      rateCents: 185000, loadedMiles: 1000, deadheadMiles: 150, weightLbs: 46000, equipment: 'flatbed', originState: 'TX', destState: 'FL',
      deliveryDate: '2026-11-14', commodity: 'Steel coils, hazmat placarded', notes: 'TWIC required; team drivers required; 53 ft trailer',
    }, rules);
    const byCode = Object.fromEntries(warnings.map((w) => [w.code, w.message]));
    expect(byCode.min_rpm).toBe("$1.85/mi is below Blue Line's $2.10 floor");
    expect(byCode.deadhead).toBe('Deadhead 150 mi is over the 100 mi max');
    expect(byCode.weight).toBe('46,000 lb exceeds the 44,000 lb max');
    expect(byCode.trailer).toBe('Needs a 53 ft trailer; the carrier runs 48 ft');
    expect(byCode.equipment).toMatch(/Load needs flatbed; the carrier runs dry van, reefer/);
    expect(byCode.hazmat).toBeTruthy();
    expect(byCode.twic).toBeTruthy();
    expect(byCode.team).toBeTruthy();
    expect(byCode.avoid_state).toBe('FL is on the avoid list');
    expect(byCode.home_time).toBe('Saturday delivery conflicts with home time (Sat, Sun)');
    expect(byCode.long_haul).toBe('1,000 mi haul is longer than the 900 mi maximum');
    expect(byCode.below_cost).toBeUndefined(); // $1,850 >= 1,150 mi x $1.60 = $1,840
  });

  it('returns nothing to warn about when the load fits, and ignores rules that are not set', () => {
    expect(server.checkLoadFit({ rateCents: 250000, loadedMiles: 800, deadheadMiles: 50, weightLbs: 40000, equipment: 'reefer', originState: 'TX', destState: 'OK', deliveryDate: '2026-11-12' }, rules).warnings).toEqual([]);
    expect(server.checkLoadFit({ rateCents: 100, loadedMiles: 1000, weightLbs: 90000, originState: 'FL' }, {}).warnings).toEqual([]);
    expect(server.checkLoadFit({ notes: 'Non-hazmat freight' }, { hazmat: false }).warnings).toEqual([]);
  });

  it('computes the walk-away rate from the higher of the RPM floor and the cost floor', () => {
    const n1 = server.negotiationNumbers({ rateCents: 200000, loadedMiles: 1000, deadheadMiles: 200 }, { minRatePerMile: 2.1, costPerMileCents: 160 });
    expect(n1).toMatchObject({ floorFromRpmCents: 210000, floorFromCostCents: 192000, walkAwayCents: 210000, walkAwayBasis: 'min_rpm', gapCents: -10000, ratePerMile: 2, allInRatePerMile: 1.67 });
    const n2 = server.negotiationNumbers({ rateCents: 200000, loadedMiles: 500, deadheadMiles: 400 }, { minRatePerMile: 2, costPerMileCents: 180 });
    expect(n2).toMatchObject({ floorFromRpmCents: 100000, floorFromCostCents: 162000, walkAwayCents: 162000, walkAwayBasis: 'cost', walkAwayRatePerMile: 3.24 });
    expect(server.negotiationNumbers({ rateCents: 1000, loadedMiles: 10 }, {}).walkAwayCents).toBeNull();
  });

  it('reads home-time days, weekdays in the facility time zone, and summarizes rules', () => {
    expect(server.homeDays('Fri-Sun')).toEqual(['Fri', 'Sat', 'Sun']);
    expect(server.homeDays('saturday sunday')).toEqual(['Sat', 'Sun']);
    expect(server.weekdayOf('2026-11-14')).toBe('Sat');
    // 03:00 UTC on Sunday is still Saturday evening in Chicago.
    expect(server.weekdayOf('2026-11-15T03:00:00Z', 'America/Chicago')).toBe('Sat');
    expect(server.rulesSummary({ minRatePerMile: 2.5, avoidStates: 'fl', hazmat: true, costPerMileCents: 145 })).toEqual(['Min $2.50/mi', 'Hazmat', 'Avoids FL', 'Cost $1.45/mi']);
    expect(server.fitKey([{ code: 'b' }, { code: 'a' }])).toBe('a,b');
  });
});

describe('detention clock', () => {
  const H = 3_600_000;
  const t0 = new Date('2026-11-12T13:00:00Z'); // 07:00 Central
  const at = (h) => new Date(t0.getTime() + h * H);

  it('starts at the appointment when the truck is early, and bills after free time', () => {
    const load = { freeTimeHours: 2, detentionRateCents: 5000, pickupWindowStart: at(1), status: 'in_transit' };
    const events = [{ type: 'arrived_pickup', at: at(0), source: 'driver_link' }, { type: 'departed_pickup', at: at(4.5), source: 'dispatcher' }];
    const d = detentionSummary(load, events, at(10));
    const p = d.stops[0];
    expect(p.clockStart).toEqual(at(1));
    expect(p.freeEndsAt).toEqual(at(3));
    expect(p.billableHours).toBe(1.5);
    expect(p.amountCents).toBe(7500);
    expect(p.state).toBe('departed');
    expect(d.billableHours).toBe(1.5);
    expect(d.amountCents).toBe(7500);
  });

  it('runs while the truck is still on site and stays at zero inside free time', () => {
    const load = { freeTimeHours: 2, detentionRateCents: 6000, status: 'in_transit' };
    const running = detentionSummary(load, [{ type: 'arrived_delivery', at: at(0) }], at(3.25));
    expect(running.stops[1]).toMatchObject({ state: 'detention', running: true, billableHours: 1.25, amountCents: 7500 });
    expect(running.running).toBe(true);
    const free = detentionSummary(load, [{ type: 'arrived_delivery', at: at(0) }], at(1));
    expect(free.stops[1]).toMatchObject({ state: 'free_time', billableHours: 0 });
    expect(detentionSummary(load, [], at(1)).stops.every((s) => s.state === 'waiting')).toBe(true);
  });
});
