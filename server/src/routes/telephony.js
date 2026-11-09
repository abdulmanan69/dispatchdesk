import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, notFound, HttpError } from '../lib/errors.js';
import { parse, z, optStr } from '../lib/validate.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/activity.js';
import { loadCarrier } from '../lib/access.js';
import { callWindow, timezoneForState } from '../lib/timezones.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { PROVIDERS, PROVIDER_KEYS, providerByKey, buildLink, validateTemplate } from '../services/telephony/providers.js';
import { toE164, toNational, prettyPhone } from '../services/telephony/phone.js';
import {
  createBridgeCall, fetchAccount, endCall, bridgeTwiml, verifySignature, PARENT_STATUS, DIAL_STATUS,
} from '../services/telephony/twilio.js';
import { now } from '../services/telephony/clock.js';
import { logCall } from '../services/calls.js';

const r = Router();
const auth = [requireAuth, requirePermission('crm.use')];

const FINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'canceled']);

async function getSettings(userId) {
  return (await prisma.callSettings.findUnique({ where: { userId } }))
    || { userId, provider: 'tel', autoOpenLog: true, autoAdvance: true, enforceCallingHours: true, autoLogUnanswered: true };
}

function publicSettings(s) {
  return {
    provider: s.provider,
    configured: !!s.id,
    urlTemplate: s.urlTemplate ?? null,
    myNumber: s.myNumber ?? null,
    callerId: s.callerId ?? null,
    twilioAccountSid: s.twilioAccountSid ?? null,
    twilioAuthTokenSet: !!s.twilioAuthTokenEnc,
    autoOpenLog: s.autoOpenLog ?? true,
    autoAdvance: s.autoAdvance ?? true,
    enforceCallingHours: s.enforceCallingHours ?? true,
    autoLogUnanswered: s.autoLogUnanswered ?? true,
    defaultScriptId: s.defaultScriptId ?? null,
    webhookBase: `${config.appUrl}/api/telephony/twilio`,
    webhookPublic: /^https:\/\//.test(config.appUrl) && !/localhost|127\.0\.0\.1/.test(config.appUrl),
  };
}

const carrierSummary = { id: true, companyName: true, phone: true, doNotCall: true, state: true, timezone: true, ownerId: true, assignedToId: true, stageId: true };

function serializeAttempt(a) {
  return {
    id: a.id, provider: a.provider, toNumber: a.toNumber, toPretty: prettyPhone(a.toNumber), status: a.status,
    answeredAt: a.answeredAt, endedAt: a.endedAt, durationSec: a.durationSec, error: a.error,
    callId: a.callId, createdAt: a.createdAt, carrier: a.carrier ?? null,
  };
}

// ---------------------------------------------------------------------------- catalog & settings

r.get('/providers', auth, (req, res) => {
  res.json({ items: PROVIDERS });
});

r.get('/settings', auth, ah(async (req, res) => {
  res.json({ settings: publicSettings(await getSettings(req.user.id)) });
}));

const e164Field = z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(32).nullable().optional())
  .refine((v) => v == null || toE164(v), 'Enter a full phone number, e.g. +1 555 123 4567');

r.put('/settings', auth, ah(async (req, res) => {
  const body = parse(z.object({
    provider: z.enum(PROVIDER_KEYS),
    urlTemplate: optStr(500),
    myNumber: e164Field,
    callerId: e164Field,
    twilioAccountSid: z.preprocess((v) => (v === '' ? null : v), z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'Account SID starts with AC followed by 32 characters').nullable().optional()),
    twilioAuthToken: z.string().trim().max(128).optional(), // empty = keep the stored token
    clearTwilioAuthToken: z.boolean().optional(),
    autoOpenLog: z.boolean().optional(),
    autoAdvance: z.boolean().optional(),
    enforceCallingHours: z.boolean().optional(),
    autoLogUnanswered: z.boolean().optional(),
    defaultScriptId: optStr(40),
  }), req.body);

  const existing = await prisma.callSettings.findUnique({ where: { userId: req.user.id } });
  if (['custom', 'sip'].includes(body.provider)) validateTemplate(body.urlTemplate);

  const data = {
    provider: body.provider,
    urlTemplate: body.urlTemplate ?? null,
    myNumber: body.myNumber ? toE164(body.myNumber) : body.myNumber === null ? null : existing?.myNumber ?? null,
    callerId: body.callerId ? toE164(body.callerId) : body.callerId === null ? null : existing?.callerId ?? null,
    twilioAccountSid: body.twilioAccountSid !== undefined ? body.twilioAccountSid : existing?.twilioAccountSid ?? null,
    ...(body.autoOpenLog !== undefined ? { autoOpenLog: body.autoOpenLog } : {}),
    ...(body.autoAdvance !== undefined ? { autoAdvance: body.autoAdvance } : {}),
    ...(body.enforceCallingHours !== undefined ? { enforceCallingHours: body.enforceCallingHours } : {}),
    ...(body.autoLogUnanswered !== undefined ? { autoLogUnanswered: body.autoLogUnanswered } : {}),
    ...(body.defaultScriptId !== undefined ? { defaultScriptId: body.defaultScriptId } : {}),
  };
  if (body.clearTwilioAuthToken) data.twilioAuthTokenEnc = null;
  else if (body.twilioAuthToken) data.twilioAuthTokenEnc = encrypt(body.twilioAuthToken);

  if (body.provider === 'twilio') {
    const tokenSet = data.twilioAuthTokenEnc !== undefined ? !!data.twilioAuthTokenEnc : !!existing?.twilioAuthTokenEnc;
    const missing = [!data.twilioAccountSid && 'Account SID', !tokenSet && 'Auth Token', !data.callerId && 'caller ID', !data.myNumber && 'your phone number'].filter(Boolean);
    if (missing.length) throw badRequest(`Twilio needs: ${missing.join(', ')}`);
  }

  const saved = await prisma.callSettings.upsert({ where: { userId: req.user.id }, create: { userId: req.user.id, ...data }, update: data });
  await audit(req, 'telephony.settings_updated', { details: { provider: saved.provider, twilioTokenChanged: !!(body.twilioAuthToken || body.clearTwilioAuthToken) } });
  res.json({ settings: publicSettings(saved) });
}));

/** Real check for Twilio credentials; for link providers, show the link that would open. */
r.post('/settings/test', auth, ah(async (req, res) => {
  const s = await getSettings(req.user.id);
  if (s.provider !== 'twilio') {
    const sample = '+15555550123';
    let url;
    try { url = buildLink(s.provider, sample, s); } catch (err) { return res.json({ ok: false, message: err.message }); }
    return res.json({ ok: true, kind: 'link', message: `${providerByKey(s.provider)?.label} will open this link for each call. Nothing is dialed by the server.`, example: url });
  }
  if (!s.twilioAccountSid || !s.twilioAuthTokenEnc) return res.json({ ok: false, message: 'Enter your Twilio Account SID and Auth Token first' });
  try {
    const acct = await fetchAccount({ sid: s.twilioAccountSid, token: decrypt(s.twilioAuthTokenEnc) });
    const ok = acct.status === 'active';
    res.json({ ok, kind: 'bridge', message: ok ? `Connected to Twilio account “${acct.friendly_name}”` : `Twilio account status is ${acct.status}`, webhookPublic: publicSettings(s).webhookPublic });
  } catch (err) {
    res.json({ ok: false, kind: 'bridge', message: err.message });
  }
}));

// ---------------------------------------------------------------------------- dialing

r.post('/dial', auth, ah(async (req, res) => {
  const body = parse(z.object({ carrierId: optStr(40), phone: optStr(40), force: z.boolean().default(false) }), req.body);
  if (!body.carrierId && !body.phone) throw badRequest('Choose a carrier or enter a phone number');
  const settings = await getSettings(req.user.id);

  let carrier = null;
  if (body.carrierId) {
    carrier = await loadCarrier(req.user, body.carrierId);
  } else {
    const national = toNational(body.phone);
    if (national) {
      carrier = await prisma.carrier.findFirst({
        where: { phone: national, OR: [{ ownerId: req.user.id }, { assignedToId: req.user.id }] },
        orderBy: { updatedAt: 'desc' },
      });
    }
  }

  const to = toE164(body.phone || carrier?.phone);
  if (!to) throw new HttpError(422, carrier && !carrier.phone ? 'This carrier has no phone number' : 'That phone number is not valid', { code: 'invalid_number' });
  if (carrier?.doNotCall) throw new HttpError(409, `${carrier.companyName} is marked do-not-call`, { code: 'dnc' });

  const tz = carrier ? carrier.timezone || timezoneForState(carrier.state) : null;
  if (settings.enforceCallingHours && tz && !body.force) {
    const w = callWindow(tz, now());
    if (!w.callable) {
      throw new HttpError(422, `It is ${w.localTime} ${w.localWeekday} for ${carrier.companyName}. ${w.recommendation}`, { code: 'outside_hours', window: w });
    }
  }

  const provider = settings.provider || 'tel';
  if (provider === 'twilio') {
    if (!settings.twilioAccountSid || !settings.twilioAuthTokenEnc || !settings.callerId || !settings.myNumber) {
      throw new HttpError(422, 'Twilio calling is not fully set up. Add your Account SID, Auth Token, caller ID and phone number in calling settings.', { code: 'not_configured' });
    }
    const attempt = await prisma.callAttempt.create({ data: { userId: req.user.id, carrierId: carrier?.id ?? null, provider, toNumber: to, status: 'queued' } });
    const base = `${config.appUrl}/api/telephony/twilio`;
    try {
      const call = await createBridgeCall({
        sid: settings.twilioAccountSid,
        token: decrypt(settings.twilioAuthTokenEnc),
        to: settings.myNumber,
        from: settings.callerId,
        twiml: bridgeTwiml({ company: carrier?.companyName, callerId: settings.callerId, carrierE164: to, actionUrl: `${base}/dial-result/${attempt.id}` }),
        statusCallback: `${base}/status/${attempt.id}`,
      });
      const updated = await prisma.callAttempt.update({ where: { id: attempt.id }, data: { providerCallId: call.sid, status: PARENT_STATUS[call.status] || 'queued' }, include: { carrier: { select: carrierSummary } } });
      return res.status(201).json({
        mode: 'bridge', attempt: serializeAttempt(updated), autoOpenLog: settings.autoOpenLog,
        message: `Ringing your phone ${prettyPhone(settings.myNumber)}. Answer it and Twilio connects ${carrier?.companyName || prettyPhone(to)}.`,
      });
    } catch (err) {
      await prisma.callAttempt.update({ where: { id: attempt.id }, data: { status: 'failed', error: err.message, endedAt: new Date() } });
      throw new HttpError(502, err.message, { code: 'provider_error' });
    }
  }

  const url = buildLink(provider, to, settings);
  const attempt = await prisma.callAttempt.create({
    data: { userId: req.user.id, carrierId: carrier?.id ?? null, provider, toNumber: to, status: 'dialed' },
    include: { carrier: { select: carrierSummary } },
  });
  res.status(201).json({
    mode: 'link', url, openInNewTab: /^https:\/\//.test(url), attempt: serializeAttempt(attempt), autoOpenLog: settings.autoOpenLog,
    message: `Opening ${providerByKey(provider)?.label || 'your phone app'} for ${carrier?.companyName || prettyPhone(to)}`,
  });
}));

r.get('/attempts', auth, ah(async (req, res) => {
  const q = parse(z.object({ carrierId: optStr(40), limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  if (q.carrierId) await loadCarrier(req.user, q.carrierId);
  const items = await prisma.callAttempt.findMany({
    where: { userId: req.user.id, ...(q.carrierId ? { carrierId: q.carrierId } : {}) },
    orderBy: { createdAt: 'desc' }, take: q.limit, include: { carrier: { select: carrierSummary } },
  });
  res.json({ items: items.map(serializeAttempt) });
}));

async function ownAttempt(req) {
  const a = await prisma.callAttempt.findUnique({ where: { id: String(req.params.id) }, include: { carrier: { select: carrierSummary } } });
  if (!a || a.userId !== req.user.id) throw notFound('Call attempt not found');
  return a;
}

r.get('/attempts/:id', auth, ah(async (req, res) => {
  res.json({ attempt: serializeAttempt(await ownAttempt(req)) });
}));

r.post('/attempts/:id/cancel', auth, ah(async (req, res) => {
  const a = await ownAttempt(req);
  if (FINAL.has(a.status)) return res.json({ attempt: serializeAttempt(a) });
  if (a.provider === 'twilio' && a.providerCallId) {
    const s = await getSettings(req.user.id);
    try {
      await endCall({ sid: s.twilioAccountSid, token: decrypt(s.twilioAuthTokenEnc), callSid: a.providerCallId, inProgress: a.status === 'in_progress' });
    } catch (err) {
      throw new HttpError(502, err.message, { code: 'provider_error' });
    }
  }
  const updated = await prisma.callAttempt.update({ where: { id: a.id }, data: { status: 'canceled', endedAt: new Date() }, include: { carrier: { select: carrierSummary } } });
  res.json({ attempt: serializeAttempt(updated) });
}));

// ---------------------------------------------------------------------------- Twilio webhooks (signature-verified, no session)

async function verifiedAttempt(req) {
  const a = await prisma.callAttempt.findUnique({ where: { id: String(req.params.id) } });
  if (!a || a.provider !== 'twilio') return null;
  const s = await prisma.callSettings.findUnique({ where: { userId: a.userId } });
  const token = s?.twilioAuthTokenEnc ? decrypt(s.twilioAuthTokenEnc) : null;
  const url = `${config.appUrl}${req.originalUrl}`;
  if (!verifySignature(token, url, req.body || {}, req.get('x-twilio-signature'))) return null;
  // Both callbacks carry the parent (dispatcher leg) CallSid; it must match the call we created.
  if (req.body?.CallSid && a.providerCallId && req.body.CallSid !== a.providerCallId) return null;
  return { attempt: a, settings: s };
}

/** Status of the dispatcher's own leg (Twilio rings them first). */
r.post('/twilio/status/:id', ah(async (req, res) => {
  const v = await verifiedAttempt(req);
  if (!v) return res.status(403).type('text/plain').send('Invalid signature');
  const { attempt } = v;
  if (FINAL.has(attempt.status)) return res.type('text/xml').send('<Response/>');
  const st = String(req.body.CallStatus || '');
  const data = {};
  if (PARENT_STATUS[st]) data.status = PARENT_STATUS[st];
  if (['busy', 'no-answer', 'failed', 'canceled'].includes(st)) {
    // The dispatcher's own phone didn't pick up: nothing was dialed to the carrier.
    data.status = st === 'canceled' ? 'canceled' : 'failed';
    data.error = st === 'canceled' ? null : 'Your phone did not answer, so the carrier was not called';
    data.endedAt = new Date();
  }
  if (st === 'completed' && !attempt.endedAt) data.endedAt = new Date();
  if (Object.keys(data).length) await prisma.callAttempt.update({ where: { id: attempt.id }, data });
  res.type('text/xml').send('<Response/>');
}));

/** Result of the <Dial> to the carrier: the real outcome of the call. */
r.post('/twilio/dial-result/:id', ah(async (req, res) => {
  const v = await verifiedAttempt(req);
  if (!v) return res.status(403).type('text/plain').send('Invalid signature');
  const { attempt, settings } = v;
  const status = DIAL_STATUS[String(req.body.DialCallStatus || '')] || 'failed';
  const duration = Number(req.body.DialCallDuration || 0) || null;
  const ended = new Date();
  await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      status, durationSec: duration, endedAt: ended,
      answeredAt: status === 'completed' ? new Date(ended.getTime() - (duration || 0) * 1000) : null,
    },
  });

  const unanswered = ['no_answer', 'busy', 'failed'].includes(status);
  if (unanswered && settings?.autoLogUnanswered !== false && attempt.carrierId && !attempt.callId) {
    try {
      const user = await prisma.user.findUnique({ where: { id: attempt.userId }, include: { teamMembership: { include: { team: true } } } });
      const carrier = await prisma.carrier.findUnique({ where: { id: attempt.carrierId } });
      if (user && carrier) {
        const fresh = await prisma.callAttempt.findUnique({ where: { id: attempt.id } });
        await logCall(user, carrier, { outcome: status === 'busy' ? 'busy' : 'no_answer', notes: 'Logged automatically from the phone system', automatic: true, autoFollowUp: true }, { attempt: fresh });
        await notify(user.id, { type: 'call', title: `${carrier.companyName}: ${status === 'busy' ? 'busy' : 'no answer'}`, body: 'Call logged automatically and a follow-up was scheduled', link: `/app/carriers/${carrier.id}` });
      }
    } catch (err) {
      console.error('[telephony] auto-log failed', err.message);
    }
  }
  res.type('text/xml').send('<Response/>');
}));

export default r;
