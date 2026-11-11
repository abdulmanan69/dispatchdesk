import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr } from '../lib/validate.js';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned } from '../lib/access.js';
import { withLock, LockBusyError } from '../lib/locks.js';
import { FIELDS, ALIASES, renderPreview, fieldsIn } from '../services/email/render.js';

/**
 * Template library.
 *   Text-message templates: CRUD here (/api/templates/text). Email templates: CRUD stays at /api/email/templates.
 *   Both channels: starter packs (POST /starter), duplicate, and POST /render, which fills merge fields from an
 *   owner-checked carrier / broker / load / invoice for previews and the template picker.
 * Nothing here sends a message: texts are copied and opened by the user, emails go through the composer.
 */
const r = Router();
r.use(requirePermission('crm.use'));

export const TEMPLATE_CATEGORIES = ['carrier', 'broker', 'driver', 'follow_up', 'other'];
/** Hard cap per user and channel so a script cannot grow the tables without bound. */
export const MAX_TEMPLATES = 500;

const channelSchema = z.enum(['email', 'sms', 'text']).transform((c) => (c === 'text' ? 'sms' : c));
const modelFor = (channel) => (channel === 'email' ? prisma.emailTemplate : prisma.textTemplate);

function requireEmail(req) {
  if (!hasPermission(req, 'email.use')) throw forbidden('Your role cannot use email templates');
}

async function ownTemplate(req, channel, id) {
  const t = await modelFor(channel).findFirst({ where: { id: String(id), ownerId: req.user.id } });
  if (!t) throw notFound('Template not found');
  return t;
}

async function assertRoom(channel, ownerId, adding = 1) {
  const count = await modelFor(channel).count({ where: { ownerId } });
  if (count + adding > MAX_TEMPLATES) throw badRequest(`You can keep up to ${MAX_TEMPLATES} ${channel === 'email' ? 'email' : 'text'} templates. Delete some to add more.`);
}

// ---------------------------------------------------------------------------
// Starter packs. Original wording; merge fields are filled when a template is used.
// Emails end with {{signature}} (your signature, or your name when you have none).
// ---------------------------------------------------------------------------
export const STARTER_EMAIL_TEMPLATES = [
  {
    key: 'carrier_new_authority', category: 'carrier', name: 'Outreach: new authority',
    subject: 'Dispatch help for {{company}}',
    body: `Hi {{first_name}},

I noticed {{company}} (MC {{mc}}) has a new authority. The first months can be slow: many brokers ask for a track record, and the better loads go fast.

I'm a truck dispatcher. I find and negotiate loads on the lanes you choose, set you up with brokers, and handle rate confirmations and paperwork, so you can focus on driving.

Do you have 10 minutes for a call this week? Reply with a time that works, or call me at {{my_phone}}.

Thanks,
{{signature}}`,
  },
  {
    key: 'carrier_small_fleet', category: 'carrier', name: 'Outreach: small fleet',
    subject: 'Keeping the trucks at {{company}} loaded',
    body: `Hi {{first_name}},

I'm a truck dispatcher working with small fleets. For each truck I handle the load search, rate negotiation, broker setup and paperwork, and I keep in touch with your drivers during each load.

If you have a truck waiting on freight, or a lane that keeps coming back empty, I'd like to show you what I can book for it.

Do you have time for a short call this week?

Thanks,
{{signature}}`,
  },
  {
    key: 'follow_up_1', category: 'follow_up', name: 'Follow-up 1: checking in',
    subject: 'Following up: dispatch for {{company}}',
    body: `Hi {{first_name}},

Following up on my note from a few days ago. I help carriers like {{company}} find better-paying loads and take the broker calls and paperwork off their plate.

Would a quick call this week work for you?

Thanks,
{{signature}}`,
  },
  {
    key: 'follow_up_2', category: 'follow_up', name: 'Follow-up 2: one question',
    subject: 'Quick question, {{first_name}}',
    body: `Hi {{first_name}},

One quick question: how are you finding loads right now?

If it's load boards and phone calls between drives, that's the part I take over. I search, negotiate and book, and you approve every load before it's booked.

Reply with a good time and I'll call you.

Thanks,
{{signature}}`,
  },
  {
    key: 'follow_up_3', category: 'follow_up', name: 'Follow-up 3: your lanes',
    subject: 'The lanes you want to run',
    body: `Hi {{first_name}},

If you tell me where you like to run and when you need to be home, I'll look at what's moving on those lanes and send you a few current examples with rates. No commitment.

Which lanes and equipment should I check?

Thanks,
{{signature}}`,
  },
  {
    key: 'break_up', category: 'follow_up', name: 'Break-up email',
    subject: 'Closing the loop',
    body: `Hi {{first_name}},

I've reached out a few times and haven't heard back, so I'll stop here. I don't want to fill your inbox.

If you ever need help finding loads or handling brokers, reply to this email and I'll pick it up from there.

All the best,
{{signature}}`,
  },
  {
    key: 'after_voicemail', category: 'follow_up', name: 'After voicemail',
    subject: 'Sorry I missed you, {{first_name}}',
    body: `Hi {{first_name}},

I just left you a voicemail. I'm a truck dispatcher and wanted to see if {{company}} could use help finding and booking loads.

You can reply here or call me back at {{my_phone}} when it suits you.

Thanks,
{{signature}}`,
  },
  {
    key: 'lanes_rates_info', category: 'carrier', name: 'How I work: lanes and fees',
    subject: 'How I work and what it costs',
    body: `Hi {{first_name}},

Thanks for the call. Here is a short summary of how I work:

- I search load boards and my broker contacts for loads on your lanes.
- I negotiate the rate and send you the details before booking. You decide on every load.
- I handle broker setup, rate confirmations and the paperwork after delivery.
- My fee is a percentage of each load's gross, charged only on loads I book.

To get started, send me your preferred lanes, your minimum rate per mile and your home time, and I'll start looking.

Thanks,
{{signature}}`,
  },
  {
    key: 'packet_request', category: 'carrier', name: 'Onboarding: documents request',
    subject: 'Documents to get {{company}} set up',
    body: `Hi {{first_name}},

To set you up with brokers, I need a few documents:

- W-9
- Certificate of insurance (COI)
- MC authority letter
- Notice of assignment (NOA) from your factoring company, if you use one

You can reply to this email with the files attached. Once I have them, I'll send your carrier packet to brokers so we can start booking.

Thanks,
{{signature}}`,
  },
  {
    key: 'agreement_sent', category: 'carrier', name: 'Onboarding: agreement attached',
    subject: 'Dispatch agreement for {{company}}',
    body: `Hi {{first_name}},

The dispatch agreement is attached. It covers my fee, how loads are approved, and how either of us can end the agreement.

Please read it, sign it and send it back. If anything is unclear, call me at {{my_phone}} and we'll go through it together.

Thanks,
{{signature}}`,
  },
  {
    key: 'welcome_aboard', category: 'carrier', name: 'Onboarding: welcome aboard',
    subject: 'Welcome aboard, {{company}}',
    body: `Hi {{first_name}},

Welcome aboard. Here is what happens next:

1. I send your carrier packet to the brokers on your lanes.
2. When the truck is empty, text or call me with the location and time.
3. I send you each load's details before booking, and the rate confirmation once it's booked.

Save my number: {{my_phone}}. I look forward to working with you.

Thanks,
{{signature}}`,
  },
  {
    key: 'settlement_cover', category: 'carrier', name: 'Weekly settlement statement',
    subject: 'Your weekly statement',
    body: `Hi {{first_name}},

Your statement for this week is attached. It lists each load I booked for {{company}}, the gross, and my dispatch fee.

Please check it against your records and let me know if anything doesn't match.

Thanks,
{{signature}}`,
  },
  {
    key: 'fee_invoice_reminder', category: 'carrier', name: 'Dispatch-fee invoice reminder',
    subject: 'Reminder: invoice {{invoice_number}}',
    body: `Hi {{first_name}},

A reminder that invoice {{invoice_number}} for dispatch services has a balance of {{amount_due}}, due {{invoice_due_date}}.

If you've already paid, thank you, and please ignore this note. If something on the invoice looks wrong, reply and I'll sort it out.

Thanks,
{{signature}}`,
  },
  {
    key: 'broker_load_inquiry', category: 'broker', name: 'Broker: load inquiry and rate request',
    subject: 'Load inquiry: {{pickup_city}} to {{delivery_city}}',
    body: `Hi {{first_name}},

I dispatch for {{carrier_company}}, MC {{carrier_mc}}. We have a truck that can cover your load from {{pickup_city}} to {{delivery_city}}.

Is it still available? If so, please send:

- Rate
- Pickup and delivery appointments
- Weight and commodity
- Detention, layover and TONU terms

Thanks,
{{signature}}`,
  },
  {
    key: 'rate_con_request', category: 'broker', name: 'Broker: rate confirmation request',
    subject: 'Rate confirmation: {{pickup_city}} to {{delivery_city}}',
    body: `Hi {{first_name}},

Thanks for booking {{carrier_company}} (MC {{carrier_mc}}) on the load from {{pickup_city}} to {{delivery_city}} at {{rate}}.

Please send the rate confirmation to this email. Once it's signed, I'll send the driver's name and phone number.

Thanks,
{{signature}}`,
  },
  {
    key: 'carrier_packet', category: 'broker', name: 'Broker: carrier packet',
    subject: 'Carrier packet: {{carrier_company}}, MC {{carrier_mc}}',
    body: `Hi {{first_name}},

Attached is the carrier packet for {{carrier_company}} (MC {{carrier_mc}}, USDOT {{carrier_dot}}): W-9, certificate of insurance, MC authority letter, and the notice of assignment if the carrier factors.

Please set the carrier up in your system, and let me know if you need anything else to complete the setup.

Thanks,
{{signature}}`,
  },
  {
    key: 'detention_notice', category: 'broker', name: 'Broker: detention notice',
    subject: 'Detention notice: load {{load_ref}}',
    body: `Hi {{first_name}},

Our driver arrived on time for the appointment on load {{load_ref}} ({{pickup_city}} to {{delivery_city}}) and is still waiting at the facility. The free time has passed, so detention is now accruing under the terms on the rate confirmation.

I'll send the in and out times from the signed BOL with the invoice. Please let me know if the facility gives you an updated time.

Thanks,
{{signature}}`,
  },
  {
    key: 'tonu_claim', category: 'broker', name: 'Broker: TONU claim',
    subject: 'TONU for load {{load_ref}}',
    body: `Hi {{first_name}},

Load {{load_ref}} from {{pickup_city}} to {{delivery_city}} was canceled after our truck was dispatched. Under the rate confirmation, we are requesting the truck ordered not used (TONU) payment.

Please send a revised rate confirmation for the TONU amount, and I'll send the invoice with the supporting details.

Thanks,
{{signature}}`,
  },
  {
    key: 'pod_invoice', category: 'broker', name: 'Broker: POD and invoice',
    subject: 'POD and invoice: load {{load_ref}}',
    body: `Hi {{first_name}},

Load {{load_ref}} from {{pickup_city}} to {{delivery_city}} was delivered. The signed proof of delivery and our invoice are attached.

Please confirm you received them and let me know the expected payment date.

Thanks,
{{signature}}`,
  },
  {
    key: 'quick_pay_request', category: 'broker', name: 'Broker: quick pay request',
    subject: 'Quick pay request: load {{load_ref}}',
    body: `Hi {{first_name}},

We'd like to use quick pay for load {{load_ref}} ({{pickup_city}} to {{delivery_city}}). The signed POD and the invoice are attached.

Please confirm the quick pay fee and when the payment will be sent.

Thanks,
{{signature}}`,
  },
  {
    key: 'driver_load_details', category: 'driver', name: 'Driver: load details',
    subject: 'Load {{load_ref}}: {{pickup_city}} to {{delivery_city}}',
    body: `Hi {{first_name}},

Here are the details for your next load.

Pickup: {{pickup_address}}
Appointment: {{pickup_date}}

Delivery: {{delivery_address}}
Appointment: {{delivery_date}}

Commodity: {{commodity}}, {{weight}}
Reference: {{load_ref}}

Please call me at {{my_phone}} when you're loaded and again after delivery, and send a photo of the signed BOL.

Thanks,
{{signature}}`,
  },
];

export const STARTER_TEXT_TEMPLATES = [
  { key: 'first_touch', category: 'carrier', name: 'First text after a call', body: 'Hi {{first_name}}, thanks for taking my call. This is {{my_name}}, the truck dispatcher. Save this number and text me your preferred lanes and the rate per mile you need.' },
  { key: 'voicemail_follow_up', category: 'follow_up', name: 'After voicemail', body: 'Hi {{first_name}}, this is {{my_name}}, a truck dispatcher. I just left you a voicemail about finding loads for {{company}}. Text or call me back when it suits you.' },
  { key: 'callback_confirm', category: 'follow_up', name: 'Call-back confirmation', body: 'Hi {{first_name}}, {{my_name}} here. I will call you back at the time we agreed. If that no longer works, reply with a better time.' },
  { key: 'truck_availability', category: 'carrier', name: 'When will you be empty', body: 'Hi {{first_name}}, where and when will you be empty next? Send me the city and time, and I will start looking for your next load.' },
  { key: 'load_offer', category: 'carrier', name: 'Load offer', body: 'Hi {{first_name}}, I have a load for you: {{pickup_city}} to {{delivery_city}}, pickup {{pickup_date}}, {{miles}} miles, {{rate}} ({{rate_per_mile}}). Do you want me to book it?' },
  { key: 'docs_needed', category: 'carrier', name: 'Documents needed', body: 'Hi {{first_name}}, to set you up with the broker I still need your W-9, certificate of insurance and MC authority letter. You can reply with photos or email them to {{my_email}}.' },
  { key: 'payment_sent', category: 'carrier', name: 'Broker payment sent', body: 'Hi {{first_name}}, the broker confirmed that payment for load {{load_ref}} was sent. It can take a few business days to show in your account or factoring portal.' },
  { key: 'rate_con_received', category: 'driver', name: 'Booked: rate con signed', body: 'Hi {{first_name}}, load {{load_ref}} is booked and the rate con is signed. Pickup {{pickup_date}} at {{pickup_address}}. Delivery {{delivery_date}} in {{delivery_city}}.' },
  { key: 'appointment_reminder', category: 'driver', name: 'Appointment reminder', body: 'Hi {{first_name}}, reminder: your pickup appointment for load {{load_ref}} is {{pickup_date}} at {{pickup_address}}. Let me know if anything changes.' },
  { key: 'location_link', category: 'driver', name: 'Location link', body: 'Hi {{first_name}}, here is the location link for load {{load_ref}}: {{track_link}} Open it on your phone and tap Start sharing my location. You can stop sharing at any time on the same page.' },
  { key: 'check_call', category: 'driver', name: 'Check call', body: 'Hi {{first_name}}, checking in on load {{load_ref}}. Where are you now, and are you still on time for delivery {{delivery_date}}?' },
  { key: 'eta_request', category: 'driver', name: 'ETA request', body: 'Hi {{first_name}}, what is your current ETA to {{delivery_city}} for load {{load_ref}}? I need to update the broker.' },
  { key: 'pod_photo', category: 'driver', name: 'POD photo request', body: 'Hi {{first_name}}, once load {{load_ref}} is delivered, please send a clear photo of every page of the signed POD. I need it to invoice the broker.' },
  { key: 'detention_started', category: 'broker', name: 'Detention started', body: 'Hi {{first_name}}, update on load {{load_ref}}: our driver is still waiting at the facility and the free time has passed, so detention has started. I will send the in and out times with the invoice.' },
  { key: 'delivery_confirmed', category: 'broker', name: 'Delivery confirmed', body: 'Hi {{first_name}}, load {{load_ref}} was delivered in {{delivery_city}}. I will email the signed POD and invoice shortly.' },
];

const packFor = (channel) => (channel === 'email' ? STARTER_EMAIL_TEMPLATES : STARTER_TEXT_TEMPLATES);

// ---------------------------------------------------------------------------
// Merge-field catalog and starter packs
// ---------------------------------------------------------------------------
r.get('/fields', (req, res) => {
  res.set('Cache-Control', 'private, max-age=3600');
  res.json({
    fields: FIELDS.map(({ key, group, label, sample, channels }) => ({ key, group, label, sample, channels: channels || ['email', 'sms'] })),
    groups: [
      { key: 'contact', label: 'Carrier or broker' },
      { key: 'you', label: 'You' },
      { key: 'load', label: 'Load' },
      { key: 'billing', label: 'Invoice' },
    ],
    aliases: ALIASES,
  });
});

r.get('/starter', ah(async (req, res) => {
  const { channel } = parse(z.object({ channel: channelSchema }), req.query);
  if (channel === 'email') requireEmail(req);
  const pack = packFor(channel);
  const installed = await modelFor(channel).count({ where: { ownerId: req.user.id, starterKey: { in: pack.map((s) => s.key) } } });
  res.json({ channel, total: pack.length, installed, items: pack.map(({ key, name, category }) => ({ key, name, category })) });
}));

/** Add the starter pack for one channel. Idempotent per starter key; edited or renamed starters are left alone. */
r.post('/starter', ah(async (req, res) => {
  const { channel } = parse(z.object({ channel: channelSchema }), req.body);
  if (channel === 'email') requireEmail(req);
  const pack = packFor(channel);
  const model = modelFor(channel);
  const ownerId = req.user.id;
  try {
    // Serialized per user and channel (across cluster workers) so a double click cannot install twice.
    const out = await withLock(`templates.starter.${ownerId}.${channel}`, 30000, async () => {
      const [existing, count] = await Promise.all([
        model.findMany({ where: { ownerId, starterKey: { in: pack.map((s) => s.key) } }, select: { starterKey: true } }),
        model.count({ where: { ownerId } }),
      ]);
      const have = new Set(existing.map((e) => e.starterKey));
      const missing = pack.filter((s) => !have.has(s.key));
      const toCreate = missing.slice(0, Math.max(0, MAX_TEMPLATES - count));
      if (toCreate.length) {
        await model.createMany({
          data: toCreate.map((s) => ({
            ownerId, name: s.name, category: s.category, body: s.body, starterKey: s.key,
            ...(channel === 'email' ? { subject: s.subject } : {}),
          })),
        });
      }
      return { created: toCreate.length, skipped: pack.length - toCreate.length, total: pack.length, limited: toCreate.length < missing.length };
    });
    res.json({ channel, ...out });
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('Starter templates are already being added. Try again in a moment.');
    throw err;
  }
}));

// ---------------------------------------------------------------------------
// Text-message templates
// ---------------------------------------------------------------------------
const textSchema = z.object({
  name: reqStr(120),
  body: z.string().trim().min(1, 'Required').max(1000, 'Keep text templates under 1,000 characters'),
  category: z.enum(TEMPLATE_CATEGORIES).default('carrier'),
});

r.get('/text', ah(async (req, res) => {
  const q = parse(z.object({ category: z.enum(TEMPLATE_CATEGORIES).optional(), q: optStr(100) }), req.query);
  const where = {
    ownerId: req.user.id,
    ...(q.category ? { category: q.category } : {}),
    ...(q.q ? { OR: [{ name: { contains: q.q } }, { body: { contains: q.q } }] } : {}),
  };
  const items = await prisma.textTemplate.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }], take: MAX_TEMPLATES });
  res.json({ items });
}));

r.get('/text/:id', ah(async (req, res) => {
  res.json({ template: await ownTemplate(req, 'sms', req.params.id) });
}));

r.post('/text', ah(async (req, res) => {
  const body = parse(textSchema, req.body);
  await assertRoom('sms', req.user.id);
  const template = await prisma.textTemplate.create({ data: { ...body, ownerId: req.user.id } });
  res.status(201).json({ template });
}));

r.patch('/text/:id', ah(async (req, res) => {
  const t = await ownTemplate(req, 'sms', req.params.id);
  const body = parse(textSchema.partial(), req.body);
  // Only fields the client sent: a partial update never resets the category to its default.
  const data = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && Object.prototype.hasOwnProperty.call(req.body || {}, k)));
  const template = await prisma.textTemplate.update({ where: { id: t.id }, data });
  res.json({ template });
}));

r.delete('/text/:id', ah(async (req, res) => {
  const out = await prisma.textTemplate.deleteMany({ where: { id: String(req.params.id), ownerId: req.user.id } });
  if (!out.count) throw notFound('Template not found');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Both channels
// ---------------------------------------------------------------------------
r.post('/duplicate', ah(async (req, res) => {
  const b = parse(z.object({ channel: channelSchema, id: reqStr(60) }), req.body);
  if (b.channel === 'email') requireEmail(req);
  const t = await ownTemplate(req, b.channel, b.id);
  await assertRoom(b.channel, req.user.id);
  const data = {
    ownerId: req.user.id, name: `${t.name} (copy)`.slice(0, 120), body: t.body, category: t.category,
    ...(b.channel === 'email' ? { subject: t.subject } : {}),
  };
  res.status(201).json({ template: await modelFor(b.channel).create({ data }) });
}));

/** How many sequence steps use an email template (shown before deleting it). */
r.get('/email/:id/usage', ah(async (req, res) => {
  requireEmail(req);
  const t = await ownTemplate(req, 'email', req.params.id);
  const sequenceSteps = await prisma.sequenceStep.count({ where: { templateId: t.id, sequence: { ownerId: req.user.id } } });
  res.json({ sequenceSteps });
}));

const extraSchema = z.record(
  z.string().regex(/^[A-Za-z_]{1,40}$/, 'Merge field names use letters and underscores'),
  z.union([z.string().max(1000), z.number()]).nullable(),
).refine((o) => Object.keys(o).length <= 30, 'Too many extra fields').optional();

const renderSchema = z.object({
  channel: channelSchema,
  templateId: optStr(60),
  subject: z.string().max(300).optional(),
  body: z.string().max(20000).optional(),
  carrierId: optStr(60),
  brokerId: optStr(60),
  loadId: optStr(60),
  invoiceId: optStr(60),
  extra: extraSchema,
  sample: z.boolean().optional(),
  use: z.boolean().optional(), // the template was picked into a message: count the use
});

const contactOrder = { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] };

/** Load only the records the request names, each through the tenant-isolation helpers (404 for others' records). */
async function renderContext(user, b, text) {
  const ctx = { user };
  if (b.carrierId) ctx.carrier = await loadCarrier(user, b.carrierId, { include: { contacts: contactOrder } });
  if (b.brokerId) ctx.broker = await loadOwned('broker', user, b.brokerId);
  if (b.loadId) ctx.load = await loadOwned('load', user, b.loadId, { include: { broker: true, carrier: { include: { contacts: contactOrder } } } });
  if (b.invoiceId) {
    const inv = await loadOwned('invoice', user, b.invoiceId, { include: { load: true, broker: true, carrier: { include: { contacts: contactOrder } } } });
    ctx.invoice = inv;
    // Who the invoice is addressed to: the broker for freight invoices, the carrier for dispatch-fee invoices.
    if (!ctx.carrier && !ctx.broker) {
      if (inv.kind === 'freight' && inv.broker) ctx.broker = inv.broker;
      else if (inv.carrier) ctx.carrier = inv.carrier;
      else if (inv.broker) ctx.broker = inv.broker;
    }
  }
  if (fieldsIn(text).has('my_email')) {
    ctx.account = await prisma.emailAccount.findFirst({
      where: { userId: user.id, status: 'connected' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { fromEmail: true },
    });
  }
  return ctx;
}

/**
 * Fill merge fields for a preview or the template picker.
 * { channel, templateId? | subject?/body?, carrierId?, brokerId?, loadId?, invoiceId?, extra?, sample?, use? }
 *   -> { subject?, body, signature, unresolved, unknown, fallbacks, template }
 * Tokens without a value stay visible and are listed, so the user can fill them before sending.
 */
r.post('/render', ah(async (req, res) => {
  const b = parse(renderSchema, req.body);
  if (b.channel === 'email') requireEmail(req);
  if (!b.templateId && b.body == null) throw badRequest('Choose a template or provide a message');
  const template = b.templateId ? await ownTemplate(req, b.channel, b.templateId) : null;
  const subject = b.channel === 'email' ? (b.subject ?? template?.subject ?? '') : '';
  const body = b.body ?? template?.body ?? '';
  const ctx = b.sample ? { user: req.user } : await renderContext(req.user, b, `${subject}\n${body}`);
  const out = renderPreview({ subject, body, channel: b.channel, sample: !!b.sample, extra: b.extra, ...ctx });
  if (template && b.use) {
    // Atomic increment: safe when several workers count uses at once.
    await modelFor(b.channel).updateMany({ where: { id: template.id, ownerId: req.user.id }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
  }
  res.json({ ...out, template: template ? { id: template.id, name: template.name, category: template.category } : null });
}));

export default r;
