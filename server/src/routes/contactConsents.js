import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, notFound, HttpError } from '../lib/errors.js';
import { parse, z, optStr, optDate } from '../lib/validate.js';
import { loadCarrier } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { requirePermission, refuseApiToken } from '../middleware/auth.js';
import { dispatcherCompany } from '../services/onboarding/agreement.js';
import {
  CHANNELS, MAX_NOTE_CHARS, MAX_REASON_CHARS, normalizePhone, formatPhone, normalizeChannels, channelsLabel, consentText,
  recordConsent, revokeConsent, listForCarrier, consentSummary, consentView,
} from '../services/consent/index.js';
import { proofHtml } from '../services/consent/proof.js';

/**
 * Consent to automated calls and texts (TCPA) per carrier: history, manual records, revocation and a printable proof.
 * Access follows the carrier: whoever may read the carrier sees its consents; recording needs write access to the
 * carrier. Revoking only needs read access, because the TCPA lets people revoke by any reasonable means, so any teammate
 * who hears "stop calling me" must be able to record it. Both writes need a session (API tokens are refused). Anyone
 * else gets 404.
 */
const r = Router();
r.use(requirePermission('crm.use'));

const DAY = 86_400_000;

/** The consent record plus the carrier access check (404 when the caller cannot see the carrier). */
async function loadConsent(user, id, { write = false } = {}) {
  const consent = await prisma.contactConsent.findUnique({ where: { id: String(id) } });
  if (!consent) throw notFound('Consent record not found');
  try {
    const carrier = await loadCarrier(user, consent.carrierId, { write });
    return { consent, carrier };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw notFound('Consent record not found');
    throw err;
  }
}

/** Proof documents by id, limited to the carrier's own documents. */
async function proofDocs(carrierId, ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return new Map();
  const docs = await prisma.document.findMany({ where: { id: { in: want }, carrierId }, select: { id: true, originalName: true, type: true, createdAt: true } });
  return new Map(docs.map((d) => [d.id, d]));
}

r.get('/', ah(async (req, res) => {
  const { carrierId } = parse(z.object({ carrierId: z.string().trim().min(1).max(40) }), req.query);
  const carrier = await loadCarrier(req.user, carrierId);
  const rows = await listForCarrier(carrier.id);
  const docs = await proofDocs(carrier.id, rows.map((x) => x.proofDocumentId));
  res.json({ items: rows.map((x) => consentView(x, { proofDocument: docs.get(x.proofDocumentId) })), summary: consentSummary(rows) });
}));

/** The wording a manual record stores, for the dialog preview: same text as POST / would save. */
r.get('/wording', ah(async (req, res) => {
  const q = parse(z.object({ phone: z.string().max(40).optional(), channels: z.string().max(40).optional() }), req.query);
  const channels = normalizeChannels(q.channels ?? CHANNELS.join(','));
  const phone = normalizePhone(q.phone);
  res.json({
    text: consentText({ dispatcherName: req.user.name, dispatcherCompany: dispatcherCompany(req.user), phone: phone || '[phone number]', channels: channels.length ? channels : CHANNELS }),
    phone,
  });
}));

const createSchema = z.object({
  carrierId: z.string().trim().min(1).max(40),
  phone: z.string().trim().min(1, 'Enter the phone number').max(40),
  channels: z.array(z.enum(CHANNELS)).min(1, 'Pick calls, texts or both').max(CHANNELS.length),
  note: z.string().trim().min(5, 'Add a note on how the person gave consent (for example a signed paper form or a recorded call)').max(MAX_NOTE_CHARS),
  grantedByName: optStr(120),
  grantedAt: optDate,
  proofDocumentId: optStr(40),
}).strict();

/** A consent the dispatcher obtained outside the app (paper form, recorded call, email). The note says how. */
r.post('/', ah(async (req, res) => {
  refuseApiToken(req, 'record consent to calls and texts');
  const body = parse(createSchema, req.body);
  const carrier = await loadCarrier(req.user, body.carrierId, { write: true });
  const phone = normalizePhone(body.phone);
  if (!phone) throw badRequest('Enter a valid 10-digit US phone number');
  const now = Date.now();
  const grantedAt = body.grantedAt || new Date(now);
  if (Number.isNaN(grantedAt.getTime()) || grantedAt.getTime() > now + 5 * 60_000) throw badRequest('The date consent was given cannot be in the future');
  if (grantedAt.getTime() < now - 3650 * DAY) throw badRequest('The date consent was given is too far in the past');
  if (body.proofDocumentId) {
    const doc = await prisma.document.findFirst({ where: { id: body.proofDocumentId, carrierId: carrier.id }, select: { id: true } });
    if (!doc) throw badRequest('The proof must be one of this carrier\'s documents');
  }
  const channels = normalizeChannels(body.channels);
  const text = consentText({ dispatcherName: req.user.name, dispatcherCompany: dispatcherCompany(req.user), phone, channels });
  const row = await recordConsent({
    ownerId: carrier.ownerId, carrierId: carrier.id, phone, channels, source: 'manual', consentText: text, grantedAt,
    grantedByName: body.grantedByName || null, proofDocumentId: body.proofDocumentId || null, note: body.note,
  });
  await logActivity(req.user, {
    type: 'consent', carrierId: carrier.id,
    summary: `Consent to automated ${channelsLabel(channels)} at ${formatPhone(phone)} recorded${body.grantedByName ? ` for ${body.grantedByName}` : ''}`,
    metadata: { contactConsentId: row.id, action: 'recorded' },
  });
  const docs = await proofDocs(carrier.id, [row.proofDocumentId]);
  res.status(201).json({ item: consentView(row, { proofDocument: docs.get(row.proofDocumentId) }) });
}));

r.post('/:id/revoke', ah(async (req, res) => {
  refuseApiToken(req, 'revoke consent to calls and texts');
  const { reason } = parse(z.object({ reason: optStr(MAX_REASON_CHARS) }).strict(), req.body);
  // Read access is enough: an opt-out must always be recordable (see the note at the top).
  const { consent, carrier } = await loadConsent(req.user, req.params.id);
  let row = consent;
  if (!consent.revokedAt) {
    row = await revokeConsent({ id: consent.id, reason: reason || null });
    await logActivity(req.user, {
      type: 'consent', carrierId: carrier.id,
      summary: `Consent to automated calls and texts at ${formatPhone(consent.phone)} revoked${reason ? `: ${reason}` : ''}`,
      metadata: { contactConsentId: consent.id, action: 'revoked' },
    });
  }
  const docs = await proofDocs(carrier.id, [row.proofDocumentId]);
  res.json({ item: consentView(row, { proofDocument: docs.get(row.proofDocumentId) }) });
}));

/** Printable proof (open in a new tab, print or save as PDF). */
r.get('/:id/proof', ah(async (req, res) => {
  const { consent, carrier } = await loadConsent(req.user, req.params.id);
  const [events, docs, link] = await Promise.all([
    prisma.activity.findMany({
      where: { carrierId: carrier.id, type: 'consent', metadata: { contains: consent.id } },
      orderBy: { createdAt: 'asc' }, take: 20, select: { metadata: true, user: { select: { name: true } } },
    }),
    proofDocs(carrier.id, [consent.proofDocumentId]),
    consent.onboardingLinkId
      ? prisma.onboardingLink.findFirst({ where: { id: consent.onboardingLinkId, carrierId: carrier.id }, select: { agreementTitle: true, signedAt: true, signerEmail: true } })
      : null,
  ]);
  const by = (action) => {
    for (const e of events) {
      try {
        const m = JSON.parse(e.metadata || '{}');
        if (m.contactConsentId === consent.id && m.action === action) return e.user?.name || null;
      } catch { /* ignore malformed metadata */ }
    }
    return null;
  };
  const html = proofHtml({
    consent, carrier, link, proofDocument: docs.get(consent.proofDocumentId) || null,
    recordedBy: consent.source === 'manual' ? by('recorded') : null, revokedBy: consent.revokedAt ? by('revoked') : null,
    tz: req.user.timezone || 'UTC',
  });
  const slug = carrier.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'carrier';
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `inline; filename="call-text-consent-${slug}.html"`,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(html);
}));

export default r;
