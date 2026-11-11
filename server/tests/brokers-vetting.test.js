import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { computeFlags, editDistance, isPoBox, baseDomain, domainOf, topLevel } from '../src/services/brokers/flags.js';
import { setFmcsaFetch, snapshotFrom } from '../src/services/brokers/fmcsa.js';
import { snapshotChanges, runWatchlist } from '../src/services/brokers/watchlist.js';

const NOW = new Date('2026-11-10T08:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/** Census rows keyed by MC docket; the fake fetch answers SODA $where queries from it. */
const census = new Map();
let calls = 0;
function fakeFetch(url) {
  calls += 1;
  const where = decodeURIComponent(new URL(String(url)).searchParams.get('$where') || '');
  const rows = [...census.values()].filter((r) => where.includes(`'${r.docket1}'`) || where.includes(`'${r.dot_number}'`));
  return Promise.resolve({ ok: true, status: 200, json: async () => rows });
}

beforeAll(() => setFmcsaFetch(fakeFetch));
afterAll(() => setFmcsaFetch(null));

describe('broker flags (pure)', () => {
  const snap = (over = {}) => ({
    found: true, checkedAt: NOW.toISOString(), dot: '1111111', mc: '322572', registeredBroker: true, usdotStatus: 'active',
    phones: ['8005551234'], email: 'ops@summitlogistics.com', address: { street: '1 Main St', city: 'Dallas', state: 'TX', zip: '75201' },
    addedAt: daysAgo(4000).toISOString(), ...over,
  });

  it('measures edit distance and recognizes free mail, lookalike domains and P.O. boxes', () => {
    expect(editDistance('summitlogistics.com', 'surnmitlogistics.com')).toBe(2);
    expect(editDistance('abcd', 'abdc')).toBe(1);
    expect(baseDomain('ops.summit.com')).toBe('summit.com');
    expect(baseDomain('summit.co.uk')).toBe('summit.co.uk');
    expect(domainOf('A@Summit.COM')).toBe('summit.com');
    expect(isPoBox('P.O. Box 120')).toBe(true);
    expect(isPoBox('120 Boxwood Ave')).toBe(false);
  });

  it('flags only from data and names the source', () => {
    expect(computeFlags(snap(), { now: NOW })).toEqual([]);
    const flags = computeFlags(snap({ usdotStatus: 'inactive', registeredBroker: false, addedAt: daysAgo(40).toISOString(), address: { street: 'PO Box 9', city: 'Dallas', state: 'TX' } }), {
      now: NOW, rateCon: { phone: '(972) 555-0000', email: 'dispatch@gmail.com' },
    });
    const codes = flags.map((f) => f.code);
    expect(codes).toEqual(['usdot_inactive', 'not_broker', 'new_registration', 'po_box', 'rate_con_phone', 'free_mail']);
    expect(flags.find((f) => f.code === 'rate_con_phone').message).toMatch(/Call back on \(800\) 555-1234/);
    expect(flags.every((f) => f.source && f.level)).toBe(true);
    expect(topLevel(flags)).toBe('red');
  });

  it('accepts any FMCSA-listed or saved phone, and catches lookalike email domains', () => {
    const s = snap({ phones: ['8005551234', '2145550100'] });
    expect(computeFlags(s, { now: NOW, rateCon: { phone: '214-555-0100' } })).toEqual([]);
    expect(computeFlags(s, { now: NOW, rateCon: { phone: '9725550000' }, known: { phones: ['(972) 555-0000'] } })).toEqual([]);
    const look = computeFlags(s, { now: NOW, rateCon: { email: 'ops@surnmitlogistics.com' } });
    expect(look.map((f) => [f.code, f.level])).toEqual([['lookalike_domain', 'red']]);
    expect(computeFlags(s, { now: NOW, rateCon: { email: 'ap@totally-different.com' } }).map((f) => f.level)).toEqual(['info']);
    expect(computeFlags(s, { now: NOW, rateCon: { email: 'billing@ops.summitlogistics.com' } })).toEqual([]);
  });

  it('reports contact changes against the previous snapshot and a missing record without claiming "no authority"', () => {
    const prev = snap({ checkedAt: daysAgo(30).toISOString(), phones: ['8005550000'] });
    const flags = computeFlags(snap(), { now: NOW, previous: prev });
    expect(flags.map((f) => f.code)).toEqual(['contact_changed']);
    const missing = computeFlags({ found: false, query: { mc: '999' }, checkedAt: NOW.toISOString() }, { now: NOW });
    expect(missing[0]).toMatchObject({ code: 'not_found', level: 'amber' });
    expect(missing[0].message).not.toMatch(/no authority/i);
    expect(snapshotChanges(prev, snap()).map((c) => c.field)).toEqual(['phones']);
    expect(snapshotChanges(null, snap())).toEqual([]);
  });

  it('maps census and QCMobile records into a snapshot', () => {
    const s = snapshotFrom({ dot_number: '0001234', legal_name: 'Summit Logistics LLC', carship: 'B', status_code: 'A', docket1prefix: 'MC', docket1: '322572', phone: '(800) 555-1234', email_address: 'OPS@SUMMIT.COM', add_date: '20150101', phy_street: '1 Main St' },
      { qc: { brokerAuthorityStatus: 'I', bondInsuranceOnFile: 'N', bondInsuranceRequired: 'Y', allowedToOperate: 'Y' }, checkedAt: NOW });
    expect(s).toMatchObject({ found: true, dot: '1234', mc: '322572', registeredBroker: true, usdotStatus: 'active', phones: ['8005551234'], email: 'ops@summit.com', brokerAuthority: 'inactive', bondOnFile: false, bondRequired: true, qc: true });
    const flags = computeFlags(s, { now: NOW });
    expect(flags.map((f) => f.code)).toEqual(['broker_authority', 'no_bond']);
  });
});

describe('broker vetting API', () => {
  let A;
  let B;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    census.set('322572', { dot_number: '2222222', legal_name: 'Summit Logistics LLC', carship: 'B', status_code: 'A', docket1prefix: 'MC', docket1: '322572', phone: '8005551234', email_address: 'ops@summitlogistics.com', add_date: ymd(daysAgo(3000)), phy_street: '1 Main St', phy_city: 'Dallas', phy_state: 'TX', phy_zip: '75201' });
    census.set('777001', { dot_number: '3333333', legal_name: 'Fresh Start Brokerage', carship: 'C', status_code: 'A', docket1prefix: 'MC', docket1: '777001', phone: '5125550000', add_date: ymd(new Date(Date.now() - 20 * 86400000)), phy_street: 'PO Box 77' });
  });

  it('verifies an MC for the rate-con flow and compares the rate-con contact block', async () => {
    const res = await A.agent.get('/api/brokers/verify?mc=MC-322572&phone=(972)%20555-0000&email=dispatch@gmail.com');
    expect(res.status).toBe(200);
    expect(res.body.vetting.snapshot).toMatchObject({ found: true, legalName: 'Summit Logistics LLC', registeredBroker: true });
    expect(res.body.vetting.flags.map((f) => f.code)).toEqual(['rate_con_phone', 'free_mail']);
    expect(res.body.vetting.qcConfigured).toBe(false);
    expect((await A.agent.get('/api/brokers/verify')).status).toBe(400);
    // Parsing now finds the cached snapshot instead of "pending".
    const parsed = await A.agent.post('/api/loads/parse').send({ text: 'Rate con\nMC# 322572\nDallas, TX to Atlanta, GA\nRate: $2,000' });
    expect(parsed.body.vetting.snapshot.legalName).toBe('Summit Logistics LLC');
  });

  it('stores the check on a saved broker, keeps the private team flag, and isolates tenants', async () => {
    const broker = (await A.agent.post('/api/brokers').send({ companyName: 'Fresh Start', mcNumber: '777001' })).body.broker;
    const dup = await A.agent.post('/api/brokers').send({ companyName: 'Fresh Start again', mcNumber: '777001' });
    expect(dup.body.duplicates.map((d) => d.id)).toContain(broker.id);
    expect((await B.agent.post(`/api/brokers/${broker.id}/verify`)).status).toBe(404);
    const v = await A.agent.post(`/api/brokers/${broker.id}/verify`).send({});
    expect(v.status).toBe(200);
    expect(v.body.vetting.flags.map((f) => f.code).sort()).toEqual(['new_registration', 'not_broker', 'po_box']);
    expect(v.body.vetting.level).toBe('amber');
    expect(v.body.broker.fmcsaSnapshot).toBeUndefined();

    const flag = await A.agent.patch(`/api/brokers/${broker.id}/flag`).send({ doNotUse: true, reason: 'Double brokered our load in March' });
    expect(flag.body.vetting.teamFlag).toMatchObject({ source: 'team', message: 'Double brokered our load in March', by: A.user.name });
    expect(flag.body.vetting.level).toBe('red');
    expect((await B.agent.patch(`/api/brokers/${broker.id}/flag`).send({ doNotUse: true })).status).toBe(404);
    const again = await A.agent.post(`/api/brokers/${broker.id}/verify`).send({});
    expect(again.body.vetting.teamFlag).toBeTruthy();
    const list = await A.agent.get('/api/brokers?q=Fresh');
    expect(list.body.items.find((b) => b.id === broker.id).vetting).toMatchObject({ level: 'red', doNotUse: true });
    const detail = await A.agent.get(`/api/brokers/${broker.id}`);
    expect(detail.body.vetting.snapshot.legalName).toBe('Fresh Start Brokerage');
    expect(detail.body.payments).toMatchObject({ paidInvoices: 0, avgDaysToPay: null });
    const off = await A.agent.patch(`/api/brokers/${broker.id}/flag`).send({ doNotUse: false });
    expect(off.body.vetting.teamFlag).toBeNull();
    expect((await A.agent.get(`/api/brokers?mc=777001`)).body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('computes list stats with one aggregate (no per-row load lists)', async () => {
    const broker = (await A.agent.post('/api/brokers').send({ companyName: 'Stats Broker' })).body.broker;
    const lane = { brokerId: broker.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 1000 };
    await A.agent.post('/api/loads').send({ ...lane, rateCents: 200000, status: 'paid' });
    await A.agent.post('/api/loads').send({ ...lane, rateCents: 300000 });
    await A.agent.post('/api/loads').send({ ...lane, rateCents: 900000, status: 'canceled' });
    const list = await A.agent.get('/api/brokers?q=Stats');
    expect(list.body.items[0].stats).toMatchObject({ loads: 2, revenueCents: 500000, paidLoads: 1, avgRatePerMile: 2.5, avgRateCents: 250000 });
    expect(list.body.items[0].loads).toBeUndefined();
  });

  it('runs the nightly watchlist: baseline first, then alerts on changes', async () => {
    const C = await registerUser();
    census.set('555100', { dot_number: '5551000', legal_name: 'Watch Me Transport', carship: 'C', status_code: 'A', docket1prefix: 'MC', docket1: '555100', phone: '3105550100', email_address: 'ops@watchme.test', add_date: '20100101' });
    census.set('555200', { dot_number: '5552000', legal_name: 'Watched Broker Inc', carship: 'B', status_code: 'A', docket1prefix: 'MC', docket1: '555200', phone: '3105550200', add_date: '20100101' });
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'customer' } });
    const carrier = await prisma.carrier.create({ data: { ownerId: C.user.id, stageId: stage.id, companyName: 'Watch Me Transport', dotNumber: '5551000' } });
    await prisma.customer.create({ data: { ownerId: C.user.id, carrierId: carrier.id } });
    const broker = (await C.agent.post('/api/brokers').send({ companyName: 'Watched Broker', mcNumber: '555200', watch: true })).body.broker;

    const outside = await runWatchlist(new Date('2026-11-10T18:00:00Z'));
    expect(outside.skipped).toBeTruthy();
    const first = await runWatchlist(new Date(), { force: true, delayMs: 0 });
    expect(first.carriersChecked).toBeGreaterThanOrEqual(1);
    expect(first.brokersChecked).toBeGreaterThanOrEqual(1);
    expect(await prisma.notification.count({ where: { userId: C.user.id, type: 'fmcsa_change' } })).toBe(0);
    expect(JSON.parse((await prisma.carrier.findUnique({ where: { id: carrier.id } })).fmcsaSnapshot).phones).toEqual(['3105550100']);

    // Checked within 20 hours: skipped. A day later the phone and USDOT status changed.
    census.get('555100').phone = '3105559999';
    census.get('555200').status_code = 'I';
    await prisma.carrier.update({ where: { id: carrier.id }, data: { fmcsaCheckedAt: new Date(Date.now() - 21 * 3600000) } });
    await prisma.broker.update({ where: { id: broker.id }, data: { fmcsaCheckedAt: new Date(Date.now() - 21 * 3600000) } });
    await prisma.systemSetting.deleteMany({ where: { key: 'watchlist.cursor' } });
    await runWatchlist(new Date(), { force: true, delayMs: 0 });
    const notes = await prisma.notification.findMany({ where: { userId: C.user.id, type: 'fmcsa_change' }, orderBy: { createdAt: 'asc' } });
    expect(notes.map((n) => n.link).sort()).toEqual([`/app/brokers/${broker.id}`, `/app/customers/${(await prisma.customer.findUnique({ where: { carrierId: carrier.id } })).id}`].sort());
    expect(notes.find((n) => n.link.includes('customers')).body).toMatch(/Phone: \(310\) 555-0100 → \(310\) 555-9999/);
    expect(notes.find((n) => n.link.includes('brokers')).body).toMatch(/USDOT status: active → inactive/);
    const b = await prisma.broker.findUnique({ where: { id: broker.id } });
    expect(JSON.parse(b.flags).map((f) => f.code)).toContain('usdot_inactive');
    const custList = await C.agent.get('/api/customers');
    expect(custList.body.items[0].fmcsa.lastChange.items[0].field).toBe('phones');
  });

  it('stops re-reading both lists once tonight’s walk reached their ends, and walks again the next night', async () => {
    const D = await registerUser();
    census.set('555300', { dot_number: '5553000', legal_name: 'Night Walk Broker', carship: 'B', status_code: 'A', docket1prefix: 'MC', docket1: '555300', phone: '3105550300', add_date: '20100101' });
    await D.agent.post('/api/brokers').send({ companyName: 'Night Walk Broker', mcNumber: '555300', watch: true });
    await prisma.systemSetting.deleteMany({ where: { key: 'watchlist.cursor' } });
    const readCursor = async () => JSON.parse((await prisma.systemSetting.findUnique({ where: { key: 'watchlist.cursor' } })).value);
    let cursor = {};
    for (let i = 0; i < 30 && !(cursor.customersDone === '2026-11-12' && cursor.brokersDone === '2026-11-12'); i++) {
      await runWatchlist(new Date('2026-11-12T06:00:00Z'), { delayMs: 0 });
      cursor = await readCursor();
    }
    expect(cursor).toMatchObject({ customers: '', brokers: '', customersDone: '2026-11-12', brokersDone: '2026-11-12' });
    // Later tonight nothing is read, even rows that look stale.
    await prisma.broker.updateMany({ where: { ownerId: D.user.id }, data: { fmcsaCheckedAt: new Date('2026-11-01T00:00:00Z') } });
    expect(await runWatchlist(new Date('2026-11-12T07:00:00Z'), { delayMs: 0 })).toMatchObject({ carriersChecked: 0, brokersChecked: 0 });
    // The next night walks from the top again.
    const next = await runWatchlist(new Date('2026-11-13T06:00:00Z'), { delayMs: 0 });
    expect(next.brokersChecked).toBeGreaterThanOrEqual(1);
  });
});

describe('watchlist QCMobile carry-forward', () => {
  it('keeps the last QCMobile facts with their date when QCMobile was skipped this run', async () => {
    const { carryQc } = await import('../src/services/brokers/watchlist.js');
    const prev = { found: true, qc: true, qcAsOf: '2026-11-01T08:00:00.000Z', checkedAt: '2026-11-01T08:00:00.000Z', insuranceOnFile: true, carrierAuthority: 'active', sources: [] };
    const next = { found: true, qc: false, checkedAt: '2026-11-10T08:00:00.000Z', insuranceOnFile: null, sources: [{ name: 'FMCSA census', asOf: '2026-11-10T08:00:00.000Z' }] };
    const out = carryQc(prev, next);
    expect(out).toMatchObject({ qc: true, qcAsOf: '2026-11-01T08:00:00.000Z', insuranceOnFile: true, carrierAuthority: 'active', checkedAt: '2026-11-10T08:00:00.000Z' });
    expect(out.sources.map((s) => s.name)).toEqual(['FMCSA census', 'FMCSA QCMobile']);
    expect(snapshotChanges(prev, out)).toEqual([]);
    expect(carryQc(null, next)).toBe(next);
  });
});
