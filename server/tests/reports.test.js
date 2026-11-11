import { describe, it, expect, beforeAll, vi } from 'vitest';
import { parse as parseCsv } from 'csv-parse/sync';
import { registerUser, prisma, agent } from './helpers.js';
import { calculateLoad } from '../src/services/loads/rateCalc.js';
import { resolveRange, monthBuckets, monthComparison } from '../src/services/reports/range.js';
import { localParts, zonedTimeToUtc } from '../src/lib/timezones.js';

const DAY = 86_400_000;
const MARCH = 'from=2025-03-01&to=2025-03-31';
const fresh = (a, url) => a.get(url).set('Cache-Control', 'no-cache');

let stageId;
async function carrier(ownerId, companyName) {
  stageId ??= (await prisma.pipelineStage.findUnique({ where: { key: 'customer' } })).id;
  return prisma.carrier.create({ data: { ownerId, stageId, companyName, state: 'TX' } });
}
const broker = (ownerId, companyName) => prisma.broker.create({ data: { ownerId, companyName } });
const load = (ownerId, data) => prisma.load.create({
  data: { ownerId, originCity: 'Dallas', originState: 'TX', destCity: 'Fresno', destState: 'CA', loadedMiles: 0, rateCents: 0, status: 'delivered', ...data },
});
let invNo = 5000;
const invoice = (ownerId, data) => prisma.invoice.create({
  data: { ownerId, number: (invNo += 1), kind: 'freight', status: 'sent', billToName: 'Broker', lines: '{"items":[]}', amountCents: 100000, ...data },
});

/** What calculateLoad gives for a load the way reports count it (fee % falls back to the customer's; TONU earns only TONU). */
function expectedFor(l, customerFee) {
  const pct = l.dispatchFeePercent ?? customerFee ?? null;
  const tonu = l.status === 'canceled';
  const basis = tonu ? { ...l, rateCents: l.tonuCents, detentionHours: 0, loadedMiles: 0, deadheadMiles: 0 } : l;
  return calculateLoad({ ...basis, dispatchFeePercent: pct });
}

describe('report date ranges', () => {
  const tz = 'America/Chicago';
  const now = new Date('2026-03-31T15:00:00Z'); // Mar 31, 10:00 in Chicago

  it('resolves presets in the user time zone', () => {
    expect(resolveRange(tz, {}, now)).toMatchObject({ key: 'this_month', from: '2026-03-01', to: '2026-03-31' });
    expect(resolveRange(tz, { range: 'last_month' }, now)).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveRange(tz, { range: 'last_90' }, now)).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
    expect(resolveRange(tz, { range: 'this_year' }, now)).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
    const r = resolveRange(tz, { from: '2025-03-01', to: '2025-03-31' }, now);
    expect(r.key).toBe('custom');
    expect(r.start.toISOString()).toBe('2025-03-01T06:00:00.000Z'); // CST
    expect(r.end.toISOString()).toBe('2025-04-01T05:00:00.000Z'); // CDT after the March change
    // January: last month is December of the year before.
    expect(resolveRange(tz, { range: 'last_month' }, new Date('2026-01-10T18:00:00Z'))).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('rejects bad, reversed and over-long custom ranges', () => {
    expect(() => resolveRange(tz, { from: '2025-03-01' })).toThrow(/start and an end/);
    expect(() => resolveRange(tz, { from: '2025-02-30', to: '2025-03-01' })).toThrow(/YYYY-MM-DD/);
    expect(() => resolveRange(tz, { from: '2025-03-02', to: '2025-03-01' })).toThrow(/after the end/);
    expect(() => resolveRange(tz, { from: '2015-01-01', to: '2025-03-01' })).toThrow(/five years/);
  });

  it('splits a range into calendar months with partial ends', () => {
    const b = monthBuckets(resolveRange(tz, { from: '2025-11-15', to: '2026-01-10' }));
    expect(b.map((x) => x.key)).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(b.map((x) => x.label)).toEqual(['Nov 2025', 'Dec 2025', 'Jan 2026']);
    expect(b[0].start.toISOString()).toBe('2025-11-15T06:00:00.000Z');
    expect(b[1].start.toISOString()).toBe('2025-12-01T06:00:00.000Z');
    expect(b[2].end.toISOString()).toBe('2026-01-11T06:00:00.000Z');
  });

  it('compares this month with last month up to the same day', () => {
    const m = monthComparison(tz, now);
    expect(m.thisMonth).toMatchObject({ from: '2026-03-01', to: '2026-03-31', label: 'March 2026' });
    expect(m.lastMonth).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(m.lastMonthToDate).toMatchObject({ from: '2026-02-01', to: '2026-02-28' }); // Feb has no 31st
    expect(m.lastMonthToDate.end.toISOString()).toBe(m.thisMonth.start.toISOString());
    const mid = monthComparison(tz, new Date('2026-03-10T18:00:00Z'));
    expect(mid.lastMonthToDate.to).toBe('2026-02-10');
  });
});

describe('profit report', () => {
  let A; let B; let c1; let c2; let b1; let b2; const fixtures = [];

  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    c1 = await carrier(A.user.id, 'Alpha Trucking');
    c2 = await carrier(A.user.id, 'Bravo Lines');
    await prisma.customer.create({ data: { carrierId: c2.id, ownerId: A.user.id, dispatchFeePercent: 8 } });
    b1 = await broker(A.user.id, 'Summit Logistics');
    b2 = await broker(A.user.id, '=HYPERLINK("x"), "Quoted, Inc"');
    const mk = async (data) => { const l = await load(A.user.id, data); fixtures.push(l); return l; };
    // In range (March 2025, Chicago): L1-L4 and L8.
    await mk({ carrierId: c1.id, brokerId: b1.id, rateCents: 300000, loadedMiles: 1000, deadheadMiles: 100, detentionHours: 2, detentionRateCents: 5000, dispatchFeePercent: 10, mpg: 6.5, fuelPricePerGallon: 4, otherCostsCents: 5000, deliveryDate: new Date('2025-03-10T18:00:00Z') });
    await mk({ carrierId: c2.id, brokerId: b1.id, destState: 'GA', rateCents: 200000, loadedMiles: 800, status: 'invoiced', pickupDate: new Date('2025-03-15T15:00:00Z') });
    await mk({ carrierId: c1.id, brokerId: b2.id, originState: 'tx', destState: 'ca ', rateCents: 150000, loadedMiles: 500, dispatchFeePercent: 5, status: 'paid', deliveryDate: new Date('2025-03-20T15:00:00Z') });
    await mk({ carrierId: c1.id, brokerId: b1.id, destState: 'OK', rateCents: 280000, loadedMiles: 900, tonuCents: 25000, dispatchFeePercent: 10, status: 'canceled', pickupDate: new Date('2025-03-12T15:00:00Z') });
    await mk({ carrierId: c2.id, brokerId: b2.id, originState: 'OK', destState: 'TX', rateCents: 50000, loadedMiles: 100, deliveryDate: new Date('2025-04-01T04:30:00Z') }); // Mar 31, 23:30 in Chicago
    // Out of the default report.
    await load(A.user.id, { carrierId: c1.id, brokerId: b1.id, rateCents: 100000, loadedMiles: 400, status: 'in_transit', deliveryDate: new Date('2025-03-25T15:00:00Z') });
    await load(A.user.id, { carrierId: c1.id, brokerId: b1.id, rateCents: 999999, loadedMiles: 400, status: 'booked', deliveryDate: new Date('2025-03-25T15:00:00Z') });
    await load(A.user.id, { carrierId: c1.id, brokerId: b1.id, rateCents: 999999, loadedMiles: 400, status: 'canceled', deliveryDate: new Date('2025-03-25T15:00:00Z') });
    await load(A.user.id, { carrierId: c1.id, brokerId: b1.id, rateCents: 90000, loadedMiles: 300, deliveryDate: new Date('2025-04-02T15:00:00Z') });
    await load(A.user.id, { carrierId: c1.id, brokerId: b1.id, rateCents: 70000, loadedMiles: 200, deliveryDate: new Date('2025-03-01T05:30:00Z') }); // Feb 28 in Chicago
    await load(A.user.id, { carrierId: c1.id, rateCents: 12345, loadedMiles: 10 }); // no dates at all
    // Another workspace with loads in the same days, and one pointing at A's broker and carrier.
    const bc = await carrier(B.user.id, 'Bravo Other');
    await load(B.user.id, { carrierId: bc.id, rateCents: 777700, loadedMiles: 700, dispatchFeePercent: 10, deliveryDate: new Date('2025-03-10T18:00:00Z') });
    await load(B.user.id, { carrierId: c1.id, brokerId: b1.id, rateCents: 555500, loadedMiles: 500, deliveryDate: new Date('2025-03-11T18:00:00Z') });
  });

  it('sums gross, fee, costs, miles and RPM like calculateLoad, by delivery date in the user time zone', async () => {
    const res = await fresh(A.agent, `/api/reports/profit?groupBy=carrier&${MARCH}`);
    expect(res.status).toBe(200);
    expect(res.body.range).toMatchObject({ key: 'custom', from: '2025-03-01', to: '2025-03-31', timezone: 'America/Chicago' });
    const t = res.body.totals;
    expect(t.loads).toBe(5);
    // Hand-checked: L1 310,000 (300,000 + 2 h x $50), L2 200,000, L3 150,000, L4 TONU 25,000, L8 50,000.
    expect(t.grossCents).toBe(735000);
    expect(t.feeCents).toBe(31000 + 16000 + 7500 + 2500 + 4000); // L2 and L8 use the customer's 8 %
    expect(t.fuelCents).toBe(67692); // 1,100 mi / 6.5 mpg x $4.00
    expect(t.profitCents).toBe(735000 - 67692 - 5000);
    expect(t.loadedMiles).toBe(2400);
    expect(t.totalMiles).toBe(2500);
    expect(t.ratePerMile).toBe(2.92); // $7,000 linehaul / 2,400 loaded mi
    expect(t.allInRatePerMile).toBe(2.8);
    expect(t.tonuLoads).toBe(1);
    expect(t.fuelKnownLoads).toBe(1);
    expect(t.feeMissingLoads).toBe(0);
    expect(t.avgGrossCents).toBe(147000);
    expect(res.body.undatedLoads).toBe(1);

    // The SQL matches calculateLoad load by load.
    const calc = fixtures.map((l) => expectedFor(l, l.carrierId === c2.id ? 8 : null));
    const sum = (k) => calc.reduce((s, c) => s + (c[k] ?? 0), 0);
    expect(t.grossCents).toBe(sum('grossCents'));
    expect(t.feeCents).toBe(sum('dispatchFeeCents'));
    expect(t.profitCents).toBe(sum('estProfitCents'));
    expect(t.carrierNetCents).toBe(sum('carrierNetCents'));

    expect(res.body.rows.map((r) => [r.label, r.loads, r.grossCents])).toEqual([['Alpha Trucking', 3, 485000], ['Bravo Lines', 2, 250000]]);
    expect(res.body.rows[0].id).toBe(c1.id);
    expect(res.body.others).toBeNull();
  });

  it('groups by broker and by lane (states normalized)', async () => {
    const byBroker = await fresh(A.agent, `/api/reports/profit?groupBy=broker&${MARCH}`);
    expect(byBroker.body.rows.map((r) => [r.id, r.grossCents])).toEqual([[b1.id, 535000], [b2.id, 200000]]);
    const byLane = await fresh(A.agent, `/api/reports/profit?groupBy=lane&${MARCH}`);
    expect(byLane.body.rows.map((r) => [r.label, r.loads, r.grossCents])).toEqual([
      ['TX → CA', 2, 460000], ['TX → GA', 1, 200000], ['OK → TX', 1, 50000], ['TX → OK', 1, 25000],
    ]);
    const lane = byLane.body.rows[0];
    expect(lane.ratePerMile).toBe(3); // $4,500 / 1,500 mi
    expect(lane.allInRatePerMile).toBe(2.81); // $4,500 / 1,600 mi
  });

  it('can include loads in transit and groups by month with empty months', async () => {
    const withTransit = await fresh(A.agent, `/api/reports/profit?${MARCH}&inTransit=true`);
    expect(withTransit.body.inTransit).toBe(true);
    expect(withTransit.body.totals.loads).toBe(6);
    expect(withTransit.body.totals.grossCents).toBe(835000);
    const months = await fresh(A.agent, '/api/reports/profit?groupBy=month&from=2025-01-01&to=2025-04-30');
    expect(months.body.rows.map((r) => [r.key, r.label, r.loads, r.grossCents])).toEqual([
      ['2025-01', 'Jan 2025', 0, 0], ['2025-02', 'Feb 2025', 1, 70000], ['2025-03', 'Mar 2025', 5, 735000], ['2025-04', 'Apr 2025', 1, 90000],
    ]);
    expect(months.body.rows[0].ratePerMile).toBeNull();
    expect(months.body.totals.grossCents).toBe(895000);
    const one = await fresh(A.agent, `/api/reports/profit?groupBy=month&${MARCH}`);
    expect(one.body.rows.map((r) => [r.key, r.loads, r.grossCents])).toEqual([['2025-03', 5, 735000]]);
  });

  it('never includes another workspace, and validates input', async () => {
    const b = await fresh(B.agent, `/api/reports/profit?${MARCH}`);
    expect(b.body.totals).toMatchObject({ loads: 2, grossCents: 777700 + 555500 });
    // B's load on A's carrier and broker counts for B only, and A's carrier name is not shown to B.
    expect(b.body.totals.feeCents).toBe(77770);
    const bCarriers = await fresh(B.agent, `/api/reports/profit?groupBy=carrier&${MARCH}`);
    expect(bCarriers.body.rows.map((r) => [r.label, r.id])).toEqual([['Bravo Other', expect.any(String)], ['Unknown carrier', null]]);
    const a = await fresh(A.agent, `/api/reports/profit?groupBy=broker&${MARCH}&scope=team`);
    expect(a.body.scope).toBe('mine'); // no team: team scope falls back
    expect(a.body.totals.grossCents).toBe(735000);
    expect((await A.agent.get('/api/reports/profit?groupBy=shipper')).status).toBe(400);
    expect((await A.agent.get('/api/reports/profit?from=2025-03-05&to=2025-03-01')).status).toBe(400);
    expect((await (await agent()).get('/api/reports/profit')).status).toBe(401);
  });

  it('exports CSV with quoting and the spreadsheet-formula guard', async () => {
    const res = await fresh(A.agent, `/api/reports/profit.csv?groupBy=broker&${MARCH}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('profit-by-broker-2025-03-01-to-2025-03-31.csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('"\'=HYPERLINK(""x""), ""Quoted, Inc"""');
    const rows = parseCsv(res.text.slice(1));
    expect(rows[0].slice(0, 4)).toEqual(['Broker', 'Loads', 'Gross', 'Linehaul']);
    expect(rows[1].slice(0, 3)).toEqual(['Summit Logistics', '3', '5350.00']);
    expect(rows[2][0]).toBe('\'=HYPERLINK("x"), "Quoted, Inc"');
    expect(rows.at(-1).slice(0, 3)).toEqual(['Total', '5', '7350.00']);
    expect(rows).toHaveLength(4);
  });

  it('caches per user for a short time and recomputes on a no-cache refresh', async () => {
    const url = '/api/reports/profit?groupBy=carrier&from=2025-06-01&to=2025-06-30';
    expect((await A.agent.get(url)).body.totals.loads).toBe(0);
    await load(A.user.id, { carrierId: c1.id, rateCents: 10000, loadedMiles: 10, deliveryDate: new Date('2025-06-10T18:00:00Z') });
    expect((await A.agent.get(url)).body.totals.loads).toBe(0);
    expect((await fresh(A.agent, url)).body.totals.loads).toBe(1);
    expect((await B.agent.get(url)).body.totals.loads).toBe(0); // not A's cached numbers
  });
});

describe('profit report: top 50 and others', () => {
  it('returns the 50 largest groups and sums the rest into one row', async () => {
    const U = await registerUser();
    const states = ['AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL'];
    const data = [];
    for (let i = 0; i < 53; i++) {
      data.push({
        ownerId: U.user.id, originCity: 'X', originState: states[i % 8], destCity: 'Y', destState: states[Math.floor(i / 8)],
        rateCents: 100000 + i * 1000, loadedMiles: 100, status: 'delivered', deliveryDate: new Date('2025-05-10T18:00:00Z'),
      });
    }
    await prisma.load.createMany({ data });
    const res = await fresh(U.agent, '/api/reports/profit?groupBy=lane&from=2025-05-01&to=2025-05-31');
    expect(res.body.groups).toBe(53);
    expect(res.body.rows).toHaveLength(50);
    expect(res.body.rows[0].grossCents).toBe(152000);
    expect(res.body.others).toMatchObject({ key: 'others', groups: 3, loads: 3, grossCents: 100000 + 101000 + 102000, loadedMiles: 300 });
    expect(res.body.others.ratePerMile).toBe(10.1);
    const shown = res.body.rows.reduce((s, r) => s + r.grossCents, 0);
    expect(shown + res.body.others.grossCents).toBe(res.body.totals.grossCents);
  });
});

describe('profit report: team scope', () => {
  it('includes teammates only with team rights and scope=team', async () => {
    const lead = await registerUser();
    const member = await registerUser();
    const outsider = await registerUser();
    const team = await prisma.team.create({ data: { name: 'Report Co', ownerId: lead.user.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: lead.user.id, role: 'owner' } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, role: 'dispatcher' } });
    const at = new Date('2025-07-10T18:00:00Z');
    await load(lead.user.id, { rateCents: 100000, loadedMiles: 500, deliveryDate: at });
    await load(member.user.id, { rateCents: 200000, loadedMiles: 500, deliveryDate: at });
    await load(outsider.user.id, { rateCents: 400000, loadedMiles: 500, deliveryDate: at });
    const range = 'from=2025-07-01&to=2025-07-31';

    const team1 = await fresh(lead.agent, `/api/reports/profit?${range}&scope=team`);
    expect(team1.body).toMatchObject({ scope: 'team', canViewTeam: true });
    expect(team1.body.totals.grossCents).toBe(300000);
    expect((await fresh(lead.agent, `/api/reports/profit?${range}`)).body.totals.grossCents).toBe(100000);
    // A dispatcher without "view team data" gets their own numbers.
    const m = await fresh(member.agent, `/api/reports/profit?${range}&scope=team`);
    expect(m.body).toMatchObject({ scope: 'mine', canViewTeam: false });
    expect(m.body.totals.grossCents).toBe(200000);
    const sum = await fresh(lead.agent, '/api/reports/summary?scope=team');
    expect(sum.body.scope).toBe('team');
  });
});

describe('summary tiles', () => {
  it('compares this month with last month up to the same day', async () => {
    const U = await registerUser();
    const tz = 'America/Chicago';
    const p = localParts(tz, new Date());
    const thisNoon = zonedTimeToUtc(tz, p.year, p.month, p.day, 12, 0, 0);
    const lastFirst = zonedTimeToUtc(tz, p.year, p.month - 1, 1, 12, 0, 0);
    await load(U.user.id, { rateCents: 300000, loadedMiles: 1000, dispatchFeePercent: 10, deliveryDate: thisNoon });
    await load(U.user.id, { rateCents: 100000, loadedMiles: 500, dispatchFeePercent: 10, deliveryDate: thisNoon });
    await load(U.user.id, { rateCents: 200000, loadedMiles: 1000, dispatchFeePercent: 10, deliveryDate: lastFirst });
    const res = await fresh(U.agent, '/api/reports/summary');
    expect(res.status).toBe(200);
    expect(res.body.thisMonth).toMatchObject({ loads: 2, grossCents: 400000, feeCents: 40000, ratePerMile: 2.67 });
    expect(res.body.lastMonth).toMatchObject({ loads: 1, grossCents: 200000 });
    expect(res.body.lastMonthToDate).toMatchObject({ loads: 1, grossCents: 200000, ratePerMile: 2 });
    expect(res.body.change).toMatchObject({ grossCents: 100, feeCents: 100, loads: 100, ratePerMile: 33.5 });
    const empty = await fresh((await registerUser()).agent, '/api/reports/summary');
    expect(empty.body.change.grossCents).toBeNull();
    expect(empty.body.thisMonth.loads).toBe(0);
  });
});

describe('broker payments', () => {
  let A; let B; let b1; let b2; const now = Date.now();
  const ago = (days) => new Date(now - days * DAY);

  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    b1 = await broker(A.user.id, 'Prompt Pay Freight');
    b2 = await broker(A.user.id, 'New Broker LLC');
    const a = A.user.id;
    // Paid: 20 days (on time), 40 days from sentAt (no issuedAt; late), 30 days (paid on the due day: not late).
    await invoice(a, { brokerId: b1.id, status: 'paid', paidCents: 100000, issuedAt: new Date('2025-03-01T12:00:00Z'), dueAt: new Date('2025-03-31T12:00:00Z'), paidAt: new Date('2025-03-21T12:00:00Z') });
    await invoice(a, { brokerId: b1.id, status: 'paid', paidCents: 100000, sentAt: new Date('2025-03-05T12:00:00Z'), dueAt: new Date('2025-04-04T12:00:00Z'), paidAt: new Date('2025-04-14T12:00:00Z') });
    await invoice(a, { brokerId: b1.id, status: 'paid', paidCents: 100000, issuedAt: new Date('2025-04-01T12:00:00Z'), dueAt: new Date('2025-05-01T06:00:00Z'), paidAt: new Date('2025-05-01T12:00:00Z') });
    // Open: one past due, one partly paid and not due yet.
    await invoice(a, { brokerId: b1.id, status: 'sent', amountCents: 100000, issuedAt: ago(50), dueAt: ago(20) });
    await invoice(a, { brokerId: b1.id, status: 'partial', amountCents: 80000, paidCents: 30000, issuedAt: ago(10), dueAt: new Date(now + 20 * DAY) });
    // Never counted: drafts, void, dispatch-fee invoices, and another workspace's invoice to A's broker.
    await invoice(a, { brokerId: b1.id, status: 'draft', amountCents: 999999 });
    await invoice(a, { brokerId: b1.id, status: 'void', amountCents: 999999, issuedAt: ago(90), dueAt: ago(60) });
    await invoice(a, { brokerId: b1.id, kind: 'dispatch_fee', status: 'sent', amountCents: 999999, issuedAt: ago(90), dueAt: ago(60) });
    await invoice(B.user.id, { brokerId: b1.id, status: 'paid', amountCents: 999999, paidCents: 999999, issuedAt: new Date('2025-01-01T12:00:00Z'), dueAt: new Date('2025-01-02T12:00:00Z'), paidAt: new Date('2025-12-01T12:00:00Z') });
    await invoice(B.user.id, { brokerId: b1.id, status: 'sent', amountCents: 999999, issuedAt: ago(200), dueAt: ago(170) });
  });

  const expected = {
    invoices: 5, paidInvoices: 3, measuredInvoices: 3, avgDaysToPay: 30, medianDaysToPay: 30, paidLate: 1,
    openInvoices: 2, openCents: 150000, pastDueInvoices: 1, pastDueCents: 100000, oldestOpenDays: 50,
  };

  it('reports days to pay, late payments, open and past-due balances per broker', async () => {
    const res = await fresh(A.agent, '/api/reports/brokers/payments');
    expect(res.status).toBe(200);
    expect(res.body.basis).toBe('own_invoices');
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ brokerId: b1.id, name: 'Prompt Pay Freight', known: true, ...expected });
    expect(new Date(res.body.rows[0].lastPaidAt).toISOString()).toBe('2025-05-01T12:00:00.000Z');
    // The other workspace sees only its own two invoices.
    const other = await fresh(B.agent, '/api/reports/brokers/payments');
    expect(other.body.rows[0]).toMatchObject({ name: null, known: false, invoices: 2, paidInvoices: 1, pastDueCents: 999999 });
  });

  it('adds the stats and the last 10 invoices to the broker page', async () => {
    const res = await A.agent.get(`/api/brokers/${b1.id}`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toMatchObject(expected);
    const recent = res.body.payments.recent;
    expect(recent).toHaveLength(5);
    expect(recent.map((i) => [i.status, i.daysToPay, i.late, i.pastDue])).toEqual([
      ['partial', null, false, false], ['sent', null, false, true], ['paid', 30, false, false], ['paid', 20, false, false], ['paid', 40, true, false],
    ]);
    expect(recent[1].daysOpen).toBe(50);
    expect(recent[0].balanceCents).toBe(50000);

    const none = await A.agent.get(`/api/brokers/${b2.id}`);
    expect(none.body.payments).toMatchObject({ invoices: 0, measuredInvoices: 0, avgDaysToPay: null, medianDaysToPay: null, openCents: 0, recent: [] });
    expect((await B.agent.get(`/api/brokers/${b1.id}`)).status).toBe(404);
  });

  it('adds a "pays in" summary to the broker list with one batched query', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw');
    const res = await A.agent.get('/api/brokers');
    const invoiceQueries = spy.mock.calls.filter(([sql]) => /FROM Invoice/.test(Array.isArray(sql) ? sql.join('') : String(sql?.sql ?? sql?.strings?.join('') ?? ''))).length;
    spy.mockRestore();
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.items.map((b) => [b.id, b.payments]));
    expect(byId[b1.id]).toEqual({ avgDaysToPay: 30, measuredInvoices: 3, pastDueInvoices: 1, pastDueCents: 100000, openCents: 150000 });
    expect(byId[b2.id]).toEqual({ avgDaysToPay: null, measuredInvoices: 0, pastDueInvoices: 0, pastDueCents: 0, openCents: 0 });
    expect(invoiceQueries).toBe(1);
  });
});
