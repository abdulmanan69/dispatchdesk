import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { BULK_FILTER_CAP, carrierWhere } from '../src/services/carriers/query.js';

const stageId = async (key) => (await prisma.pipelineStage.findUnique({ where: { key } })).id;

async function seed(owner, n, extra = () => ({}), prefix = 'Bulk Carrier') {
  const lead = await stageId('lead');
  await prisma.carrier.createMany({
    data: Array.from({ length: n }, (_, i) => ({ ownerId: owner.user.id, stageId: lead, companyName: `${prefix} ${i}`, state: 'TX', ...extra(i) })),
  });
  return prisma.carrier.findMany({ where: { ownerId: owner.user.id, companyName: { startsWith: prefix } }, orderBy: { companyName: 'asc' } });
}

async function makeTeam(owner, member) {
  expect((await owner.agent.post('/api/teams').send({ name: `Team ${Date.now()}` })).status).toBe(201);
  const inv = await owner.agent.post('/api/teams/invitations').send({ email: member.email, role: 'dispatcher' });
  expect((await member.agent.post(`/api/teams/invitations/${inv.body.devToken}/accept`)).status).toBe(200);
}

async function mailbox(user, extra = {}) {
  return prisma.emailAccount.create({
    data: { userId: user.user.id, provider: 'smtp', label: 'Work', fromEmail: `me${Date.now()}@dispatch.test`, smtpHost: 'smtp.test', smtpPort: 587, status: 'connected', isDefault: true, dailyLimit: 50, cooldownSeconds: 30, ...extra },
  });
}

describe('carrier list: scope and select-all-matching bulk actions', () => {
  let A; let B; let rows;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    rows = await seed(A, 30, (i) => ({
      phone: i % 3 ? `21455501${String(i).padStart(2, '0')}` : null, doNotCall: i === 1, dotNumber: String(700000 + i),
    }));
  });

  it('solo users get a plain owner condition (no assigned-to branch)', async () => {
    const solo = await prisma.user.findUnique({ where: { id: A.user.id }, include: { teamMembership: true } });
    expect(await carrierWhere(solo, { scope: 'mine' })).toEqual({ ownerId: A.user.id });
    const res = await A.agent.get('/api/carriers?state=TX&pageSize=10');
    expect(res.body.total).toBe(30);
    expect(res.body.items).toHaveLength(10);
    // List rows carry list fields only.
    expect(res.body.items[0]).not.toHaveProperty('fmcsaSnapshot');
    expect(res.body.items[0]).toHaveProperty('stage');
  });

  it('tags every matching carrier across pages, once, and never touches other users', async () => {
    const first = await A.agent.post('/api/carriers/bulk').send({ action: 'add_tag', filter: { state: 'TX' }, value: 'Texas' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ affected: 30, requested: 30, inaccessible: 0 });
    const again = await A.agent.post('/api/carriers/bulk').send({ action: 'add_tag', filter: { state: 'TX' }, value: 'Texas' });
    expect(again.body.affected).toBe(30);
    const tag = await prisma.tag.findFirst({ where: { ownerId: A.user.id, name: 'Texas' } });
    expect(await prisma.carrierTag.count({ where: { tagId: tag.id } })).toBe(30);

    const other = await B.agent.post('/api/carriers/bulk').send({ action: 'set_do_not_call', filter: { state: 'TX' }, value: true });
    expect(other.body).toMatchObject({ affected: 0, requested: 0 });
    const byId = await B.agent.post('/api/carriers/bulk').send({ action: 'delete', ids: rows.slice(0, 3).map((c) => c.id) });
    expect(byId.body).toMatchObject({ affected: 0, requested: 3, inaccessible: 3 });
    expect(await prisma.carrier.count({ where: { ownerId: A.user.id } })).toBe(30);
  });

  it('requires exactly one of ids or filter', async () => {
    expect((await A.agent.post('/api/carriers/bulk').send({ action: 'add_tag', value: 'x' })).status).toBe(400);
    expect((await A.agent.post('/api/carriers/bulk').send({ action: 'add_tag', value: 'x', ids: [rows[0].id], filter: {} })).status).toBe(400);
  });

  it('moves stages in batches with timeline entries; side-effect stages still create records', async () => {
    const res = await A.agent.post('/api/carriers/bulk').send({ action: 'move_stage', filter: { state: 'TX' }, value: 'prospecting' });
    expect(res.body.affected).toBe(30);
    const prospecting = await stageId('prospecting');
    expect(await prisma.carrier.count({ where: { ownerId: A.user.id, stageId: prospecting } })).toBe(30);
    expect(await prisma.activity.count({ where: { userId: A.user.id, type: 'stage_change', summary: { contains: '(bulk)' } } })).toBe(30);
    const opp = await A.agent.post('/api/carriers/bulk').send({ action: 'move_stage', ids: [rows[2].id, rows[3].id], value: 'opportunity' });
    expect(opp.body.affected).toBe(2);
    expect(await prisma.opportunity.count({ where: { carrierId: { in: [rows[2].id, rows[3].id] } } })).toBe(2);
    expect((await A.agent.post('/api/carriers/bulk').send({ action: 'move_stage', ids: [rows[2].id], value: 'nope' })).status).toBe(400);
  });

  it('builds a call list for the power dialer from callable carriers only', async () => {
    const res = await A.agent.post('/api/carriers/bulk').send({ action: 'call_list', filter: { state: 'TX' }, value: 'Morning calls' });
    expect(res.status).toBe(200);
    const callable = rows.filter((c) => c.phone && !c.doNotCall).length;
    expect(res.body).toMatchObject({ added: callable, doNotCall: 1, noPhone: rows.filter((c) => !c.phone).length, overLimit: 0 });
    expect(res.body.list.name).toBe('Morning calls');
    expect(await prisma.prospectListItem.count({ where: { listId: res.body.list.id } })).toBe(callable);
    // Same name again gets a numbered copy instead of failing.
    const again = await A.agent.post('/api/carriers/bulk').send({ action: 'call_list', ids: [rows[2].id], value: 'Morning calls' });
    expect(again.body.list.name).toBe('Morning calls (2)');
    const none = await A.agent.post('/api/carriers/bulk').send({ action: 'call_list', ids: [rows[0].id] });
    expect(none.status).toBe(400);
  });

  it('enrolls every matching carrier in a sequence', async () => {
    const seq = (await A.agent.post('/api/sequences').send({ name: 'Bulk seq', steps: [{ dayOffset: 0, type: 'call' }] })).body.sequence;
    const res = await A.agent.post('/api/carriers/bulk').send({ action: 'enroll_sequence', filter: { state: 'TX', q: 'Bulk Carrier 1' }, value: seq.id });
    expect(res.status).toBe(200);
    expect(res.body.affected).toBe(11); // 1 and 10-19
    expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id } })).toBe(11);
  });

  it('refuses a filter that matches more than the cap instead of acting on part of it', async () => {
    const C = await registerUser();
    const lead = await stageId('lead');
    await prisma.carrier.createMany({ data: Array.from({ length: BULK_FILTER_CAP + 1 }, (_, i) => ({ ownerId: C.user.id, stageId: lead, companyName: `Cap ${i}` })) });
    const res = await C.agent.post('/api/carriers/bulk').send({ action: 'add_tag', filter: {}, value: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/More than 5,000 carriers match/);
    expect(await prisma.carrierTag.count({ where: { carrier: { ownerId: C.user.id } } })).toBe(0);
  });

  it('API tokens cannot act on a whole filter or send bulk email', async () => {
    const { body } = await A.agent.post('/api/tokens').send({ name: 'ext', expiresInDays: 30 });
    const bearer = { Authorization: `Bearer ${body.token}` };
    expect((await request(app).post('/api/carriers/bulk').set(bearer).send({ action: 'add_tag', filter: {}, value: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/carriers/bulk').set(bearer).send({ action: 'add_tag', ids: [rows[5].id], value: 'Token tag' })).body.affected).toBe(1);
    expect((await request(app).post('/api/carriers/bulk/email').set(bearer).send({ ids: [rows[5].id], subject: 's', body: 'b' })).status).toBe(403);
  });

  it('deletes by filter only what matches', async () => {
    const D = await registerUser();
    await seed(D, 5, () => ({}), 'Keep');
    await seed(D, 4, () => ({ state: 'OK' }), 'Drop');
    const res = await D.agent.post('/api/carriers/bulk').send({ action: 'delete', filter: { state: 'OK' } });
    expect(res.body.affected).toBe(4);
    expect(await prisma.carrier.count({ where: { ownerId: D.user.id } })).toBe(5);
  });
});

describe('bulk email from the carrier list', () => {
  let E; let carriers; let template;
  beforeAll(async () => {
    E = await registerUser({ name: 'Erin Dispatch' });
    const lead = await stageId('lead');
    const mk = (data) => prisma.carrier.create({ data: { ownerId: E.user.id, stageId: lead, ...data } });
    carriers = {
      ok: await mk({ companyName: 'Open Road LLC', email: 'ops@openroad.test' }),
      contact: await mk({ companyName: 'Pat Freight', email: 'pat@freight.test', contacts: { create: { name: 'Pat Moore', isPrimary: true } } }),
      none: await mk({ companyName: 'No Mail Inc' }),
      dne: await mk({ companyName: 'Quiet Co', email: 'quiet@co.test', doNotEmail: true }),
      suppressed: await mk({ companyName: 'Unsub LLC', email: 'gone@unsub.test' }),
    };
    await prisma.emailSuppression.create({ data: { ownerId: E.user.id, email: 'gone@unsub.test', reason: 'unsubscribed' } });
    template = await prisma.emailTemplate.create({ data: { ownerId: E.user.id, name: 'Intro', subject: 'Dispatch for {{company}}', body: 'Hi {{first_name}}, this is {{my_name}}.' } });
  });
  const ids = () => Object.values(carriers).map((c) => c.id);

  it('previews without a mailbox but needs one to queue', async () => {
    const dry = await E.agent.post('/api/carriers/bulk/email').send({ ids: ids(), templateId: template.id, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ mailbox: null, capacity: null, recipients: 2 });
    const res = await E.agent.post('/api/carriers/bulk/email').send({ ids: ids(), templateId: template.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect a mailbox/);
  });

  it('previews recipients, skips with reasons, and shows capacity without queueing', async () => {
    await mailbox(E);
    const res = await E.agent.post('/api/carriers/bulk/email').send({ ids: ids(), templateId: template.id, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toBe(2);
    expect(res.body.skipped.map((s) => s.reason).sort()).toEqual(['Do-not-email is on', 'No email address', 'On your do-not-email list']);
    expect(res.body.samples[0]).toMatchObject({ subject: 'Dispatch for Open Road LLC', toEmail: 'ops@openroad.test' });
    expect(res.body.samples[1].body).toContain('Hi Pat, this is Erin Dispatch.');
    expect(res.body.capacity).toMatchObject({ mailboxLeftToday: 50, planLeftToday: 20 });
    expect(await prisma.email.count({ where: { userId: E.user.id } })).toBe(0);
  });

  it('queues personalized emails (never sends inline) and counts the template use', async () => {
    const res = await E.agent.post('/api/carriers/bulk/email').send({ ids: ids(), templateId: template.id });
    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(2);
    const emails = await prisma.email.findMany({ where: { userId: E.user.id }, orderBy: { toEmail: 'asc' } });
    expect(emails.map((e) => e.status)).toEqual(['scheduled', 'scheduled']);
    expect(emails.find((e) => e.toEmail === 'pat@freight.test')).toMatchObject({ subject: 'Dispatch for Pat Freight', carrierId: carriers.contact.id, templateId: template.id });
    expect((await prisma.emailTemplate.findUnique({ where: { id: template.id } })).useCount).toBe(1);
    expect(res.body.message).toMatch(/queued/);
  });

  it('never queues an email with unfilled merge fields', async () => {
    const res = await E.agent.post('/api/carriers/bulk/email').send({ ids: [carriers.ok.id], subject: 'Load {{load_ref}}', body: 'Hi {{first_name}}' });
    expect(res.body.queued).toBe(0);
    expect(res.body.skipped[0].reason).toBe('Unfilled merge fields: load_ref');
  });

  it('a known field with no value for a carrier keeps only that email out (preview and send agree)', async () => {
    const withMc = await prisma.carrier.create({ data: { ownerId: E.user.id, stageId: await stageId('lead'), companyName: 'Mc Haulers', email: 'ops@mchaulers.test', mcNumber: '778899' } });
    const msg = { ids: [carriers.ok.id, withMc.id], subject: 'MC {{mc}} and dispatch', body: 'Hi {{first_name}}, about MC {{mc}}.' };
    const dry = await E.agent.post('/api/carriers/bulk/email').send({ ...msg, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.recipients).toBe(1);
    expect(dry.body.missingFields).toEqual(['mc']);
    expect(dry.body.skipped).toEqual([{ id: carriers.ok.id, name: 'Open Road LLC', reason: 'Unfilled merge fields: mc' }]);
    const res = await E.agent.post('/api/carriers/bulk/email').send(msg);
    expect(res.body.queued).toBe(1);
    expect(res.body.skipped.map((s) => s.reason)).toEqual(['Unfilled merge fields: mc']);
    const queued = await prisma.email.findMany({ where: { userId: E.user.id, subject: { startsWith: 'MC ' } }, select: { toEmail: true, subject: true } });
    expect(queued).toEqual([{ toEmail: 'ops@mchaulers.test', subject: 'MC 778899 and dispatch' }]);
  });

  it('refuses a second bulk send while one is still being queued (any worker)', async () => {
    const key = `lock.carriers.bulk-email.${E.user.id}`;
    await prisma.systemSetting.create({ data: { key, value: String(Date.now()), secret: false } });
    try {
      const res = await E.agent.post('/api/carriers/bulk/email').send({ ids: [carriers.ok.id], subject: 'Hello {{company}}', body: 'Hi' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/still being queued/);
      // A preview never waits for the lock.
      expect((await E.agent.post('/api/carriers/bulk/email').send({ ids: [carriers.ok.id], subject: 'Hello {{company}}', body: 'Hi', dryRun: true })).status).toBe(200);
    } finally {
      await prisma.systemSetting.deleteMany({ where: { key } });
    }
  });

  it('stops at the plan daily email limit', async () => {
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    const acc = await prisma.emailAccount.findFirst({ where: { userId: E.user.id } });
    await prisma.email.createMany({ data: Array.from({ length: free.dailyEmailLimit }, (_, i) => ({ userId: E.user.id, emailAccountId: acc.id, toEmail: `x${i}@sent.test`, subject: 's', body: 'b', status: 'sent', sentAt: new Date() })) });
    const res = await E.agent.post('/api/carriers/bulk/email').send({ ids: [carriers.ok.id, carriers.contact.id], subject: 'Hello {{company}}', body: 'Hi' });
    expect(res.body.queued).toBe(0);
    expect(res.body.skipped.every((s) => /plan allows/.test(s.reason))).toBe(true);
  });

  it('caps one request at 200 recipients and isolates other users', async () => {
    const F = await registerUser();
    await mailbox(F);
    await seed(F, 201, (i) => ({ email: `m${i}@many.test` }), 'Many');
    const big = await F.agent.post('/api/carriers/bulk/email').send({ filter: {}, subject: 'Hi {{company}}', body: 'Hello', dryRun: true });
    expect(big.status).toBe(400);
    const foreign = await F.agent.post('/api/carriers/bulk/email').send({ ids: [carriers.ok.id], subject: 'Hi', body: 'Hello', dryRun: true });
    expect(foreign.body).toMatchObject({ requested: 1, inaccessible: 1, recipients: 0 });
  });
});

describe('team scope', () => {
  let O; let M; let assigned; let other;
  beforeAll(async () => {
    O = await registerUser({ name: 'Olive Owner' });
    M = await registerUser({ name: 'Max Member' });
    await makeTeam(O, M);
    assigned = (await O.agent.post('/api/carriers').send({ companyName: 'Assigned Hauling', dotNumber: '880001' })).body.carrier;
    other = (await O.agent.post('/api/carriers').send({ companyName: 'Owner Only Freight', dotNumber: '880002' })).body.carrier;
    expect((await O.agent.patch(`/api/carriers/${assigned.id}`).send({ assignedToId: M.user.id })).status).toBe(200);
  });

  it('team members see carriers assigned to them in "mine" and can work them', async () => {
    const list = await M.agent.get('/api/carriers');
    expect(list.body.items.map((c) => c.id)).toEqual([assigned.id]);
    const d = await M.agent.get(`/api/carriers/${assigned.id}`);
    expect(d.body.canWrite).toBe(true);
    expect((await M.agent.get(`/api/carriers/${other.id}`)).status).toBe(404);
    const bulk = await M.agent.post('/api/carriers/bulk').send({ action: 'add_tag', filter: {}, value: 'Mine' });
    expect(bulk.body.affected).toBe(1);
  });

  it('read-only team access shows the profile with canWrite false', async () => {
    await O.agent.patch(`/api/teams/members/${M.user.id}`).send({ canViewTeamData: true });
    const d = await M.agent.get(`/api/carriers/${other.id}`);
    expect(d.status).toBe(200);
    expect(d.body.canWrite).toBe(false);
    const bulk = await M.agent.post('/api/carriers/bulk').send({ action: 'add_tag', filter: { scope: 'team' }, value: 'Team' });
    expect(bulk.body).toMatchObject({ requested: 2, affected: 1, inaccessible: 1 });
  });
});

describe('carrier profile counts are real totals', () => {
  it('reports call, note and follow-up totals beyond the rows it returns', async () => {
    const P = await registerUser();
    const c = (await P.agent.post('/api/carriers').send({ companyName: 'Busy Freight' })).body.carrier;
    await prisma.call.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ carrierId: c.id, userId: P.user.id, outcome: 'no_answer', calledAt: new Date(Date.now() - i * 60000) })) });
    await prisma.carrierNote.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ carrierId: c.id, authorId: P.user.id, body: `Note ${i}` })) });
    const old = Date.now() - 90 * 86400000;
    await prisma.followUp.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ carrierId: c.id, userId: P.user.id, dueAt: new Date(old + i * 3600000), status: 'done', completedAt: new Date(old + i * 3600000) })) });
    await prisma.followUp.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ carrierId: c.id, userId: P.user.id, dueAt: new Date(Date.now() + (i + 1) * 86400000) })) });
    const seq = (await P.agent.post('/api/sequences').send({ name: 'S', steps: [{ dayOffset: 0, type: 'email', subject: 'Hi', body: 'Long body' }] })).body.sequence;
    await P.agent.post('/api/carriers/bulk').send({ action: 'enroll_sequence', ids: [c.id], value: seq.id });

    const { body } = await P.agent.get(`/api/carriers/${c.id}`);
    expect(body.carrier.calls).toHaveLength(50);
    expect(body.carrier._count.calls).toBe(60);
    expect(body.carrier.activityCounts.calls).toBe(60);
    expect(body.carrier.notes).toHaveLength(100);
    expect(body.carrier._count.notes).toBe(105);
    expect(body.carrier.followUpCounts.pending).toBe(3);
    expect(body.carrier.followUps.slice(0, 3).every((f) => f.status === 'pending')).toBe(true);
    expect(body.carrier.followUps).toHaveLength(3 + 20);
    expect(body.carrier.enrollments[0].sequence).toEqual({ id: seq.id, name: 'S', stepCount: 1 });
    expect(body.carrier.enrollments[0].step).toMatchObject({ type: 'email', order: 1 });
    expect(JSON.stringify(body)).not.toContain('Long body');
  });
});

describe('CSV import in batches', () => {
  const csvOf = (rows) => ['Company,USDOT,Phone,Contact,Notes', ...rows].join('\n');

  it('creates, de-duplicates (file and CRM) and attaches contacts across batch boundaries', async () => {
    const U = await registerUser();
    await U.agent.post('/api/carriers').send({ companyName: 'Already Here', dotNumber: '500003' });
    const rows = Array.from({ length: 600 }, (_, i) => `Carrier ${i},${500000 + i},,${i % 100 === 0 ? `Contact ${i}` : ''},${i === 7 ? 'Seven' : ''}`);
    rows.push('Duplicate In File,500010,,,'); // same USDOT as an earlier row
    rows.push(',,,,'); // no name, no USDOT
    const res = await U.agent.post('/api/carriers/import').attach('file', Buffer.from(csvOf(rows)), { filename: 'big.csv', contentType: 'text/csv' }).field('mode', 'skip');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 602, created: 599, skipped: 2, errorCount: 1 });
    expect(await prisma.carrier.count({ where: { ownerId: U.user.id } })).toBe(600);
    expect(await prisma.carrierContact.count({ where: { carrier: { ownerId: U.user.id } } })).toBe(6);
    const seven = await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '500007' }, include: { notes: true } });
    expect(seven.notes[0].body).toBe('Seven');
    const ids = await prisma.carrier.findMany({ where: { ownerId: U.user.id, source: 'csv' }, select: { id: true } });
    expect(ids.every((x) => /^c[0-9a-z]{24}$/.test(x.id))).toBe(true);

    // Update mode fills fields on existing rows and merges a later duplicate row into an earlier new one.
    const upd = csvOf(['Carrier 1,500001,(214) 555-0101,,', 'New One,599999,,,', 'New One Again,599999,(214) 555-0199,,']);
    const res2 = await U.agent.post('/api/carriers/import').attach('file', Buffer.from(upd), { filename: 'upd.csv', contentType: 'text/csv' }).field('mode', 'update');
    expect(res2.body).toMatchObject({ created: 1, updated: 2, skipped: 0 });
    expect((await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '500001' } })).phone).toBe('2145550101');
    expect((await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '599999' } })).phone).toBe('2145550199');
  });

  it('stops creating at the plan carrier limit and reports the rest', async () => {
    const V = await registerUser();
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    const lead = await stageId('lead');
    await prisma.carrier.createMany({ data: Array.from({ length: free.maxCarriers - 3 }, (_, i) => ({ ownerId: V.user.id, stageId: lead, companyName: `Fill ${i}` })) });
    const res = await V.agent.post('/api/carriers/import').attach('file', Buffer.from(csvOf(Array.from({ length: 5 }, (_, i) => `Limit ${i},${610000 + i},,,`))), { filename: 'l.csv', contentType: 'text/csv' });
    expect(res.body.created).toBe(3);
    expect(res.body.errors.filter((e) => /limit/.test(e.error))).toHaveLength(2);
  });
});
