import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, agent, prisma } from './helpers.js';
import { applyMerge, canonicalField, formatAppointment, mergeValues, renderContent, renderPreview } from '../src/services/email/render.js';
import { MAX_TEMPLATES, STARTER_EMAIL_TEMPLATES, STARTER_TEXT_TEMPLATES } from '../src/routes/templates.js';

async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: 'Red River Transport LLC', mcNumber: '1184420', dotNumber: '3561982', city: 'Shreveport', state: 'LA', phone: '3185550100', ...data } });
}

describe('merge engine', () => {
  it('normalizes aliases and spellings to canonical fields', () => {
    expect(canonicalField('sender_name')).toBe('my_name');
    expect(canonicalField('pickupCity')).toBe('pickup_city');
    expect(canonicalField('FIRST_NAME')).toBe('first_name');
    expect(canonicalField('companyName')).toBe('company');
    expect(canonicalField('statusLink')).toBe('track_link');
  });

  it('keeps older field names working', () => {
    const user = { name: 'Dana Ruiz', phone: '2145550101', email: 'dana@example.test' };
    const carrier = { companyName: 'Blue Line', mcNumber: '123', contacts: [{ name: 'Mike Ross', isPrimary: true }] };
    const out = renderContent({ subject: 'Loads for {{company}}', body: 'Hi {{first_name}}, {{sender_name}} here ({{sender_phone}}). {{typo_field}}', carrier, user });
    expect(out.subject).toBe('Loads for Blue Line');
    expect(out.body).toBe('Hi Mike, Dana Ruiz here ((214) 555-0101). {{typo_field}}');
    // No contact: "there"; missing base values render empty outside strict mode.
    const bare = renderContent({ subject: '', body: 'Hi {{first_name}} at {{company}} {{dot}}.', carrier: { companyName: 'X' }, user });
    expect(bare.body).toBe('Hi there at X .');
  });

  it('appends the saved signature to emails only when it is not placed', () => {
    const user = { name: 'Dana', emailSignature: 'Dana Ruiz\nRuiz Dispatch' };
    expect(renderContent({ subject: 's', body: 'Hello', user }).body).toBe('Hello\n\nDana Ruiz\nRuiz Dispatch');
    expect(renderContent({ subject: 's', body: 'Hello\n{{signature}}', user }).body).toBe('Hello\nDana Ruiz\nRuiz Dispatch');
    expect(renderContent({ subject: '', body: 'Hello', user, channel: 'sms' }).body).toBe('Hello');
    // Without a saved signature {{signature}} falls back to the sender's name.
    expect(renderContent({ subject: '', body: 'Thanks,\n{{signature}}', user: { name: 'Dana Ruiz' } }).body).toBe('Thanks,\nDana Ruiz');
  });

  it('never sends your own fields as raw tokens, but flags them in previews', () => {
    const user = { name: 'Dana Ruiz', email: 'dana@example.test' }; // no team, no phone
    expect(renderContent({ subject: '', body: 'Dana from {{my_company}} ({{my_phone}})', user, channel: 'sms' }).body).toBe('Dana from  ()');
    const preview = renderPreview({ subject: '', body: '{{my_first_name}} from {{my_company}}', channel: 'sms', user });
    expect(preview.body).toBe('Dana from {{my_company}}');
    expect(preview.unresolved).toEqual(['my_company']);
  });

  it('sends a known field with no value here as blank, never as a raw token; typos stay', () => {
    const out = renderContent({ subject: 'Load {{load_ref}}', body: 'Hi {{first_name}}, pickup {{pickup_city}}{{invoice_number}} {{compnay}}', user: { name: 'Dana' }, carrier: { companyName: 'X', contacts: [] } });
    expect(out.subject).toBe('Load ');
    expect(out.body).toBe('Hi there, pickup  {{compnay}}');
  });

  it('reports unresolved and unknown tokens in strict previews', () => {
    const out = renderPreview({ subject: 'Load {{load_ref}}', body: 'Hi {{first_name}}, {{pickup_city}} {{compnay}} {{my_phone}}', channel: 'email', user: { name: 'Dana' }, carrier: { companyName: 'X', contacts: [] } });
    expect(out.body).toBe('Hi there, {{pickup_city}} {{compnay}} {{my_phone}}');
    expect(out.unresolved.sort()).toEqual(['load_ref', 'my_phone', 'pickup_city']);
    expect(out.unknown).toEqual(['compnay']);
    expect(out.fallbacks).toEqual(['first_name']);
  });

  it('formats load fields in the facility time zone', () => {
    const load = {
      referenceNumber: 'SF-1', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', rateCents: 245000, loadedMiles: 812,
      pickupWindowStart: new Date('2026-11-11T14:00:00Z'), pickupWindowEnd: new Date('2026-11-11T16:00:00Z'), pickupTz: 'America/Chicago',
      deliveryDate: new Date('2026-11-12T18:00:00Z'), weightLbs: 38000, commodity: 'Produce',
    };
    const v = mergeValues({ load, user: { name: 'D' }, strict: true });
    expect(v.pickup_city).toBe('Dallas, TX');
    expect(v.pickup_date).toBe('Wed, Nov 11, 8:00 AM–10:00 AM CST');
    expect(v.delivery_date).toBe('Thu, Nov 12');
    expect(v.rate).toBe('$2,450');
    expect(v.rate_per_mile).toBe('$3.02/mi');
    expect(v.weight).toBe('38,000 lbs');
    expect(v.load_ref).toBe('SF-1');
    expect(formatAppointment(null, null, null, 'America/Chicago')).toBe('');
  });

  it('treats an explicit broker as the recipient even when the load has a carrier', () => {
    const load = { originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', carrier: { companyName: 'Carrier Co', mcNumber: '77', contacts: [{ name: 'Cal Driver' }] } };
    const v = mergeValues({ broker: { companyName: 'Broker Co', contactName: 'Ana Smith' }, load, user: {} });
    expect(v.company).toBe('Broker Co');
    expect(v.first_name).toBe('Ana');
    expect(v.carrier_company).toBe('Carrier Co');
    expect(v.carrier_mc).toBe('77');
    expect(applyMerge('{{broker_company}}', v)).toBe('Broker Co');
  });
});

describe('text templates', () => {
  let A; let B;
  beforeAll(async () => { A = await registerUser({ name: 'Dana Ruiz' }); B = await registerUser(); });

  it('requires authentication', async () => {
    const a = await agent();
    expect((await a.get('/api/templates/text')).status).toBe(401);
    expect((await a.post('/api/templates/render').send({ channel: 'sms', body: 'x' })).status).toBe(401);
  });

  it('creates, lists, updates and deletes text templates', async () => {
    const c = await A.agent.post('/api/templates/text').send({ name: 'Check call', body: 'Hi {{first_name}}, where are you?', category: 'driver' });
    expect(c.status).toBe(201);
    const id = c.body.template.id;
    expect(c.body.template).toMatchObject({ category: 'driver', useCount: 0, starterKey: null });
    const list = await A.agent.get('/api/templates/text');
    expect(list.body.items.map((t) => t.id)).toContain(id);
    expect((await A.agent.get('/api/templates/text?category=driver')).body.items).toHaveLength(1);
    expect((await A.agent.get('/api/templates/text?q=where')).body.items).toHaveLength(1);
    const u = await A.agent.patch(`/api/templates/text/${id}`).send({ name: 'Check call 2' });
    expect(u.status).toBe(200);
    expect(u.body.template).toMatchObject({ name: 'Check call 2', category: 'driver' }); // partial update keeps the category
    expect((await A.agent.get(`/api/templates/text/${id}`)).body.template.body).toBe('Hi {{first_name}}, where are you?');
    expect((await A.agent.delete(`/api/templates/text/${id}`)).status).toBe(200);
    expect((await A.agent.get(`/api/templates/text/${id}`)).status).toBe(404);
  });

  it('validates input', async () => {
    expect((await A.agent.post('/api/templates/text').send({ name: '', body: 'x' })).status).toBe(400);
    expect((await A.agent.post('/api/templates/text').send({ name: 'x', body: '' })).status).toBe(400);
    expect((await A.agent.post('/api/templates/text').send({ name: 'x', body: 'y', category: 'nope' })).status).toBe(400);
    expect((await A.agent.post('/api/templates/text').send({ name: 'x', body: 'y'.repeat(1001) })).status).toBe(400);
    expect((await A.agent.get('/api/templates/text?category=nope')).status).toBe(400);
    expect((await A.agent.post('/api/templates/render').send({ channel: 'fax', body: 'x' })).status).toBe(400);
    expect((await A.agent.post('/api/templates/render').send({ channel: 'sms' })).status).toBe(400);
    expect((await A.agent.post('/api/templates/render').send({ channel: 'sms', body: 'x', extra: { 'bad-key': 'v' } })).status).toBe(400);
  });

  it('isolates templates and render context between users (404)', async () => {
    const t = (await A.agent.post('/api/templates/text').send({ name: 'Private', body: 'secret {{company}}' })).body.template;
    expect((await B.agent.get(`/api/templates/text/${t.id}`)).status).toBe(404);
    expect((await B.agent.patch(`/api/templates/text/${t.id}`).send({ name: 'Hijack' })).status).toBe(404);
    expect((await B.agent.delete(`/api/templates/text/${t.id}`)).status).toBe(404);
    expect((await B.agent.post('/api/templates/duplicate').send({ channel: 'sms', id: t.id })).status).toBe(404);
    expect((await B.agent.post('/api/templates/render').send({ channel: 'sms', templateId: t.id })).status).toBe(404);
    expect((await B.agent.get('/api/templates/text')).body.items.find((x) => x.id === t.id)).toBeUndefined();

    const carrier = await makeCarrier(A.user.id);
    const broker = await prisma.broker.create({ data: { ownerId: A.user.id, companyName: 'Summit' } });
    const load = await prisma.load.create({ data: { ownerId: A.user.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 800, rateCents: 200000 } });
    for (const ref of [{ carrierId: carrier.id }, { brokerId: broker.id }, { loadId: load.id }]) {
      expect((await B.agent.post('/api/templates/render').send({ channel: 'sms', body: '{{company}}', ...ref })).status).toBe(404);
    }
    expect((await A.agent.post('/api/templates/render').send({ channel: 'sms', body: '{{company}}', carrierId: carrier.id })).body.body).toBe('Red River Transport LLC');
  });

  it('caps the number of templates per user', async () => {
    const u = await registerUser();
    await prisma.textTemplate.createMany({ data: Array.from({ length: MAX_TEMPLATES }, (_, i) => ({ ownerId: u.user.id, name: `T${i}`, body: 'x' })) });
    const res = await u.agent.post('/api/templates/text').send({ name: 'One more', body: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/up to 500/);
    const starter = await u.agent.post('/api/templates/starter').send({ channel: 'sms' });
    expect(starter.body).toMatchObject({ created: 0, limited: true });
  });
});

describe('starter packs', () => {
  it('installs each pack idempotently and keeps edited or deleted starters as the user left them', async () => {
    const { agent: a, user } = await registerUser();
    const before = await a.get('/api/templates/starter?channel=sms');
    expect(before.body).toMatchObject({ total: STARTER_TEXT_TEMPLATES.length, installed: 0 });
    const first = await a.post('/api/templates/starter').send({ channel: 'sms' });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(STARTER_TEXT_TEMPLATES.length);
    expect(STARTER_TEXT_TEMPLATES.length).toBeGreaterThanOrEqual(14);
    const again = await a.post('/api/templates/starter').send({ channel: 'text' });
    expect(again.body.created).toBe(0);

    const email = await a.post('/api/templates/starter').send({ channel: 'email' });
    expect(email.body.created).toBe(STARTER_EMAIL_TEMPLATES.length);
    expect(STARTER_EMAIL_TEMPLATES.length).toBeGreaterThanOrEqual(20);
    const emails = (await a.get('/api/email/templates')).body.items;
    expect(emails).toHaveLength(STARTER_EMAIL_TEMPLATES.length);
    expect(emails.find((t) => t.starterKey === 'packet_request').body).toMatch(/W-9/);

    // Edit one, delete another: re-installing restores only the deleted one and leaves the edit alone.
    const texts = (await a.get('/api/templates/text')).body.items;
    const edited = texts.find((t) => t.starterKey === 'check_call');
    await a.patch(`/api/templates/text/${edited.id}`).send({ body: 'My own check call text' });
    await a.delete(`/api/templates/text/${texts.find((t) => t.starterKey === 'eta_request').id}`);
    const restore = await a.post('/api/templates/starter').send({ channel: 'sms' });
    expect(restore.body.created).toBe(1);
    expect((await prisma.textTemplate.findUnique({ where: { id: edited.id } })).body).toBe('My own check call text');
    expect(await prisma.textTemplate.count({ where: { ownerId: user.id } })).toBe(STARTER_TEXT_TEMPLATES.length);
  });

  it('does not install twice when two requests race', async () => {
    const { agent: a, user } = await registerUser();
    const results = await Promise.all([a.post('/api/templates/starter').send({ channel: 'sms' }), a.post('/api/templates/starter').send({ channel: 'sms' })]);
    for (const r of results) expect([200, 409]).toContain(r.status);
    await a.post('/api/templates/starter').send({ channel: 'sms' });
    expect(await prisma.textTemplate.count({ where: { ownerId: user.id } })).toBe(STARTER_TEXT_TEMPLATES.length);
  });

  it('uses only original wording without exclamation marks', () => {
    for (const t of [...STARTER_EMAIL_TEMPLATES, ...STARTER_TEXT_TEMPLATES]) {
      expect(`${t.subject || ''} ${t.body}`).not.toMatch(/!/);
      expect(new Set([...STARTER_EMAIL_TEMPLATES, ...STARTER_TEXT_TEMPLATES].map((x) => x.key)).size).toBeGreaterThan(30);
    }
    for (const t of STARTER_TEXT_TEMPLATES) expect(t.body.length).toBeLessThanOrEqual(320);
    expect(STARTER_TEXT_TEMPLATES.find((t) => t.key === 'location_link').body).toMatch(/\{\{track_link\}\}/);
  });
});

describe('duplicate, usage and render', () => {
  let A; let carrier; let load; let broker;
  beforeAll(async () => {
    A = await registerUser({ name: 'Dana Ruiz' });
    await prisma.user.update({ where: { id: A.user.id }, data: { phone: '2145550101', emailSignature: 'Dana Ruiz\nRuiz Dispatch' } });
    carrier = await makeCarrier(A.user.id);
    await prisma.carrierContact.create({ data: { carrierId: carrier.id, name: 'Marcus Hill', isPrimary: true } });
    broker = await prisma.broker.create({ data: { ownerId: A.user.id, companyName: 'Summit Freight', contactName: 'Ana Lopez' } });
    load = await prisma.load.create({
      data: {
        ownerId: A.user.id, carrierId: carrier.id, brokerId: broker.id, referenceNumber: 'SF-48213', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA',
        loadedMiles: 812, rateCents: 245000, pickupWindowStart: new Date('2026-11-11T14:00:00Z'), pickupTz: 'America/Chicago',
      },
    });
  });

  it('duplicates email and text templates', async () => {
    const t = (await A.agent.post('/api/templates/text').send({ name: 'Load offer', body: 'Load {{pickup_city}}', category: 'carrier' })).body.template;
    const d = await A.agent.post('/api/templates/duplicate').send({ channel: 'sms', id: t.id });
    expect(d.status).toBe(201);
    expect(d.body.template).toMatchObject({ name: 'Load offer (copy)', body: 'Load {{pickup_city}}', category: 'carrier', useCount: 0 });
    const e = (await A.agent.post('/api/email/templates').send({ name: 'Intro', subject: 'Hi {{company}}', body: 'Hello', category: 'broker' })).body.template;
    const de = await A.agent.post('/api/templates/duplicate').send({ channel: 'email', id: e.id });
    expect(de.body.template).toMatchObject({ name: 'Intro (copy)', subject: 'Hi {{company}}', category: 'broker' });
  });

  it('reports how many sequence steps use an email template', async () => {
    const e = (await A.agent.post('/api/email/templates').send({ name: 'Seq', subject: 'S', body: 'B' })).body.template;
    const seq = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'Seq', steps: { create: [{ order: 0, dayOffset: 0, type: 'email', templateId: e.id }] } } });
    expect((await A.agent.get(`/api/templates/email/${e.id}/usage`)).body.sequenceSteps).toBe(1);
    const B = await registerUser();
    expect((await B.agent.get(`/api/templates/email/${e.id}/usage`)).status).toBe(404);
    await prisma.emailSequence.delete({ where: { id: seq.id } });
  });

  it('renders a text template for a carrier and counts a use only when picked', async () => {
    const t = (await A.agent.post('/api/templates/text').send({ name: 'Intro', body: 'Hi {{firstName}}, {{sender_name}} here about {{company}} (MC {{mc}}). Call {{my_phone}}. {{signature}}' })).body.template;
    const preview = await A.agent.post('/api/templates/render').send({ channel: 'sms', templateId: t.id, carrierId: carrier.id });
    expect(preview.status).toBe(200);
    expect(preview.body.body).toBe('Hi Marcus, Dana Ruiz here about Red River Transport LLC (MC 1184420). Call (214) 555-0101. ');
    expect(preview.body.subject).toBeUndefined();
    expect(preview.body.template).toMatchObject({ id: t.id, name: 'Intro' });
    expect((await prisma.textTemplate.findUnique({ where: { id: t.id } })).useCount).toBe(0);
    await A.agent.post('/api/templates/render').send({ channel: 'sms', templateId: t.id, carrierId: carrier.id, use: true });
    const after = await prisma.textTemplate.findUnique({ where: { id: t.id } });
    expect(after.useCount).toBe(1);
    expect(after.lastUsedAt).toBeTruthy();
  });

  it('renders load fields, the broker as recipient, extra values and unresolved tokens', async () => {
    const res = await A.agent.post('/api/templates/render').send({
      channel: 'email', loadId: load.id, brokerId: broker.id,
      subject: 'Rate con: {{pickup_city}} to {{delivery_city}}',
      body: 'Hi {{first_name}}, {{carrier_company}} (MC {{carrier_mc}}) on {{load_ref}} at {{rate}}, pickup {{pickup_date}}. Track: {{track_link}} {{invoice_number}}',
      extra: { track_link: 'https://example.test/t/abc' },
    });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('Rate con: Dallas, TX to Atlanta, GA');
    expect(res.body.body).toBe('Hi Ana, Red River Transport LLC (MC 1184420) on SF-48213 at $2,450, pickup Wed, Nov 11, 8:00 AM CST. Track: https://example.test/t/abc {{invoice_number}}');
    expect(res.body.unresolved).toEqual(['invoice_number']);
    expect(res.body.signature).toBe('Dana Ruiz\nRuiz Dispatch');
  });

  it('renders invoice fields for the invoice recipient', async () => {
    const inv = await prisma.invoice.create({ data: { ownerId: A.user.id, number: 1042, kind: 'dispatch_fee', carrierId: carrier.id, billToName: 'Red River', lines: '[]', amountCents: 24500, paidCents: 4500, dueAt: new Date('2026-11-24T18:00:00Z') } });
    const res = await A.agent.post('/api/templates/render').send({ channel: 'email', invoiceId: inv.id, subject: 'Invoice {{invoice_number}}', body: 'Hi {{first_name}}, {{amount_due}} due {{invoice_due_date}}' });
    expect(res.body.subject).toBe('Invoice 1042');
    expect(res.body.body).toBe('Hi Marcus, $200.00 due Nov 24, 2026');
    const B = await registerUser();
    expect((await B.agent.post('/api/templates/render').send({ channel: 'email', invoiceId: inv.id, body: 'x' })).status).toBe(404);
  });

  it('renders with sample data and fills my_email from the default mailbox', async () => {
    const res = await A.agent.post('/api/templates/render').send({ channel: 'email', sample: true, subject: '{{company}}', body: '{{pickup_city}} {{my_name}}' });
    expect(res.body).toMatchObject({ subject: 'Red River Transport LLC', body: 'Dallas, TX Dana Ruiz', unresolved: [], unknown: [] });
    const mail = await A.agent.post('/api/templates/render').send({ channel: 'sms', body: 'Email me at {{my_email}}' });
    expect(mail.body.body).toBe(`Email me at ${A.email}`);
  });

  it('serves the merge-field catalog', async () => {
    const res = await A.agent.get('/api/templates/fields');
    expect(res.status).toBe(200);
    const keys = res.body.fields.map((f) => f.key);
    for (const k of ['company', 'first_name', 'contact_name', 'mc', 'dot', 'city', 'state', 'my_name', 'my_company', 'my_phone', 'my_email', 'broker_company', 'load_ref', 'pickup_city', 'pickup_date', 'delivery_city', 'delivery_date', 'rate', 'track_link', 'invoice_number', 'amount_due']) {
      expect(keys).toContain(k);
    }
    expect(res.body.aliases.sender_name).toBe('my_name');
    // The email composer's field list uses the same canonical names.
    const legacy = await A.agent.get('/api/email/merge-fields');
    expect(Object.keys(legacy.body.fields)).toContain('my_name');
  });
});

describe('permissions', () => {
  it('keeps email templates behind the email permission', async () => {
    const crm = await prisma.permission.findUnique({ where: { key: 'crm.use' } });
    const role = await prisma.role.upsert({
      where: { key: 'test_crm_only' }, update: {},
      create: { key: 'test_crm_only', name: 'CRM only (test)', rank: 5, permissions: { create: [{ permissionId: crm.id }] } },
    });
    const { agent: a } = await registerUser({ role: role.key });
    expect((await a.post('/api/templates/starter').send({ channel: 'email' })).status).toBe(403);
    expect((await a.get('/api/templates/starter?channel=email')).status).toBe(403);
    expect((await a.post('/api/templates/render').send({ channel: 'email', subject: 's', body: 'b' })).status).toBe(403);
    expect((await a.post('/api/templates/render').send({ channel: 'sms', body: 'Hi {{my_name}}' })).status).toBe(200);
    expect((await a.post('/api/templates/starter').send({ channel: 'sms' })).status).toBe(200);
  });
});

describe('call outcomes', () => {
  it('accepts wrong number and do-not-call outcomes', async () => {
    const { agent: a, user } = await registerUser();
    const carrier = await makeCarrier(user.id, { mcNumber: '99001', dotNumber: '99002' });
    for (const outcome of ['wrong_number', 'do_not_call']) {
      const res = await a.post('/api/calls').send({ carrierId: carrier.id, outcome });
      expect(res.status).toBe(201);
      expect(res.body.call.outcome).toBe(outcome);
      expect(res.body.followUp).toBeNull();
    }
  });

  // The call modal and the power dialer skip their own do-not-call fallback when the response says doNotCall: true.
  it('do not call turns the flag on, stops sequences, cancels call follow-ups and reports doNotCall', async () => {
    const { agent: a, user } = await registerUser();
    const carrier = await makeCarrier(user.id, { mcNumber: '99003', dotNumber: '99004' });
    const seq = await prisma.emailSequence.create({ data: { ownerId: user.id, name: 'Intro', steps: { create: [{ order: 0, dayOffset: 0, type: 'call' }, { order: 1, dayOffset: 2, type: 'text', body: 'Hi' }] } } });
    const enr = await prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, carrierId: carrier.id, userId: user.id, nextStepAt: new Date() } });
    const later = await prisma.followUp.create({ data: { carrierId: carrier.id, userId: user.id, dueAt: new Date(Date.now() + 3 * 86400000), type: 'call' } });
    const res = await a.post('/api/calls').send({ carrierId: carrier.id, outcome: 'do_not_call', notes: 'Asked to be removed from the list' });
    expect(res.status).toBe(201);
    expect(res.body.doNotCall).toBe(true);
    expect(res.body.stage.key).toBe('lead'); // no "first call" stage move
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).doNotCall).toBe(true);
    expect(await prisma.sequenceEnrollment.findUnique({ where: { id: enr.id } })).toMatchObject({ status: 'stopped', stopReason: 'do_not_call', nextStepAt: null });
    expect((await prisma.followUp.findUnique({ where: { id: later.id } })).status).toBe('canceled');
    // Other outcomes do not report it.
    const other = await makeCarrier(user.id, { mcNumber: '99005', dotNumber: '99006' });
    expect((await a.post('/api/calls').send({ carrierId: other.id, outcome: 'voicemail' })).body.doNotCall).toBe(false);
  });

  it('wrong number stops sequences that would call or text the same number', async () => {
    const { agent: a, user } = await registerUser();
    const carrier = await makeCarrier(user.id, { mcNumber: '99007', dotNumber: '99008' });
    const phoneSeq = await prisma.emailSequence.create({ data: { ownerId: user.id, name: 'Calls', steps: { create: [{ order: 0, dayOffset: 0, type: 'call' }, { order: 1, dayOffset: 2, type: 'call' }] } } });
    const enr = await prisma.sequenceEnrollment.create({ data: { sequenceId: phoneSeq.id, carrierId: carrier.id, userId: user.id, nextStepAt: new Date() } });
    const res = await a.post('/api/calls').send({ carrierId: carrier.id, outcome: 'wrong_number' });
    expect(res.status).toBe(201);
    expect(res.body.doNotCall).toBe(false);
    expect(res.body.stage.key).toBe('lead');
    expect(await prisma.sequenceEnrollment.findUnique({ where: { id: enr.id } })).toMatchObject({ status: 'stopped', stopReason: 'wrong_number', currentStep: 0 });
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).doNotCall).toBe(false);
  });
});

describe('email template categories', () => {
  it('saves every template category for email too, and a partial edit keeps it', async () => {
    const { agent: a } = await registerUser();
    const res = await a.post('/api/email/templates').send({ name: 'Load details', subject: 'Load {{load_ref}}', body: 'Pickup {{pickup_address}}', category: 'driver' });
    expect(res.status).toBe(201);
    expect(res.body.template.category).toBe('driver');
    const edited = await a.patch(`/api/email/templates/${res.body.template.id}`).send({ name: 'Driver: load details' });
    expect(edited.status).toBe(200);
    expect(edited.body.template).toMatchObject({ name: 'Driver: load details', category: 'driver' });
    expect((await a.post('/api/email/templates').send({ name: 'X', subject: 'S', body: 'B', category: 'spam' })).status).toBe(400);
  });
});
