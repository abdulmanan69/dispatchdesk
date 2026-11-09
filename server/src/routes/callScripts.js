import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, reqStr } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';

const r = Router();
r.use(requirePermission('crm.use'));

export const SCRIPT_CATEGORIES = ['cold_call', 'follow_up', 'voicemail', 'objection', 'onboarding', 'broker'];

const scriptSchema = z.object({
  name: reqStr(120),
  category: z.enum(SCRIPT_CATEGORIES).default('cold_call'),
  body: z.string().trim().min(1, 'Required').max(20000),
});

/** Original starter scripts. Merge fields: {{company}} {{first_name}} {{my_name}} {{mc}} {{city}} {{state}}. */
export const STARTER_SCRIPTS = [
  {
    name: 'Cold call: owner-operator intro',
    category: 'cold_call',
    body: `## Opening
Hi, is this {{first_name}} with {{company}}? This is {{my_name}}. I'm a truck dispatcher, and I saw your MC {{mc}} out of {{city}}, {{state}}. Do you have two minutes?

## Why I'm calling
I work with small fleets and owner-operators. I find and negotiate loads, handle broker calls and the paperwork, so you can stay focused on driving.

## Qualify
- What equipment are you running, and how many trucks?
- Which lanes do you like, and where do you want to be on weekends?
- How are you finding loads right now?
- What rate per mile do you need to make a load worth it?

## Next step
Based on that, I think I can help. Can I send you a short overview by email and call you back tomorrow at a time that suits you?

## If they're busy
No problem. When is a better time to catch you? I'll call back then.`,
  },
  {
    name: 'Voicemail drop',
    category: 'voicemail',
    body: `Hi {{first_name}}, this is {{my_name}}, a truck dispatcher. I'm calling about {{company}}, MC {{mc}}. I help owner-operators keep their trucks loaded on the lanes they choose, and I handle the broker calls and paperwork. Call me back when you have a minute. Thanks, and drive safe.

**Tip:** keep it under 25 seconds and say your number twice if you leave one.`,
  },
  {
    name: 'Follow-up after no answer',
    category: 'follow_up',
    body: `## Opening
Hi {{first_name}}, it's {{my_name}} again. I tried you earlier about dispatch for {{company}}. Is now a better time?

## Short reminder
I help carriers like you find loads, negotiate rates and handle broker paperwork. I only get paid when you get paid.

## Ask
Are you looking for a dispatcher right now, or should I check back later?

## Close
- **Interested:** schedule a 10-minute call to go over lanes and rates.
- **Not now:** ask when to follow up and note it.
- **Not interested:** thank them and mark the outcome.`,
  },
  {
    name: 'Objection: "I already have a dispatcher"',
    category: 'objection',
    body: `## Acknowledge
That's great. It means you know the value of having someone on the phones for you.

## Explore
- How's it going with them? Are you happy with the rates and the miles you're getting?
- Do they keep you on the lanes you want?
- Is there anything you wish they did better?

## Position
If things ever change, or you add a truck, I'd like to be your backup. Can I send my details and check in with you in a few weeks?

## Note
Log the current dispatcher's fee or any pain points you hear, and set a follow-up.`,
  },
  {
    name: 'Objection: "Your fee is too high"',
    category: 'objection',
    body: `## Acknowledge
I understand. Every percent matters when you're paying for fuel, insurance and the truck.

## Reframe
- What matters most to you: the fee or what you take home at the end of the week?
- If I can book loads at a better rate per mile than you're getting now, the fee pays for itself.
- I also handle broker setup, rate confirmations and paperwork, which saves you hours.

## Offer
Let's try one week. If you don't see the difference in your weekly gross, you can walk away.

## Note
Only promise what you can deliver. Do not quote rates you haven't confirmed with a broker.`,
  },
  {
    name: 'Onboarding call checklist',
    category: 'onboarding',
    body: `## Welcome
Thanks for choosing to work with me, {{first_name}}. Let's get {{company}} set up so I can start booking loads.

## Documents to collect
- Signed dispatch agreement
- W-9
- Certificate of insurance (COI), with me listed as certificate holder if required by your agent
- MC authority letter
- Factoring notice of assignment (NOA), if you use a factoring company

## Preferences to confirm
- Equipment type, length and any special equipment
- Preferred lanes, home time and states to avoid
- Minimum rate per mile and maximum deadhead
- Best phone number and hours to reach the driver

## Verify
Check the carrier's authority and insurance status with FMCSA before booking the first load.

## Next step
Confirm when the truck will be empty and where, so I can start looking.`,
  },
  {
    name: 'Broker rate negotiation call',
    category: 'broker',
    body: `## Opening
Hi, this is {{my_name}} calling for {{company}}, MC {{mc}}. I'm calling about your load from [origin] to [destination]. Is it still available?

## Details to confirm
- Pickup and delivery times, appointment or first-come
- Weight, commodity, and any special requirements
- Detention, layover and TONU terms
- Payment terms and quick-pay options

## Negotiate
- Ask first: what rate do you have on it?
- Counter with your number based on the all-in rate per mile, including deadhead.
- Give a reason: the deadhead, a tight appointment, or a weak backhaul market from the destination.
- Be ready to walk away below your carrier's minimum.

## Close
If we agree, send the rate confirmation to my email and I'll get the carrier packet back to you right away.`,
  },
];

r.get('/', ah(async (req, res) => {
  const items = await prisma.callScript.findMany({ where: { ownerId: req.user.id }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
  res.json({ items });
}));

r.get('/:id', ah(async (req, res) => {
  const script = await prisma.callScript.findFirst({ where: { id: String(req.params.id), ownerId: req.user.id } });
  if (!script) throw notFound('Script not found');
  res.json({ script });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(scriptSchema, req.body);
  const script = await prisma.callScript.create({ data: { ...body, ownerId: req.user.id } });
  res.status(201).json({ script });
}));

r.post('/starter', ah(async (req, res) => {
  const existing = new Set((await prisma.callScript.findMany({ where: { ownerId: req.user.id }, select: { name: true } })).map((s) => s.name));
  const toCreate = STARTER_SCRIPTS.filter((s) => !existing.has(s.name));
  for (const s of toCreate) await prisma.callScript.create({ data: { ...s, ownerId: req.user.id } });
  res.json({ created: toCreate.length, skipped: STARTER_SCRIPTS.length - toCreate.length });
}));

r.patch('/:id', ah(async (req, res) => {
  const script = await prisma.callScript.findFirst({ where: { id: String(req.params.id), ownerId: req.user.id } });
  if (!script) throw notFound('Script not found');
  const body = parse(scriptSchema.partial(), req.body);
  const data = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && k in req.body));
  const updated = await prisma.callScript.update({ where: { id: script.id }, data });
  res.json({ script: updated });
}));

r.delete('/:id', ah(async (req, res) => {
  const out = await prisma.callScript.deleteMany({ where: { id: String(req.params.id), ownerId: req.user.id } });
  if (!out.count) throw notFound('Script not found');
  res.json({ ok: true });
}));

export default r;
