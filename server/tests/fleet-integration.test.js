import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { reserveSharedSlot } from '../src/services/market/live.js';
import { buildDigest } from '../src/services/email/digest.js';
import { clearTodayCache } from '../src/services/fleet/today.js';
import { routeQueueIdle } from '../src/services/fleet/route.js';

describe('trucks near an open load: carrier rules per truck', () => {
  let A; let B; let ruled; let plain; let load;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    ruled = (await A.agent.post('/api/carriers').send({ companyName: 'Rules Apply Freight', state: 'TX', equipment: 'reefer' })).body.carrier;
    plain = (await A.agent.post('/api/carriers').send({ companyName: 'No Rules Trucking', state: 'TX' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${ruled.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } }).expect(200);
    await A.agent.patch(`/api/fleet/carriers/${plain.id}`).send({ truckStatus: 'available', location: { city: 'Fort Worth', state: 'TX' } }).expect(200);
    await prisma.customer.create({ data: { carrierId: ruled.id, ownerId: A.user.id, minRatePerMile: 3, maxDeadheadMiles: 100 } });
    // An open load (no carrier yet): $500 for 240 mi is about $2.08/mi, and it needs a dry van.
    load = (await A.agent.post('/api/loads').send({ originCity: 'Dallas', originState: 'TX', destCity: 'Houston', destState: 'TX', rateCents: 50000, loadedMiles: 240, equipment: 'dry_van', status: 'planned' })).body.load;
    expect(load?.id).toBeTruthy();
    await routeQueueIdle(); // the Loads page queued its road route
  });

  it('checks the load against each customer truck\'s rules; trucks without rules get none', async () => {
    const res = await A.agent.get(`/api/fleet/near?city=Dallas&state=TX&loadId=${load.id}`);
    expect(res.status).toBe(200);
    expect(res.body.loadId).toBe(load.id);
    const a = res.body.items.find((t) => t.id === ruled.id);
    const b = res.body.items.find((t) => t.id === plain.id);
    expect(a.fit.warnings.map((w) => w.code).sort()).toEqual(['equipment', 'min_rpm']);
    expect(a.fit.walkAwayCents).toBe(72000); // $3.00 x 240 loaded miles
    expect(a.fit.gapCents).toBe(50000 - 72000);
    expect(b.fit).toBeNull();
  });

  it('leaves the list unchanged without a load, and never checks someone else\'s load', async () => {
    const res = await A.agent.get('/api/fleet/near?city=Dallas&state=TX');
    expect(res.status).toBe(200);
    expect(res.body.items.every((t) => t.fit === undefined)).toBe(true);
    expect(res.body.loadId).toBeUndefined();
    expect((await B.agent.get(`/api/fleet/near?city=Dallas&state=TX&loadId=${load.id}`)).status).toBe(404);
  });
});

describe('shared request slots for the free map services', () => {
  const name = `test-${Date.now()}`;
  const value = async () => Number((await prisma.systemSetting.findUnique({ where: { key: `throttle.${name}` } })).value);

  it('hands out one slot per gap across processes and refuses long waits without reserving', async () => {
    expect(await reserveSharedSlot(name, { gapMs: 1000, maxWaitMs: 4000 })).toBe(0);
    const second = await reserveSharedSlot(name, { gapMs: 1000, maxWaitMs: 4000 });
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThanOrEqual(1000);
    const before = await value();
    // The next slot is about two seconds away: a caller that cannot wait that long gets -1 and nothing is reserved.
    expect(await reserveSharedSlot(name, { gapMs: 1000, maxWaitMs: 500 })).toBe(-1);
    expect(await value()).toBe(before);
  });

  it('treats a slot far in the future (the clock was set back) as free', async () => {
    await prisma.systemSetting.update({ where: { key: `throttle.${name}` }, data: { value: String(Date.now() + 3600_000) } });
    expect(await reserveSharedSlot(name, { gapMs: 1000, maxWaitMs: 4000 })).toBe(0);
    expect(await value()).toBeLessThan(Date.now() + 5000);
  });

  it('gives concurrent callers different slots', async () => {
    const other = `${name}-race`;
    const waits = await Promise.all(Array.from({ length: 4 }, () => reserveSharedSlot(other, { gapMs: 200, maxWaitMs: 4000 })));
    const granted = waits.filter((w) => w >= 0).sort((x, y) => x - y);
    // Each granted slot is at least one gap after the previous one (a lost compare-and-set retries or answers busy).
    for (let k = 1; k < granted.length; k++) expect(granted[k] - granted[k - 1]).toBeGreaterThanOrEqual(150);
    expect(granted.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Today board in the morning digest', () => {
  it('adds the urgent load and invoice rows, and does not keep the board it built', async () => {
    const A = await registerUser({ name: 'Digest Dispatcher' });
    await prisma.user.update({ where: { id: A.user.id }, data: { timezone: 'America/Chicago', emailVerifiedAt: new Date() } });
    const user = () => prisma.user.findUnique({ where: { id: A.user.id } });
    clearTodayCache();
    expect(await buildDigest(await user())).toBeNull();
    await prisma.invoice.create({ data: { ownerId: A.user.id, number: 7, billToName: 'Slow Pay Brokerage', lines: '[]', amountCents: 90000, status: 'sent', dueAt: new Date(Date.now() - 2 * 86400000) } });
    const d = await buildDigest(await user());
    expect(d.sections.map((s) => s.key)).toContain('today_board');
    expect(d.text).toContain('Loads and trucks (1 need action now)');
    expect(d.text).toContain('Invoice #7 overdue: Slow Pay Brokerage');
    // The digest's board was not cached: a second invoice written behind the board's back shows up at once.
    await prisma.invoice.create({ data: { ownerId: A.user.id, number: 8, billToName: 'Later Pay LLC', lines: '[]', amountCents: 50000, status: 'sent', dueAt: new Date(Date.now() - 86400000) } });
    const board = (await A.agent.get('/api/today')).body;
    expect(board.items.filter((i) => i.section === 'invoices')).toHaveLength(2);
  });
});
