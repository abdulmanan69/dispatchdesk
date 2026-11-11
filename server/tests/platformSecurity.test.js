import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app, agent, registerUser, createAdmin, prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { withLock } from '../src/lib/locks.js';
import { config } from '../src/config.js';
import { hashPassword, verifyPassword, DUMMY_HASH, passwordPoolStats } from '../src/middleware/passwordHash.js';
import { computeSignature } from '../src/services/telephony/twilio.js';

let seq = 0;
const email = (p) => `${p}${Date.now()}${++seq}@example.test`;

/** Register through the API and keep the email-verification dev token. */
async function registerWithToken(name = 'Unverified Person') {
  const a = await agent();
  const res = await a.post('/api/auth/register').send({ name, email: email('unv'), password: 'Passw0rd!x', acceptTerms: true });
  expect(res.status).toBe(201);
  return { agent: a, user: res.body.user, verifyToken: res.body.devToken };
}

async function stageId(key = 'lead') {
  return (await prisma.pipelineStage.findUnique({ where: { key } })).id;
}

// ---------------------------------------------------------------------------
describe('password hashing runs on worker threads', () => {
  it('hashes and verifies with bcrypt cost 12 off the event loop', async () => {
    const hash = await hashPassword('Correct horse 1');
    expect(hash).toMatch(/^\$2[ab]\$12\$/);
    expect(await verifyPassword('Correct horse 1', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(bcrypt.getRounds(DUMMY_HASH)).toBe(12); // unknown emails cost the same as real ones
    const stats = passwordPoolStats();
    expect(stats.inline).toBe(false);
    expect(stats.threads).toBeGreaterThan(0);
  });

  it('the event loop keeps running while a hash is computed', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    await Promise.all([hashPassword('a1-busy-check'), hashPassword('b2-busy-check')]);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
describe('email verification enforcement', () => {
  afterEach(async () => {
    await setSetting('app.requireEmailVerification', 'false');
    await setSetting('smtp.host', '');
    await setSetting('smtp.from', '');
  });

  const requireIt = async () => {
    await setSetting('app.requireEmailVerification', 'true');
    // Platform email must be configured for the rule to apply (nothing is sent in these tests).
    await setSetting('smtp.host', 'smtp.invalid.test');
    await setSetting('smtp.from', 'DispatchDesk <no-reply@example.test>');
  };

  it('blocks writes by unverified accounts with EMAIL_UNVERIFIED; reads, profile and sign-out still work', async () => {
    const u = await registerWithToken();
    await requireIt();
    const write = await u.agent.post('/api/carriers').send({ companyName: 'Blocked Until Verified LLC' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('EMAIL_UNVERIFIED');
    expect(await prisma.carrier.count({ where: { ownerId: u.user.id } })).toBe(0);
    expect((await u.agent.post('/api/tokens').send({ name: 'ext' })).body.code).toBe('EMAIL_UNVERIFIED');
    expect((await u.agent.get('/api/carriers')).status).toBe(200);
    expect((await u.agent.get('/api/billing/me')).status).toBe(200);
    expect((await u.agent.patch('/api/profile').send({ theme: 'dark' })).status).toBe(200);
    const me = await u.agent.get('/api/auth/me');
    expect(me.body.user).toMatchObject({ emailVerified: false, verificationRequired: true, mailConfigured: true });

    // Verifying unlocks writes right away (the cached session is dropped).
    expect((await u.agent.post('/api/auth/verify-email').send({ token: u.verifyToken })).status).toBe(200);
    expect((await u.agent.post('/api/carriers').send({ companyName: 'Verified Now LLC' })).status).toBe(201);
    expect((await u.agent.post('/api/auth/logout')).status).toBe(200);
  });

  it('does not apply when the setting is off or platform email is not configured', async () => {
    const u = await registerWithToken();
    expect((await u.agent.post('/api/carriers').send({ companyName: 'Setting Off LLC' })).status).toBe(201);
    await setSetting('app.requireEmailVerification', 'true'); // no SMTP: nobody could verify, so it is not enforced
    expect((await u.agent.post('/api/carriers').send({ companyName: 'No Mail LLC' })).status).toBe(201);
    expect((await u.agent.get('/api/auth/me')).body.user.verificationRequired).toBe(false);
  });

  it('never locks out admins, and unverified users can still delete their account', async () => {
    const admin = await createAdmin(); // registered through the API, so unverified
    const u = await registerWithToken();
    const target = await registerUser();
    await requireIt();
    expect((await admin.agent.post('/api/admin/subscriptions/grant').send({ userId: target.user.id, planKey: 'pro', months: 1 })).status).toBe(201);
    const del = await u.agent.delete('/api/settings/account').send({ password: 'Passw0rd!x', confirm: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: u.user.id } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('moderating a reported comment', () => {
  it('hides only the comment, keeps the post published, and leaves post reports open', async () => {
    const author = await registerUser();
    const reporter = await registerUser();
    const admin = await createAdmin();
    const post = (await author.agent.post('/api/community/posts').send({ title: 'Lanes out of Laredo', body: 'Useful thread' })).body.post;
    const comment = (await author.agent.post(`/api/community/posts/${post.id}/comments`).send({ body: 'abusive reply' })).body.comment;
    const postReport = (await reporter.agent.post(`/api/community/posts/${post.id}/report`).send({ reason: 'other' })).body.report;
    const commentReport = (await reporter.agent.post(`/api/community/comments/${comment.id}/report`).send({ reason: 'abuse' })).body.report;

    const list = await admin.agent.get('/api/admin/reports');
    const item = list.body.items.find((x) => x.id === commentReport.id);
    expect(item.kind).toBe('comment');
    expect(item.target).toMatchObject({ id: comment.id, excerpt: 'abusive reply', context: 'Comment on "Lanes out of Laredo"' });
    expect(item.target.link).toBe(`/community/${post.id}#c-${comment.id}`);
    expect(list.body.items.find((x) => x.id === postReport.id).kind).toBe('post');

    const res = await admin.agent.post(`/api/admin/reports/${commentReport.id}/resolve`).send({ action: 'hide_content' });
    expect(res.status).toBe(200);
    expect((await prisma.communityComment.findUnique({ where: { id: comment.id } })).status).toBe('hidden');
    expect((await prisma.communityPost.findUnique({ where: { id: post.id } })).status).toBe('published');
    expect((await prisma.contentReport.findUnique({ where: { id: postReport.id } })).status).toBe('open');

    // Resolving the post report closes post reports only, never the comment's.
    const c2 = (await author.agent.post(`/api/community/posts/${post.id}/comments`).send({ body: 'second' })).body.comment;
    const r2 = (await reporter.agent.post(`/api/community/comments/${c2.id}/report`).send({ reason: 'spam' })).body.report;
    await admin.agent.post(`/api/admin/reports/${postReport.id}/resolve`).send({ action: 'hide_content' });
    expect((await prisma.communityPost.findUnique({ where: { id: post.id } })).status).toBe('hidden');
    expect((await prisma.contentReport.findUnique({ where: { id: r2.id } })).status).toBe('open');
  });
});

// ---------------------------------------------------------------------------
describe('account deletion', () => {
  it('a user on an admin-granted plan can delete their own account', async () => {
    const admin = await createAdmin();
    const u = await registerUser();
    expect((await admin.agent.post('/api/admin/subscriptions/grant').send({ userId: u.user.id, planKey: 'pro', months: 6 })).status).toBe(201);
    const res = await u.agent.delete('/api/settings/account').send({ password: u.password, confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: u.user.id } })).toBeNull();
    expect(await prisma.subscription.count({ where: { userId: u.user.id } })).toBe(0);
  });

  it('a live Stripe subscription still blocks deletion', async () => {
    const u = await registerUser();
    const plan = await prisma.plan.findUnique({ where: { key: 'pro' } });
    await prisma.subscription.create({ data: { userId: u.user.id, planId: plan.id, status: 'active', stripeSubscriptionId: `sub_block_${Date.now()}` } });
    const res = await u.agent.delete('/api/settings/account').send({ password: u.password, confirm: 'DELETE' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Cancel your subscription/);
    expect(await prisma.user.findUnique({ where: { id: u.user.id } })).not.toBeNull();
  });

  it('admin delete runs every check before deleting anything (the team survives a refused delete)', async () => {
    const admin = await createAdmin();
    const owner = await registerUser();
    const team = (await owner.agent.post('/api/teams').send({ name: `Solo Team ${Date.now()}` })).body.team;
    const plan = await prisma.plan.findUnique({ where: { key: 'pro' } });
    const sub = await prisma.subscription.create({ data: { userId: owner.user.id, planId: plan.id, status: 'active', stripeSubscriptionId: `sub_admin_${Date.now()}` } });
    const refused = await admin.agent.delete(`/api/admin/users/${owner.user.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Stripe/);
    expect(await prisma.team.findUnique({ where: { id: team.id } })).not.toBeNull();

    // Once the paid subscription is gone, the delete removes the user, the empty team and the data in batches.
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'canceled' } });
    const stage = await stageId();
    await prisma.carrier.createMany({ data: Array.from({ length: 450 }, (_, i) => ({ ownerId: owner.user.id, stageId: stage, companyName: `Batch Carrier ${i}` })) });
    const ok = await admin.agent.delete(`/api/admin/users/${owner.user.id}`);
    expect(ok.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: owner.user.id } })).toBeNull();
    expect(await prisma.team.findUnique({ where: { id: team.id } })).toBeNull();
    expect(await prisma.carrier.count({ where: { ownerId: owner.user.id } })).toBe(0);
  });

  it('refuses to delete a team owner whose team has other members', async () => {
    const admin = await createAdmin();
    const owner = await registerUser();
    const member = await registerUser();
    const team = (await owner.agent.post('/api/teams').send({ name: `Busy Team ${Date.now()}` })).body.team;
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, role: 'dispatcher' } });
    const res = await admin.agent.delete(`/api/admin/users/${owner.user.id}`);
    expect(res.status).toBe(409);
    expect(await prisma.team.findUnique({ where: { id: team.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: owner.user.id } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('data export', () => {
  it('streams the account as valid JSON and never includes credentials or other users', async () => {
    const u = await registerUser();
    const other = await registerUser();
    const stage = await stageId();
    await prisma.carrier.createMany({ data: Array.from({ length: 230 }, (_, i) => ({ ownerId: u.user.id, stageId: stage, companyName: `Export Carrier ${i}` })) });
    await prisma.carrier.create({ data: { ownerId: other.user.id, stageId: stage, companyName: 'Someone Else Freight' } });
    const res = await u.agent.get('/api/settings/export').buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d)); });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="dispatchdesk-export-/);
    const data = JSON.parse(res.body);
    expect(data.format).toBe('dispatchdesk-export/1');
    expect(data.carriers).toHaveLength(230);
    expect(data.carriers.every((c) => c.ownerId === u.user.id)).toBe(true);
    expect(data.profile.passwordHash).toBeUndefined();
    expect(Array.isArray(data.invoices)).toBe(true);
    expect(res.body).not.toContain('Someone Else Freight');
  });

  it('allows one export per account at a time', async () => {
    const u = await registerUser();
    await withLock(`export.${u.user.id}`, 60_000, async () => {
      const res = await u.agent.get('/api/settings/export');
      expect(res.status).toBe(409);
    });
    expect((await u.agent.get('/api/settings/export')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('Twilio dial-result auto-logging', () => {
  const SID = `AC${'b'.repeat(32)}`;
  const TOKEN = 'twilio-race-test-token';
  afterEach(() => vi.restoreAllMocks());

  it('concurrent or repeated callbacks log the unanswered call once', async () => {
    const u = await registerUser();
    await u.agent.put('/api/telephony/settings').send({ provider: 'twilio', twilioAccountSid: SID, twilioAuthToken: TOKEN, callerId: '+12145550000', myNumber: '+19725551111', enforceCallingHours: false });
    const carrier = (await u.agent.post('/api/carriers').send({ companyName: 'Race Freight LLC', phone: '2145553333', state: 'TX' })).body.carrier;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sid: `CA${'c'.repeat(32)}`, status: 'queued' }), { status: 201 }));
    const dial = await u.agent.post('/api/telephony/dial').send({ carrierId: carrier.id });
    expect(dial.status).toBe(201);
    const id = dial.body.attempt.id;
    const att = await prisma.callAttempt.findUnique({ where: { id } });
    const path = `/api/telephony/twilio/dial-result/${id}`;
    const params = { CallSid: att.providerCallId, DialCallStatus: 'no-answer', DialCallDuration: '0' };
    const sig = computeSignature(TOKEN, `${config.appUrl}${path}`, params);
    const post = () => request(app).post(path).type('form').set('X-Twilio-Signature', sig).send(params);
    const results = await Promise.all([post(), post(), post()]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    await post(); // a later retry
    expect(await prisma.call.count({ where: { carrierId: carrier.id } })).toBe(1);
    expect((await prisma.callAttempt.findUnique({ where: { id } })).callId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('partial PATCH never resets other fields', () => {
  it('marketplace listing: hiding keeps price, category and location', async () => {
    const s = await registerUser();
    const l = (await s.agent.post('/api/marketplace/listings').send({ title: 'Reefer consulting', category: 'consulting', description: 'Hourly help', priceType: 'hourly', priceCents: 5000, location: 'Dallas, TX' })).body.listing;
    const res = await s.agent.patch(`/api/marketplace/listings/${l.id}`).send({ status: 'hidden' });
    expect(res.status).toBe(200);
    expect(res.body.listing).toMatchObject({ status: 'hidden', priceType: 'hourly', priceCents: 5000, category: 'consulting', location: 'Dallas, TX' });
  });

  it('community post: editing the title keeps the category', async () => {
    const a = await registerUser();
    const p = (await a.agent.post('/api/community/posts').send({ title: 'Broker tips', body: 'b', category: 'brokers' })).body.post;
    const res = await a.agent.patch(`/api/community/posts/${p.id}`).send({ title: 'Broker tips, updated' });
    expect(res.body.post).toMatchObject({ title: 'Broker tips, updated', category: 'brokers' });
  });

  it('team settings and member rights: one toggle changes one field', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const team = (await owner.agent.post('/api/teams').send({ name: `Toggle Team ${Date.now()}` })).body.team;
    await owner.agent.patch('/api/teams/mine').send({ managersSeeAll: true });
    const res = await owner.agent.patch('/api/teams/mine').send({ leaderboardEnabled: false });
    expect(res.body.team).toMatchObject({ leaderboardEnabled: false, managersSeeAll: true, name: team.name });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, role: 'manager', canManageMembers: true } });
    const m = await owner.agent.patch(`/api/teams/members/${member.user.id}`).send({ canViewTeamData: true });
    expect(m.body.member).toMatchObject({ role: 'manager', canViewTeamData: true, canManageMembers: true });
  });

  it('profile: one setting does not reset the others', async () => {
    const u = await registerUser();
    await u.agent.patch('/api/profile').send({ notifyEmail: false, timezone: 'America/Denver', bio: 'Flatbed desk' });
    const res = await u.agent.patch('/api/profile').send({ theme: 'dark' });
    expect(res.body.user).toMatchObject({ theme: 'dark', notifyEmail: false, timezone: 'America/Denver', bio: 'Flatbed desk' });
  });

  it('admin plan edit: one limit changes, the rest stay', async () => {
    const admin = await createAdmin();
    const before = await prisma.plan.findUnique({ where: { key: 'annual' } });
    const res = await admin.agent.patch(`/api/admin/plans/${before.id}`).send({ maxSequences: before.maxSequences + 1 });
    expect(res.status).toBe(200);
    const after = await prisma.plan.findUnique({ where: { key: 'annual' } });
    expect(after).toMatchObject({ maxSequences: before.maxSequences + 1, maxCarriers: before.maxCarriers, dailyEmailLimit: before.dailyEmailLimit, trialDays: before.trialDays, interval: before.interval, active: before.active });
    await prisma.plan.update({ where: { id: before.id }, data: { maxSequences: before.maxSequences } });
  });

  it('document: changing the expiry keeps the type', async () => {
    const u = await registerUser();
    const carrier = await prisma.carrier.create({ data: { ownerId: u.user.id, stageId: await stageId('customer'), companyName: 'Patch Docs LLC' } });
    const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
    const doc = (await u.agent.post('/api/documents').field('carrierId', carrier.id).field('type', 'coi').attach('file', PDF, { filename: 'coi.pdf', contentType: 'application/pdf' })).body.document;
    expect(doc.source).toBe('upload');
    const res = await u.agent.patch(`/api/documents/${doc.id}`).send({ expiresAt: '2027-01-31' });
    expect(res.body.document.type).toBe('coi');
    // Other tenants get 404, never someone else's document.
    const other = await registerUser();
    expect((await other.agent.patch(`/api/documents/${doc.id}`).send({ type: 'w9' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('avatar caching', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc4cd0b0000000049454e44ae426082', 'hex');

  it('serves versioned avatar URLs with a long immutable cache and no session work', async () => {
    const u = await registerUser();
    const up = await u.agent.post('/api/profile/avatar').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    const url = up.body.user.avatarUrl;
    expect(url).toMatch(new RegExp(`^/api/profile/avatar/${u.user.id}\\?v=[\\w-]{10}$`));
    const versioned = await request(app).get(url);
    expect(versioned.status).toBe(200);
    expect(versioned.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(versioned.headers['set-cookie']).toBeUndefined(); // no CSRF cookie or session lookup for images
    const stale = await request(app).get(`/api/profile/avatar/${u.user.id}?v=old`);
    expect(stale.headers['cache-control']).toBe('public, max-age=300');
    const post = (await u.agent.post('/api/community/posts').send({ title: 'Avatar post', body: 'x' })).body.post;
    expect(post.author.avatarUrl).toBe(url);
    expect((await request(app).get('/api/profile/avatar/nope')).status).toBe(404);
  });
});
