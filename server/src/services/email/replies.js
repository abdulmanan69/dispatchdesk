import { prisma } from '../../db.js';
import { logActivity, notify } from '../../lib/activity.js';
import { normPhone } from '../carriers/normalize.js';
import { stopEnrollments, invalidateQueueCount } from '../sequenceEngine.js';
import { syncNextFollowUp } from '../../routes/followups.js';
import { onNegotiationReply } from '../negotiation/index.js';

/**
 * What happens when mail comes back to a user's mailbox (IMAP poller, services/email/imap.js) or when the user marks
 * an email as replied by hand (POST /api/email/messages/:id/replied). Every write is scoped to `user` (the mailbox
 * owner): carriers, emails and suppressions of other users are never touched.
 */

const short = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The user's carrier for an email address (carrier email, then contact email). */
export async function carrierForAddress(user, address) {
  const email = String(address || '').trim().toLowerCase();
  if (!email) return null;
  const select = { id: true, companyName: true, ownerId: true, assignedToId: true };
  const direct = await prisma.carrier.findFirst({ where: { ownerId: user.id, email }, select, orderBy: { updatedAt: 'desc' } });
  if (direct) return direct;
  const contact = await prisma.carrierContact.findFirst({ where: { email, carrier: { ownerId: user.id } }, select: { carrier: { select } } });
  return contact?.carrier || null;
}

/** The user's broker for an email address. */
export async function brokerForAddress(user, address) {
  const email = String(address || '').trim().toLowerCase();
  if (!email) return null;
  return prisma.broker.findFirst({ where: { ownerId: user.id, email }, select: { id: true, companyName: true } });
}

/**
 * Resolve many sender addresses at once (one query per table for a whole inbox batch, never one per message):
 * Map(address -> { carrier } | { broker }) for the user's carriers (email, then contact email) and brokers.
 */
export async function contactsForAddresses(user, addresses) {
  const list = [...new Set(addresses.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean))].slice(0, 300);
  const out = new Map();
  if (!list.length) return out;
  const select = { id: true, companyName: true, ownerId: true, assignedToId: true, email: true };
  for (const c of await prisma.carrier.findMany({ where: { ownerId: user.id, email: { in: list } }, select, orderBy: { updatedAt: 'desc' } })) {
    if (!out.has(c.email)) out.set(c.email, { carrier: c });
  }
  const noCarrier = list.filter((a) => !out.has(a));
  if (noCarrier.length) {
    const contacts = await prisma.carrierContact.findMany({ where: { email: { in: noCarrier }, carrier: { ownerId: user.id } }, select: { email: true, carrier: { select } } });
    for (const ct of contacts) if (ct.email && !out.has(ct.email.toLowerCase())) out.set(ct.email.toLowerCase(), { carrier: ct.carrier });
  }
  const left = list.filter((a) => !out.has(a));
  if (left.length) {
    for (const b of await prisma.broker.findMany({ where: { ownerId: user.id, email: { in: left } }, select: { id: true, companyName: true, email: true } })) {
      if (!out.has(b.email)) out.set(b.email, { broker: b });
    }
  }
  return out;
}

/**
 * A carrier or broker replied. Marks the email replied, stops the carrier's running sequences (stopReason 'replied'),
 * logs the activity, creates one "Reply from X" follow-up (already notified, so no second reminder) and notifies.
 * Auto-replies (out of office) are only logged: they do not stop anything.
 */
export async function recordReply({ user, email = null, carrierId = null, brokerId = null, fromEmail = null, subject = null, at = new Date(), auto = false, source = 'imap', carrier: checked = null, text = null }) {
  const cid = carrierId || email?.carrierId || null;
  const bid = brokerId || email?.brokerId || null;
  // `carrier` may be passed by a caller that already checked write access (a team lead marking a member's carrier).
  const carrier = checked
    ? { id: checked.id, companyName: checked.companyName }
    : cid ? await prisma.carrier.findFirst({ where: { id: cid, OR: [{ ownerId: user.id }, { assignedToId: user.id }] }, select: { id: true, companyName: true } }) : null;
  const broker = !carrier && bid ? await prisma.broker.findFirst({ where: { id: bid, ownerId: user.id }, select: { id: true, companyName: true } }) : null;
  const who = carrier?.companyName || broker?.companyName || fromEmail || 'contact';
  const meta = { emailId: email?.id ?? null, inbound: true, from: fromEmail, source };

  if (auto) {
    await logActivity(user, { type: 'email', carrierId: carrier?.id ?? null, summary: `Automatic reply from ${who}${subject ? `: ${short(subject)}` : ''}`, metadata: { ...meta, auto: true } });
    return { stopped: 0, auto: true };
  }
  if (email) await prisma.email.updateMany({ where: { id: email.id, userId: user.id, repliedAt: null }, data: { repliedAt: at } });
  const stopped = carrier ? (await stopEnrollments(carrier.id, 'replied')).count : 0;
  await logActivity(user, {
    type: 'email', carrierId: carrier?.id ?? null,
    summary: `Reply from ${who}${subject ? `: ${short(subject)}` : ''}${stopped ? ' (sequence stopped)' : ''}`,
    metadata: meta,
  });
  if (carrier) {
    const open = await prisma.followUp.findFirst({ where: { carrierId: carrier.id, userId: user.id, status: 'pending', type: 'email', title: { startsWith: 'Reply from' } }, select: { id: true } });
    if (!open) {
      await prisma.followUp.create({
        data: { carrierId: carrier.id, userId: user.id, dueAt: at, type: 'email', title: short(`Reply from ${who}`, 160), note: subject ? short(subject, 500) : null, notifiedAt: at },
      });
      await syncNextFollowUp(carrier.id);
    }
  }
  await notify(user.id, {
    type: 'email_reply', title: `Reply from ${who}`, body: subject ? short(subject, 300) : null,
    link: carrier ? `/app/carriers/${carrier.id}` : '/app/email?tab=replies',
  });
  invalidateQueueCount(user.id);
  // A reply to a rate negotiation email goes to the negotiation (read by the AI when `text` is given; never throws).
  if (email?.negotiationId) await onNegotiationReply({ user, email, fromEmail, subject, text, at });
  return { stopped, auto: false };
}

/**
 * A message bounced. Marks the original email, adds the address to the user's do-not-email list (reason 'bounced'),
 * flags the user's carriers with that address do-not-email, cancels scheduled emails to it and stops their sequences.
 * Requires the user's own sent `email`: a bounce notice anyone could forge must never suppress an address on its own.
 */
export async function recordBounce({ user, email = null, recipient, reason = null, at = new Date() }) {
  if (!email || email.userId !== user.id) return { suppressed: false };
  const address = String(recipient || email?.toEmail || '').trim().toLowerCase();
  if (!address) return { suppressed: false };
  const why = short(reason || 'Delivery failed', 300);
  if (email) await prisma.email.updateMany({ where: { id: email.id, userId: user.id, bouncedAt: null }, data: { bouncedAt: at, bounceReason: why } });
  await prisma.emailSuppression.upsert({
    where: { ownerId_email: { ownerId: user.id, email: address } },
    create: { ownerId: user.id, email: address, reason: 'bounced' },
    update: {},
  });
  const carriers = await prisma.carrier.findMany({ where: { ownerId: user.id, email: address }, select: { id: true, companyName: true }, take: 50 });
  if (carriers.length) await prisma.carrier.updateMany({ where: { id: { in: carriers.map((c) => c.id) } }, data: { doNotEmail: true } });
  await prisma.email.updateMany({ where: { userId: user.id, toEmail: address, status: 'scheduled' }, data: { status: 'canceled', error: 'Address bounced' } });
  for (const c of carriers) await stopEnrollments(c.id, 'bounced');
  const carrierId = email?.carrierId || carriers[0]?.id || null;
  await logActivity(user, { type: 'email', carrierId, summary: `Email to ${address} bounced: ${why}`, metadata: { emailId: email?.id ?? null, bounce: true } });
  await notify(user.id, {
    type: 'email_bounce', title: `Email to ${address} bounced`, body: `${why}. The address was added to your do-not-email list.`,
    link: carrierId ? `/app/carriers/${carrierId}` : '/app/email?tab=suppression',
  });
  return { suppressed: true, carriers: carriers.length };
}

/**
 * Google Voice notification email (missed call, voicemail or text) for the user's carrier with that phone number.
 * Logged as an activity only; nothing is ever sent back. Returns false when no carrier matches.
 */
export async function recordGoogleVoice({ user, kind, phone, name = null, text = null, at = new Date() }) {
  const p = normPhone(phone);
  if (!p) return false;
  const carrier = await prisma.carrier.findFirst({ where: { ownerId: user.id, phone: p }, select: { id: true, companyName: true } });
  if (!carrier) return false;
  const label = kind === 'voicemail' ? 'Voicemail' : kind === 'text' ? 'Text message' : 'Missed call';
  const pretty = `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
  await logActivity(user, {
    type: kind === 'text' ? 'text' : 'call', carrierId: carrier.id,
    summary: `Google Voice: ${label.toLowerCase()} from ${name ? `${short(name, 60)} ` : ''}${pretty}${text ? ` — ${short(text, 200)}` : ''}`,
    metadata: { source: 'google_voice', kind, inbound: true, at: at.toISOString() },
  });
  return true;
}
