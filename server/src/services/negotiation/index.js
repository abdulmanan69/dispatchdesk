import { prisma } from '../../db.js';
import { HttpError, badRequest, conflict, forbidden } from '../../lib/errors.js';
import { loadCarrier, loadOwned, readableOwnerIds } from '../../lib/access.js';
import { logActivity, notify } from '../../lib/activity.js';
import { withLock, LockBusyError } from '../../lib/locks.js';
import { assertLimit } from '../../lib/plans.js';
import { queueUserEmail } from '../email/compose.js';
import { pickAccount, blockedReason, deliverEmail } from '../email/index.js';
import { rulesForCarrier } from '../loads/fitCheck.js';
import { negotiationNumbers } from '../loads/fit.js';
import { laneStats } from '../loads/lanes.js';
import { CLOSED_STATUSES, OPEN_STATUSES, computeLimits, decide, insideLimits, lastExchange, pushHistory, usd } from './rules.js';
import { aiErrorOf, classifyReply, laneLabel, templateEmail, threadSubject, writeAnswer, writeCounter } from './ai.js';
import { commitBooking, prepareBooking } from './booking.js';

/**
 * Broker rate negotiation by email. The dispatcher always approves the final deal.
 *
 * State machine (Negotiation.status):
 *   draft         created; the opening counter (asks for the target) waits for the dispatcher's approval
 *   active        our last email went out; waiting for the broker
 *   needs_review  something waits for the dispatcher: a proposal (accept, counter, walk away, answer), a reply the
 *                 AI could not read, or no reply for 48 hours
 *   agreed | walked_away | canceled   closed (no more writes)
 *
 * Rules enforced here, never by the AI:
 *   - counters stay inside [floor, target]; the AI never moves the limits (only PATCH by the dispatcher does)
 *   - a broker accept, or any broker number at/above the floor -> needs_review with nextAction accept; never booked
 *     automatically
 *   - a broker number below the floor -> a new counter halfway between their number and our last counter (not below
 *     the floor) while rounds < maxRounds, else a walk-away proposal; a decline -> walk-away proposal
 *   - a question -> an answer email proposal
 *   - mode 'approve': every email is created as an Email with status 'review' and waits for approval
 *     mode 'auto': AI-written counters inside the limits go out at once (up to maxRounds); the opening email,
 *     acceptances, walk-aways and answers always wait for the dispatcher
 *   - every email carries negotiationId and aiGenerated; history records every step
 * Writes take a per-negotiation database lock (cluster safe). Only the negotiation's owner can act on it; team
 * members who can read the owner's data can view it.
 */

const LOCK_TTL_MS = 3 * 60_000;
const FAILED = ['failed', 'blocked'];
const STALE_MS = 48 * 3600_000;
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function parseJson(s, fallback) {
  if (s == null) return fallback;
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** Row with lane/history/nextAction parsed. */
export function hydrate(row) {
  if (!row) return null;
  return { ...row, lane: parseJson(row.lane, {}), history: parseJson(row.history, []), nextAction: parseJson(row.nextAction, null) };
}

async function save(neg, patch) {
  const data = { ...patch };
  if ('lane' in data) data.lane = JSON.stringify(data.lane || {});
  if ('history' in data) data.history = JSON.stringify(data.history || []);
  if ('nextAction' in data) data.nextAction = data.nextAction ? JSON.stringify(data.nextAction) : null;
  return hydrate(await prisma.negotiation.update({ where: { id: neg.id }, data }));
}

const linkOf = (neg) => `/app/brokers/${neg.brokerId}?negotiation=${neg.id}`;
const hasSent = (neg) => neg.history.some((h) => h.kind === 'sent');
/** Status when nothing is pending: the opening email was never sent -> draft, else the dispatcher's move. */
const idleStatus = (neg) => (hasSent(neg) ? 'needs_review' : 'draft');

function assertOpen(neg) {
  if (CLOSED_STATUSES.includes(neg.status)) throw conflict(`This negotiation is ${neg.status.replace(/_/g, ' ')}`);
}

// ---------------------------------------------------------------------------
// Access and locking
// ---------------------------------------------------------------------------

/** A negotiation the user may read (owner, or a team member who can see the owner's data); 404 otherwise. */
export async function readable(user, id) {
  return hydrate(await loadOwned('negotiation', user, id));
}

/** Run fn(neg) under the negotiation's lock, for its owner only, after syncing a proposal approved elsewhere. */
async function act(user, id, fn) {
  const row = await loadOwned('negotiation', user, id);
  if (row.ownerId !== user.id) throw forbidden('Only the dispatcher who started this negotiation can act on it');
  return withLock(`negotiation.${row.id}`, LOCK_TTL_MS, async () => {
    const neg = await syncProposal(hydrate(await prisma.negotiation.findUnique({ where: { id: row.id } })));
    return fn(neg);
  });
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

/** Subject for a follow-up email in the thread ("Re: " + the first email's subject). */
async function subjectFor(neg) {
  const first = await prisma.email.findFirst({ where: { negotiationId: neg.id, status: { not: 'canceled' } }, orderBy: { createdAt: 'asc' }, select: { subject: true } });
  return threadSubject(neg, first?.subject || null);
}

/** Store an email that waits for the dispatcher (Email status 'review'). Returns { emailId, emailError }. */
async function draftEmail(neg, user, { subject, body }) {
  try {
    const { email } = await queueUserEmail({
      user, toEmail: neg.toEmail, subject, body, brokerId: neg.brokerId, accountId: neg.emailAccountId || undefined,
      review: true, aiGenerated: true, negotiationId: neg.id,
    });
    return { emailId: email.id, emailError: null };
  } catch (err) {
    if (err instanceof HttpError && err.status < 500) return { emailId: null, emailError: err.message };
    throw err;
  }
}

/** Cancel an email that is still waiting for approval (a discarded or replaced proposal). */
async function discardEmail(neg, emailId) {
  if (!emailId) return;
  await prisma.email.updateMany({ where: { id: emailId, negotiationId: neg.id, status: 'review' }, data: { status: 'canceled', error: 'Replaced or discarded in the negotiation' } });
}

/**
 * Send an approved email: the waiting 'review' row (moved to scheduled and delivered, plan limit checked again), or a
 * new one. Returns { email, outcome, message } like queueUserEmail.
 */
async function sendEmail(neg, user, { emailId, subject, body }) {
  if (emailId) {
    const row = await prisma.email.findFirst({ where: { id: emailId, userId: user.id, negotiationId: neg.id } });
    if (row && row.status !== 'review') throw conflict('This email was already handled in the Email center. Reload the negotiation.');
    if (row) {
      await assertLimit(user, 'emailsToday');
      const blocked = await blockedReason(user.id, row.toEmail, null);
      if (blocked) throw badRequest(blocked);
      const claimed = await prisma.email.updateMany({ where: { id: row.id, status: 'review' }, data: { status: 'scheduled', scheduledAt: new Date(), subject, body } });
      if (!claimed.count) throw conflict('This email was already handled. Reload the negotiation.');
      return deliverEmail(row.id, { retry: false });
    }
  }
  return queueUserEmail({
    user, toEmail: neg.toEmail, subject, body, brokerId: neg.brokerId, accountId: neg.emailAccountId || undefined,
    sendNow: true, aiGenerated: true, negotiationId: neg.id,
  });
}

/** Columns after an email for `action` went out. */
function sentPatch(neg, action, email, { by = 'dispatcher', auto = false, note = null, now = new Date() } = {}) {
  const history = pushHistory(neg.history, {
    from: auto ? 'ai' : by, kind: 'sent', action: action.kind, cents: action.kind === 'counter' ? action.cents : undefined,
    emailId: email?.id, subject: short(email?.subject ?? action.subject, 200), auto: auto || undefined, note: note || undefined,
  }, { now });
  const patch = { nextAction: null, history };
  if (action.kind === 'counter') Object.assign(patch, { rounds: neg.rounds + 1, lastCounterCents: action.cents, status: 'active' });
  else if (action.kind === 'answer') patch.status = 'active';
  else if (action.kind === 'walk_away') patch.status = 'walked_away';
  return patch;
}

/**
 * A proposal email approved, edited or discarded outside this screen (the Email center's "Needs approval" list):
 * bring the negotiation in step before anything else reads or acts on it.
 */
async function syncProposal(neg) {
  const a = neg.nextAction;
  if (!a?.emailId || CLOSED_STATUSES.includes(neg.status)) return neg;
  const email = await prisma.email.findUnique({ where: { id: a.emailId }, select: { id: true, status: true, subject: true, body: true, error: true } });
  if (email?.status === 'review') return neg;
  if (email && ['scheduled', 'sending', 'sent'].includes(email.status)) {
    return save(neg, sentPatch(neg, { ...a, subject: email.subject, body: email.body }, email, { note: 'Approved in the Email center' }));
  }
  if (email?.status === 'failed') {
    return save(neg, {
      nextAction: { ...a, emailId: null },
      history: pushHistory(neg.history, { from: 'system', kind: 'note', text: `The email could not be sent: ${short(email.error || 'delivery failed', 200)}. Approve it again to retry.` }),
    });
  }
  return save(neg, {
    nextAction: null, status: idleStatus(neg),
    history: pushHistory(neg.history, { from: 'dispatcher', kind: 'rejected', action: a.kind, cents: a.cents, note: 'Discarded in the Email center' }),
  });
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * What the defaults are built from: the carrier's walk-away rate (its own rules and this lane's miles) and the
 * workspace's last-90-day average on the state pair (its own loads, not market data).
 */
export async function limitContext(user, { carrierId = null, lane = {} } = {}) {
  const out = { walkAwayCents: null, walkAwayBasis: null, rulesSet: false, laneAvgCents: null, laneSampleSize: 0, laneAvgRatePerMile: null };
  const miles = Number(lane.miles) || 0;
  if (carrierId) {
    const found = await rulesForCarrier(carrierId);
    if (found) {
      out.rulesSet = found.rules.minRatePerMile != null || found.rules.costPerMileCents != null;
      const n = negotiationNumbers({ loadedMiles: miles, deadheadMiles: Number(lane.deadheadMiles) || 0 }, found.rules);
      out.walkAwayCents = n.walkAwayCents;
      out.walkAwayBasis = n.walkAwayBasis;
    }
  }
  if (/^[A-Z]{2}$/.test(lane.originState || '') && /^[A-Z]{2}$/.test(lane.destState || '')) {
    const stats = await laneStats(await readableOwnerIds(user, 'team'), lane.originState, lane.destState, { days: 90 });
    out.laneSampleSize = stats.sampleSize;
    out.laneAvgRatePerMile = stats.avgRatePerMile;
    if (stats.sampleSize > 0 && stats.avgRatePerMile != null && miles > 0) out.laneAvgCents = Math.round(stats.avgRatePerMile * miles * 100);
  }
  return out;
}

const LANE_KEYS = ['originCity', 'originState', 'destCity', 'destState', 'pickupDate', 'deliveryDate', 'equipment', 'weightLbs', 'miles', 'deadheadMiles', 'commodity', 'reference'];
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Lane facts: the load's (when one is linked), with anything the dispatcher typed on top. */
export function buildLane(input = {}, load = null) {
  const base = load ? {
    originCity: load.originCity, originState: load.originState, destCity: load.destCity, destState: load.destState,
    pickupDate: ymd(load.pickupDate), deliveryDate: ymd(load.deliveryDate), equipment: load.equipment, weightLbs: load.weightLbs,
    miles: load.loadedMiles, deadheadMiles: load.deadheadMiles, commodity: load.commodity, reference: load.referenceNumber,
  } : {};
  const lane = {};
  for (const k of LANE_KEYS) {
    const v = input?.[k] !== undefined && input?.[k] !== null && input?.[k] !== '' ? input[k] : base[k];
    if (v !== undefined && v !== null && v !== '') lane[k] = v;
  }
  return lane;
}

/** Defaults for the start form (nothing is saved). */
export async function previewLimits(user, { carrierId = null, loadId = null, lane: laneIn = {}, offerCents = null, targetCents = null, floorCents = null } = {}) {
  const load = loadId ? await loadOwned('load', user, loadId) : null;
  const cid = carrierId ?? load?.carrierId ?? null;
  if (cid) await loadCarrier(user, cid);
  const lane = buildLane(laneIn, load);
  const offer = offerCents ?? (load?.rateCents > 0 ? load.rateCents : null);
  const ctx = await limitContext(user, { carrierId: cid, lane });
  const limits = computeLimits({ offerCents: offer, targetCents, floorCents, walkAwayCents: ctx.walkAwayCents, laneAvgCents: ctx.laneAvgCents });
  return { ...ctx, offerCents: offer, lane, ...(limits.error ? { error: limits.error } : limits) };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Start a negotiation and draft the opening email (asks for the target; waits for approval in both modes).
 * input: { brokerId?, carrierId?, loadId?, lane?, offerCents?, targetCents?, floorCents?, mode, maxRounds, toEmail?, accountId? }
 * Returns { negotiation, email, aiError?, note?, limits }.
 */
export async function startNegotiation(user, input, { allowAi = true, now = new Date() } = {}) {
  let load = null;
  if (input.loadId) {
    load = await loadOwned('load', user, input.loadId, { write: true });
    const open = await prisma.negotiation.findFirst({ where: { loadId: load.id, status: { in: OPEN_STATUSES } }, select: { id: true } });
    if (open) throw conflict('This load already has an open negotiation', { code: 'NEGOTIATION_OPEN', negotiationId: open.id });
  }
  const brokerId = input.brokerId || load?.brokerId;
  if (!brokerId) throw badRequest('Pick the broker to negotiate with');
  const broker = await loadOwned('broker', user, brokerId);
  const carrierId = input.carrierId !== undefined ? input.carrierId : load?.carrierId ?? null;
  if (carrierId) await loadCarrier(user, carrierId);
  const lane = buildLane(input.lane, load);
  if (!lane.originCity || !lane.originState || !lane.destCity || !lane.destState) throw badRequest('Add the pickup and delivery city and state');
  const toEmail = String(input.toEmail || broker.email || '').trim().toLowerCase();
  if (!toEmail) throw badRequest("Add the broker's email address first");
  const account = await pickAccount(user.id, input.accountId || undefined);
  if (!account) throw badRequest('Connect a mailbox first (Email → Mailboxes)');
  const blocked = await blockedReason(user.id, toEmail, null);
  if (blocked) throw badRequest(blocked);

  const offerCents = input.offerCents !== undefined ? input.offerCents : load?.rateCents > 0 ? load.rateCents : null;
  const ctx = await limitContext(user, { carrierId, lane });
  const limits = computeLimits({ offerCents, targetCents: input.targetCents ?? null, floorCents: input.floorCents ?? null, walkAwayCents: ctx.walkAwayCents, laneAvgCents: ctx.laneAvgCents });
  if (limits.error) throw badRequest(limits.error);

  const mode = input.mode || 'approve';
  const maxRounds = input.maxRounds ?? 3;
  const history = pushHistory([], {
    from: 'dispatcher', kind: 'start', cents: offerCents ?? undefined,
    text: `Offer ${offerCents != null ? usd(offerCents) : 'unknown'}, target ${usd(limits.targetCents)}, walk-away ${usd(limits.floorCents)}${limits.floorBasis === 'carrier_rules' ? ' (from carrier rules)' : ''}. ${mode === 'auto' ? 'Counters inside the limits go out automatically' : 'Every email waits for approval'}.`,
  }, { now });
  let neg = hydrate(await prisma.negotiation.create({
    data: {
      ownerId: user.id, brokerId, carrierId: carrierId || null, loadId: load?.id ?? null, emailAccountId: account.id, toEmail,
      status: 'draft', mode, lane: JSON.stringify(lane), offerCents, targetCents: limits.targetCents, floorCents: limits.floorCents,
      maxRounds, history: JSON.stringify(history),
    },
  }));

  const draft = await writeCounter({ user, neg, broker, cents: neg.targetCents, first: true, adjust: true, subject: null, allowAi });
  const subject = draft.subject || threadSubject(neg);
  const { emailId, emailError } = await draftEmail(neg, user, { subject, body: draft.body });
  neg = await save(neg, {
    nextAction: { kind: 'counter', cents: draft.cents, subject, body: draft.body, emailId, aiWritten: draft.aiWritten, reason: 'Opening email: asks for your target', createdAt: now.toISOString() },
    history: withAiNotes(pushHistory(neg.history, { from: draft.aiWritten ? 'ai' : 'system', kind: 'proposal', action: 'counter', cents: draft.cents, emailId }, { now }), draft, emailError),
  });
  await logActivity(user, { type: 'email', summary: `Started a rate negotiation with ${broker.companyName}: ${laneLabel(lane)}`, metadata: { negotiationId: neg.id } });
  const email = emailId ? await prisma.email.findUnique({ where: { id: emailId }, select: EMAIL_SELECT }) : null;
  return { negotiation: neg, email, aiError: draft.aiError || null, note: draft.note || emailError || null, limits: { ...limits, ...ctx } };
}

/** History notes for an AI fallback or an email that could not be stored. */
function withAiNotes(history, draft, emailError) {
  let h = history;
  if (draft?.aiError) h = pushHistory(h, { from: 'system', kind: 'ai_error', code: draft.aiError.code, text: `AI unavailable (${draft.aiError.message}). A standard message was drafted instead.` });
  if (draft?.note) h = pushHistory(h, { from: 'system', kind: 'note', text: draft.note });
  if (emailError) h = pushHistory(h, { from: 'system', kind: 'note', text: `The email could not be prepared: ${emailError}` });
  return h;
}

// ---------------------------------------------------------------------------
// Broker replies
// ---------------------------------------------------------------------------

/**
 * Apply a broker reply (pasted, or received by email with its text) under the lock. With `intent` the dispatcher
 * classified it by hand (no AI). Returns { negotiation, aiError, autoSent }.
 */
async function processReply(neg, user, { text = null, intent = null, cents = null, source = 'paste', allowAi = true, now = new Date() }) {
  let cls = null;
  let aiError = null;
  if (intent) cls = { intent, cents: cents ?? null, summary: '', manual: true };
  else if (text && allowAi) {
    try {
      cls = await classifyReply({ user, neg, text });
    } catch (err) {
      aiError = aiErrorOf(err);
    }
  } else if (text) aiError = { code: 'AI_NOT_ALLOWED', status: 403, message: 'Your role cannot use the AI' };

  let history = pushHistory(neg.history, {
    from: 'broker', kind: 'reply', source, text: text ? String(text).slice(0, 4000) : undefined,
    intent: cls?.intent, cents: cls?.cents ?? undefined, summary: cls?.summary || undefined, manual: cls?.manual || undefined,
  }, { now });
  if (neg.nextAction) {
    await discardEmail(neg, neg.nextAction.emailId);
    history = pushHistory(history, { from: 'system', kind: 'note', text: 'The waiting proposal was replaced after the broker replied' }, { now });
  }
  const patch = { nextAction: null, status: 'needs_review' };
  if (cls?.cents != null && ['accept', 'counter'].includes(cls.intent)) patch.offerCents = cls.cents;
  if (!cls) {
    history = pushHistory(history, { from: 'system', kind: aiError ? 'ai_error' : 'note', code: aiError?.code, text: aiError ? `The AI could not read the reply (${aiError.message}). Tell us what they said: accept, a counter with their rate, or a decline.` : 'Reply recorded' }, { now });
    return { negotiation: await save(neg, { ...patch, history }), aiError, autoSent: false };
  }

  const state = { ...neg, ...patch, history };
  const d = decide({
    intent: cls.intent, cents: cls.cents, floorCents: neg.floorCents, targetCents: neg.targetCents,
    lastCounterCents: neg.lastCounterCents, offerCents: neg.offerCents, rounds: neg.rounds, maxRounds: neg.maxRounds,
  });
  const broker = await prisma.broker.findUnique({ where: { id: neg.brokerId }, select: { companyName: true, contactName: true } });
  const at = now.toISOString();

  if (d.kind === 'accept') {
    patch.nextAction = { kind: 'accept', cents: d.cents, reason: d.reason, createdAt: at };
    history = pushHistory(history, { from: 'system', kind: 'proposal', action: 'accept', cents: d.cents }, { now });
    return { negotiation: await save(neg, { ...patch, history }), aiError, autoSent: false };
  }
  if (d.kind === 'review') {
    history = pushHistory(history, { from: 'system', kind: 'note', text: d.reason }, { now });
    return { negotiation: await save(neg, { ...patch, history }), aiError, autoSent: false };
  }

  const subject = await subjectFor(neg);
  let draft;
  if (d.kind === 'counter') draft = await writeCounter({ user, neg: state, broker, cents: d.cents, subject, allowAi, theirCents: d.theirCents });
  else if (d.kind === 'answer') draft = await writeAnswer({ user, neg: state, broker, question: text || cls.summary, subject, allowAi });
  else draft = { subject, body: templateEmail('walk_away', state, { broker }), aiWritten: false };
  const action = {
    kind: d.kind, cents: d.kind === 'counter' ? d.cents : undefined, subject: draft.subject || subject, body: draft.body, aiWritten: draft.aiWritten,
    reason: d.kind === 'walk_away' ? (d.reason === 'rounds' ? `Their offer is below your walk-away and all ${neg.maxRounds} rounds are used` : 'The broker declined') : d.reason,
    createdAt: at,
  };
  history = withAiNotes(history, draft, null);

  // Auto mode: an AI-written counter strictly inside the limits goes out now. Everything else waits.
  const auto = neg.mode === 'auto' && d.kind === 'counter' && draft.aiWritten && insideLimits(d.cents, neg.floorCents, neg.targetCents) && neg.rounds < neg.maxRounds;
  if (auto) {
    try {
      const r = await sendEmail(state, user, { emailId: null, subject: action.subject, body: action.body });
      if (!FAILED.includes(r.outcome)) {
        const sent = sentPatch({ ...state, history }, action, r.email, { auto: true, now });
        return { negotiation: await save(neg, { ...patch, ...sent }), aiError, autoSent: true };
      }
      history = pushHistory(history, { from: 'system', kind: 'note', text: `The automatic counter was not sent: ${short(r.message, 200)}. It waits for your approval.` }, { now });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      history = pushHistory(history, { from: 'system', kind: 'note', text: `The automatic counter was not sent: ${short(err.message, 200)}. It waits for your approval.` }, { now });
    }
  }
  const { emailId, emailError } = await draftEmail(state, user, { subject: action.subject, body: action.body });
  patch.nextAction = { ...action, emailId };
  history = pushHistory(history, { from: draft.aiWritten ? 'ai' : 'system', kind: 'proposal', action: d.kind, cents: action.cents, emailId }, { now });
  if (emailError) history = pushHistory(history, { from: 'system', kind: 'note', text: `The email could not be prepared: ${emailError}` }, { now });
  return { negotiation: await save(neg, { ...patch, history }), aiError, autoSent: false };
}

/** POST /:id/reply: a reply the dispatcher pasted (text) or classified by hand (intent, cents). */
export async function pasteReply(user, id, { text = null, intent = null, cents = null }, { allowAi = true } = {}) {
  return act(user, id, async (neg) => {
    assertOpen(neg);
    return processReply(neg, user, { text, intent, cents, source: 'paste', allowAi });
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Hook from services/email/replies.js: a reply arrived to one of this negotiation's emails (IMAP reply detection).
 * With the reply text it is read like a pasted reply; without it (the poller reads headers only) the negotiation
 * is marked for review and the dispatcher is asked to paste the reply. Never throws (reply recording goes on).
 */
export async function onNegotiationReply({ user, email, subject = null, text = null, at = new Date() }) {
  try {
    if (!email?.negotiationId || !user?.id) return null;
    const row = await prisma.negotiation.findFirst({ where: { id: email.negotiationId, ownerId: user.id }, select: { id: true, status: true, brokerId: true } });
    if (!row || CLOSED_STATUSES.includes(row.status)) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withLock(`negotiation.${row.id}`, LOCK_TTL_MS, async () => {
          const neg = await syncProposal(hydrate(await prisma.negotiation.findUnique({ where: { id: row.id } })));
          if (!neg || CLOSED_STATUSES.includes(neg.status)) return null;
          if (text) {
            const out = await processReply(neg, user, { text, source: 'email', now: at });
            await notifyReply(out.negotiation, out.autoSent);
            return out;
          }
          const saved = await save(neg, {
            status: 'needs_review',
            history: pushHistory(neg.history, { from: 'broker', kind: 'reply', source: 'email', text: subject ? `Subject: ${short(subject, 200)}` : undefined, noBody: true }, { now: at }),
          });
          await notifyReply(saved, false, true);
          return { negotiation: saved, autoSent: false };
        });
      } catch (err) {
        if (!(err instanceof LockBusyError)) throw err;
        await sleep(1000 * (attempt + 1));
      }
    }
    await notify(user.id, { type: 'email_reply', title: 'A broker replied in a rate negotiation', body: 'Open the negotiation and paste their reply.', link: linkOf(row) });
    return null;
  } catch (err) {
    console.error(`[negotiation] reply for email ${email?.id} could not be applied: ${err.message}`);
    return null;
  }
}

async function notifyReply(neg, autoSent, needsPaste = false) {
  const broker = await prisma.broker.findUnique({ where: { id: neg.brokerId }, select: { companyName: true } });
  const who = broker?.companyName || 'The broker';
  const lane = laneLabel(neg.lane);
  const a = neg.nextAction;
  const title = autoSent
    ? `Counter of ${usd(neg.lastCounterCents)} sent to ${who}`
    : needsPaste ? `${who} replied in your rate negotiation`
      : a?.kind === 'accept' ? `${who} is at ${usd(a.cents)}: review and book`
        : a ? `${who} replied: a ${a.kind.replace(/_/g, ' ')} is ready for your approval` : `${who} replied in your rate negotiation`;
  const body = autoSent ? `${lane}. Sent automatically inside your limits.` : needsPaste ? `${lane}. Paste their reply so the AI can read it.` : `${lane}.`;
  await notify(neg.ownerId, { type: 'email_reply', title, body, link: linkOf(neg) });
}

// ---------------------------------------------------------------------------
// Dispatcher actions
// ---------------------------------------------------------------------------

/**
 * Send the waiting proposal, optionally edited ({ subject, body, cents }). A counter's cents must stay inside
 * [floor, target]. An 'accept' proposal books (same as accept-book).
 */
export async function approve(user, id, edits = {}) {
  return act(user, id, async (neg) => {
    assertOpen(neg);
    const a = neg.nextAction;
    if (!a) throw conflict('Nothing is waiting for your approval');
    if (a.kind === 'accept') return acceptBookLocked(neg, user, { ...edits, cents: edits.cents ?? a.cents });
    let { subject, body } = a;
    let cents = a.cents;
    if (a.kind === 'counter') {
      if (edits.cents != null && edits.cents !== a.cents) {
        if (edits.body == null && body) body = body.split(usd(a.cents)).join(usd(edits.cents));
        cents = edits.cents;
      }
      if (!insideLimits(cents, neg.floorCents, neg.targetCents)) {
        throw badRequest(`Keep the counter between ${usd(neg.floorCents)} and ${usd(neg.targetCents)}, or change your limits first`);
      }
      if (neg.rounds >= neg.maxRounds) throw badRequest(`All ${neg.maxRounds} rounds are used. Raise the number of rounds first.`);
    }
    if (edits.subject != null) subject = edits.subject;
    if (edits.body != null) body = edits.body;
    if (!String(subject || '').trim() || !String(body || '').trim()) throw badRequest('The email needs a subject and a message');
    const action = { ...a, cents, subject, body };
    const r = await sendEmail(neg, user, action);
    if (FAILED.includes(r.outcome)) {
      await save(neg, {
        nextAction: { ...action, emailId: null },
        history: pushHistory(neg.history, { from: 'system', kind: 'note', text: `The email was not sent: ${short(r.message, 200)}` }),
      });
      throw badRequest(`The email was not sent: ${r.message}`);
    }
    const saved = await save(neg, sentPatch(neg, action, r.email, { note: edits.subject != null || edits.body != null || cents !== a.cents ? 'Edited before sending' : null }));
    return { negotiation: saved, email: pick(r.email), outcome: r.outcome };
  });
}

/** Discard the waiting proposal (its email is canceled; nothing is sent). */
export async function rejectProposal(user, id) {
  return act(user, id, async (neg) => {
    assertOpen(neg);
    const a = neg.nextAction;
    if (!a) throw conflict('Nothing is waiting for your approval');
    await discardEmail(neg, a.emailId);
    return {
      negotiation: await save(neg, {
        nextAction: null, status: idleStatus(neg),
        history: pushHistory(neg.history, { from: 'dispatcher', kind: 'rejected', action: a.kind, cents: a.cents }),
      }),
    };
  });
}

/** Draft a counter at a number the dispatcher picks (inside the limits); it waits for approval like any proposal. */
export async function proposeCounter(user, id, { cents }, { allowAi = true } = {}) {
  return act(user, id, async (neg) => {
    assertOpen(neg);
    if (!insideLimits(cents, neg.floorCents, neg.targetCents)) throw badRequest(`Keep the counter between ${usd(neg.floorCents)} and ${usd(neg.targetCents)}, or change your limits first`);
    if (neg.rounds >= neg.maxRounds) throw badRequest(`All ${neg.maxRounds} rounds are used. Raise the number of rounds first.`);
    if (neg.nextAction) await discardEmail(neg, neg.nextAction.emailId);
    const broker = await prisma.broker.findUnique({ where: { id: neg.brokerId }, select: { companyName: true, contactName: true } });
    const first = !hasSent(neg);
    const subject = first ? null : await subjectFor(neg);
    const draft = await writeCounter({ user, neg, broker, cents, first, subject, allowAi });
    const finalSubject = draft.subject || threadSubject(neg);
    const { emailId, emailError } = await draftEmail(neg, user, { subject: finalSubject, body: draft.body });
    const saved = await save(neg, {
      status: first ? 'draft' : 'needs_review',
      nextAction: { kind: 'counter', cents, subject: finalSubject, body: draft.body, emailId, aiWritten: draft.aiWritten, reason: 'Counter you asked for', createdAt: new Date().toISOString() },
      history: withAiNotes(pushHistory(neg.history, { from: 'dispatcher', kind: 'proposal', action: 'counter', cents, emailId }), draft, emailError),
    });
    return { negotiation: saved, aiError: draft.aiError || null };
  });
}

/** PATCH: mode, target, walk-away (floor) and rounds. A waiting counter outside the new limits is discarded. */
export async function updateNegotiation(user, id, body) {
  return act(user, id, async (neg) => {
    assertOpen(neg);
    const next = {
      mode: body.mode ?? neg.mode,
      targetCents: body.targetCents ?? neg.targetCents,
      floorCents: body.floorCents ?? neg.floorCents,
      maxRounds: body.maxRounds ?? neg.maxRounds,
    };
    if (next.floorCents <= 0) throw badRequest('The walk-away rate must be above zero');
    if (next.floorCents > next.targetCents) throw badRequest('The walk-away rate cannot be above the target');
    const changes = [];
    if (next.mode !== neg.mode) changes.push(next.mode === 'auto' ? 'counters inside the limits now go out automatically' : 'every email now waits for approval');
    if (next.targetCents !== neg.targetCents) changes.push(`target ${usd(neg.targetCents)} to ${usd(next.targetCents)}`);
    if (next.floorCents !== neg.floorCents) changes.push(`walk-away ${usd(neg.floorCents)} to ${usd(next.floorCents)}`);
    if (next.maxRounds !== neg.maxRounds) changes.push(`rounds ${neg.maxRounds} to ${next.maxRounds}`);
    if (!changes.length) return { negotiation: neg };
    let history = pushHistory(neg.history, { from: 'dispatcher', kind: 'limits', text: `Changed ${changes.join(', ')}` });
    const patch = { ...next };
    const a = neg.nextAction;
    if (a?.kind === 'counter' && !insideLimits(a.cents, next.floorCents, next.targetCents)) {
      await discardEmail(neg, a.emailId);
      patch.nextAction = null;
      patch.status = idleStatus(neg);
      history = pushHistory(history, { from: 'system', kind: 'note', text: `The waiting counter of ${usd(a.cents)} is outside the new limits and was discarded` });
    }
    if (a?.kind === 'accept' && a.cents < next.floorCents) {
      patch.nextAction = null;
      patch.status = 'needs_review';
      history = pushHistory(history, { from: 'system', kind: 'note', text: `${usd(a.cents)} is now below your walk-away rate` });
    }
    return { negotiation: await save(neg, { ...patch, history }) };
  });
}

/**
 * Accept & book (the dispatcher's click is the approval): validates the booking, creates or updates the Load
 * (booked, agreed rate, broker, carrier, lane), sends a short confirmation email, and closes as 'agreed'.
 * body: { cents?, sendEmail = true, subject?, body?, loadedMiles? }
 */
export async function acceptBook(user, id, body = {}) {
  return act(user, id, (neg) => acceptBookLocked(neg, user, body));
}

async function acceptBookLocked(neg, user, opts = {}) {
  assertOpen(neg);
  const a = neg.nextAction;
  const cents = opts.cents ?? (a?.kind === 'accept' ? a.cents : neg.offerCents);
  if (!Number.isInteger(cents) || cents <= 0) throw badRequest('Enter the agreed rate');
  if (cents < neg.floorCents) {
    throw badRequest(`${usd(cents)} is below your walk-away rate of ${usd(neg.floorCents)}. Lower the walk-away first if you want to accept it.`);
  }
  const plan = await prepareBooking(user, neg, cents, { loadedMiles: opts.loadedMiles });
  const load = await commitBooking(user, plan, { negotiationId: neg.id });
  if (a?.emailId) await discardEmail(neg, a.emailId);
  let history = pushHistory(neg.history, { from: 'dispatcher', kind: 'agreed', cents, loadId: load.id });
  let email = null;
  let emailError = null;
  if (opts.sendEmail !== false) {
    const broker = await prisma.broker.findUnique({ where: { id: neg.brokerId }, select: { companyName: true, contactName: true } });
    const subject = opts.subject || await subjectFor(neg);
    const text = opts.body || templateEmail('confirm', neg, { broker, cents });
    try {
      const r = await sendEmail(neg, user, { emailId: null, subject, body: text });
      email = pick(r.email);
      if (FAILED.includes(r.outcome)) emailError = r.message;
      else history = pushHistory(history, { from: 'dispatcher', kind: 'sent', action: 'confirm', cents, emailId: r.email?.id, subject: short(subject, 200) });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      emailError = err.message;
    }
    if (emailError) history = pushHistory(history, { from: 'system', kind: 'note', text: `The confirmation email was not sent: ${short(emailError, 200)}` });
  }
  const saved = await save(neg, { status: 'agreed', agreedCents: cents, loadId: load.id, nextAction: null, history });
  return {
    negotiation: saved,
    load: { id: load.id, status: load.status, rateCents: load.rateCents, brokerId: load.brokerId, carrierId: load.carrierId, referenceNumber: load.referenceNumber },
    email, emailError,
  };
}

/** Walk away; with sendEmail a polite note goes to the broker (the waiting walk-away draft, edited or not). */
export async function walkAway(user, id, { sendEmail: send = false, subject = null, body = null } = {}) {
  return act(user, id, async (neg) => {
    assertOpen(neg);
    const a = neg.nextAction;
    const own = a?.kind === 'walk_away' ? a : null;
    let history = neg.history;
    let email = null;
    let emailError = null;
    if (send) {
      const broker = await prisma.broker.findUnique({ where: { id: neg.brokerId }, select: { companyName: true, contactName: true } });
      const action = {
        kind: 'walk_away', emailId: own?.emailId || null,
        subject: subject || own?.subject || await subjectFor(neg),
        body: body || own?.body || templateEmail('walk_away', neg, { broker }),
      };
      try {
        const r = await sendEmail(neg, user, action);
        email = pick(r.email);
        if (FAILED.includes(r.outcome)) emailError = r.message;
        else history = pushHistory(history, { from: 'dispatcher', kind: 'sent', action: 'walk_away', emailId: r.email?.id, subject: short(action.subject, 200) });
      } catch (err) {
        if (!(err instanceof HttpError) || err.status >= 500) throw err;
        emailError = err.message;
      }
      if (emailError) history = pushHistory(history, { from: 'system', kind: 'note', text: `The email was not sent: ${short(emailError, 200)}` });
    }
    if (a?.emailId && !(send && own)) await discardEmail(neg, a.emailId);
    history = pushHistory(history, { from: 'dispatcher', kind: 'walked_away' });
    return { negotiation: await save(neg, { status: 'walked_away', nextAction: null, history }), email, emailError };
  });
}

/** Cancel without emailing the broker. */
export async function cancelNegotiation(user, id) {
  return act(user, id, async (neg) => {
    assertOpen(neg);
    if (neg.nextAction?.emailId) await discardEmail(neg, neg.nextAction.emailId);
    return { negotiation: await save(neg, { status: 'canceled', nextAction: null, history: pushHistory(neg.history, { from: 'dispatcher', kind: 'canceled' }) }) };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const EMAIL_SELECT = { id: true, subject: true, body: true, status: true, toEmail: true, sentAt: true, createdAt: true, repliedAt: true, aiGenerated: true, error: true };
const pick = (e) => (e ? Object.fromEntries(Object.keys(EMAIL_SELECT).map((k) => [k, e[k] ?? null])) : null);

/** API shape: parsed JSON columns, broker and carrier names, whether this user can act on it. */
export function negotiationView(neg, { user = null, broker = null, carrier = null } = {}) {
  const { owner: _o, ...rest } = neg; // eslint-disable-line no-unused-vars
  const { sentAt, replyAt } = lastExchange(neg.history);
  return {
    ...rest,
    broker: broker || neg.broker || null,
    carrier: carrier || neg.carrier || null,
    lastSentAt: sentAt,
    lastReplyAt: replyAt,
    canWrite: user ? neg.ownerId === user.id && !CLOSED_STATUSES.includes(neg.status) : false,
  };
}

/** GET /:id: the negotiation (synced with the Email center for its owner) and its emails. */
export async function getNegotiation(user, id) {
  let neg = await readable(user, id);
  if (neg.ownerId === user.id && neg.nextAction?.emailId && !CLOSED_STATUSES.includes(neg.status)) {
    neg = await withLock(`negotiation.${neg.id}`, LOCK_TTL_MS, async () => syncProposal(hydrate(await prisma.negotiation.findUnique({ where: { id } }))))
      .catch((err) => { if (err instanceof LockBusyError) return neg; throw err; });
  }
  const [broker, carrier, emails] = await Promise.all([
    prisma.broker.findUnique({ where: { id: neg.brokerId }, select: { id: true, companyName: true, contactName: true, email: true } }),
    neg.carrierId ? prisma.carrier.findUnique({ where: { id: neg.carrierId }, select: { id: true, companyName: true } }) : null,
    prisma.email.findMany({ where: { negotiationId: neg.id, userId: neg.ownerId }, orderBy: { createdAt: 'asc' }, take: 100, select: EMAIL_SELECT }),
  ]);
  return { negotiation: negotiationView(neg, { user, broker, carrier }), emails };
}

// ---------------------------------------------------------------------------
// Stale negotiations (job)
// ---------------------------------------------------------------------------

/**
 * Active negotiations with no broker reply for 48 hours since our last email: marked needs_review with a "no reply"
 * note, and the owner is notified once (the status change keeps the next run from picking it again). Bounded batch.
 */
export async function runStaleNegotiations(now = new Date(), { batch = 200, staleMs = STALE_MS } = {}) {
  const cutoff = new Date(now.getTime() - staleMs);
  const rows = await prisma.negotiation.findMany({
    where: { status: 'active', updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: batch,
    include: { broker: { select: { companyName: true } } },
  });
  let marked = 0;
  for (const row of rows) {
    const neg = hydrate(row);
    const { sentAt, replyAt } = lastExchange(neg.history);
    const since = sentAt ? new Date(sentAt) : row.updatedAt;
    if (now.getTime() - since.getTime() < staleMs) continue;
    if (replyAt && sentAt && replyAt >= sentAt) continue;
    const history = pushHistory(neg.history, { from: 'system', kind: 'no_reply', text: `No reply from the broker in ${Math.round(staleMs / 3600_000)} hours` }, { now });
    const res = await prisma.negotiation.updateMany({
      where: { id: row.id, status: 'active', updatedAt: row.updatedAt },
      data: { status: 'needs_review', history: JSON.stringify(history) },
    });
    if (!res.count) continue;
    marked += 1;
    await notify(row.ownerId, {
      type: 'negotiation',
      title: `No reply from ${row.broker?.companyName || 'the broker'} in 2 days`,
      body: `${laneLabel(neg.lane)}: follow up, change your offer or walk away.`,
      link: linkOf(neg),
    });
  }
  return { checked: rows.length, marked };
}
