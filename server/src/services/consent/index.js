import { prisma } from '../../db.js';
import { sha256 } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';

/**
 * Consent to automated calls and texts (US TCPA). Automated (autodialed, artificial or AI voice, prerecorded) calls and
 * automated texts to a cell phone need the person's prior express consent, and prior express WRITTEN consent when the
 * message is marketing. That consent may not be a condition of buying the service, and the person may revoke it at any
 * time by any reasonable means. Each record keeps who agreed, the exact wording, its sha256 hash, the phone number, the
 * channels, when and how (source, IP address, browser), and the revocation.
 *
 * This module only captures and stores consent. Anything that places automated calls or sends automated texts must call
 * activeConsent() for the exact number it is about to dial or text, and honor the carrier's "Do not call" flag as well.
 */

export const CHANNELS = ['sms', 'voice'];
export const CHANNEL_LABEL = { sms: 'SMS', voice: 'voice' };
export const SOURCES = ['onboarding', 'manual', 'form'];
export const SOURCE_LABEL = {
  onboarding: 'Onboarding link (optional box ticked when signing the dispatch agreement)',
  manual: 'Recorded by the dispatcher',
  form: 'Web form',
};
export const MAX_NOTE_CHARS = 1000;
export const MAX_REASON_CHARS = 500;

/** "2145550188" from "(214) 555-0188", "+1 214 555 0188" and so on; null unless it is a valid US (NANP) number. */
export function normalizePhone(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null;
}

/** "(214) 555-0188" for 10 digits; anything else is returned as given. The public page formats it the same way. */
export const formatPhone = (digits) => {
  const d = String(digits ?? '');
  return /^\d{10}$/.test(d) ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
};

/** Channels in a fixed order with duplicates removed: ['sms', 'voice']. Accepts an array or a comma list. */
export function normalizeChannels(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const set = new Set(list.map((c) => String(c).trim()));
  return CHANNELS.filter((c) => set.has(c));
}
export const parseChannels = (s) => normalizeChannels(s);
export const channelsLabel = (channels) => normalizeChannels(channels).map((c) => CHANNEL_LABEL[c]).join(' + ');

/**
 * The consent wording around the phone number: text = before + formatPhone(phone) + after. The public onboarding page
 * gets the two parts so it can show the exact sentence for the number the carrier types, and the server rebuilds the same
 * text to check that what was shown is what gets stored.
 *
 * LEGAL REVIEW: this wording is a plain-language, generic starting point, not legal advice. The operator should have it
 * reviewed by counsel (TCPA, state mini-TCPA laws and carrier messaging rules) before any automated call or text relies
 * on it. Changing it changes only future records: every record stores the exact text it was given with, and its hash.
 */
export function consentParts({ dispatcherName, dispatcherCompany, channels = CHANNELS } = {}) {
  const who = String(dispatcherCompany || '').trim() || String(dispatcherName || '').trim() || 'my dispatcher';
  const ch = normalizeChannels(channels);
  const sms = ch.includes('sms');
  const voice = ch.includes('voice');
  const verb = sms && voice ? 'call and text' : voice ? 'call' : 'text';
  const how = sms && voice
    ? 'calls and texts sent with automated technology and calls that use an artificial, AI-generated or prerecorded voice'
    : voice ? 'calls made with automated technology and calls that use an artificial, AI-generated or prerecorded voice'
      : 'texts sent with automated technology';
  const before = `I agree that ${who} may ${verb} me at `;
  const after = `, including ${how}, about available loads, dispatch updates and my account. `
    + 'My consent is not a condition of buying or using their services. '
    + (sms ? 'Message frequency varies. Message and data rates may apply. ' : '')
    + `I can opt out at any time ${sms ? 'by replying STOP to a text or ' : ''}by telling ${who} in any reasonable way.`;
  return { before, after };
}

/** The exact, plain-language consent sentence for one phone number (see consentParts). */
export function consentText({ dispatcherName, dispatcherCompany, phone, channels = CHANNELS } = {}) {
  const { before, after } = consentParts({ dispatcherName, dispatcherCompany, channels });
  const digits = normalizePhone(phone);
  return `${before}${digits ? formatPhone(digits) : String(phone ?? '').trim()}${after}`;
}

export const consentHash = (text) => sha256(text);

/**
 * Store one consent. Throws 400 for an invalid phone, no channel, an unknown source or empty wording. `tx` lets the
 * onboarding signature and its consent be written in one transaction.
 */
export async function recordConsent({
  ownerId, carrierId, phone, channels = CHANNELS, source, consentText: text, onboardingLinkId = null, grantedAt = new Date(),
  grantedByName = null, ip = null, userAgent = null, proofDocumentId = null, note = null,
}, tx = prisma) {
  const digits = normalizePhone(phone);
  if (!digits) throw badRequest('Enter a valid 10-digit US phone number');
  const ch = normalizeChannels(channels);
  if (!ch.length) throw badRequest('Pick calls, texts or both');
  if (!SOURCES.includes(source)) throw badRequest('Unknown consent source');
  const wording = String(text ?? '').trim();
  if (!wording) throw badRequest('The consent wording is missing');
  return tx.contactConsent.create({
    data: {
      ownerId, carrierId, phone: digits, channels: ch.join(','), consentText: wording, consentHash: consentHash(wording), source,
      onboardingLinkId, grantedAt, grantedByName: grantedByName ? String(grantedByName).trim().slice(0, 120) || null : null,
      ip: ip ? String(ip).slice(0, 64) : null, userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
      proofDocumentId, note: note ? String(note).trim().slice(0, MAX_NOTE_CHARS) || null : null,
    },
  });
}

/**
 * Revoke one consent (idempotent: an already revoked record is returned unchanged, keeping the first revocation).
 * Returns the record, or null when it does not exist.
 */
export async function revokeConsent({ id, reason = null, at = new Date() }, tx = prisma) {
  const why = reason ? String(reason).trim().slice(0, MAX_REASON_CHARS) || null : null;
  await tx.contactConsent.updateMany({ where: { id: String(id), revokedAt: null }, data: { revokedAt: at, revokeReason: why } });
  return tx.contactConsent.findUnique({ where: { id: String(id) } });
}

/**
 * Revoke every active consent a carrier gave for one number (for example after a STOP reply or "stop calling me").
 * Returns the number of records revoked.
 */
export async function revokeForPhone(carrierId, phone, { reason = null, at = new Date() } = {}, tx = prisma) {
  const digits = normalizePhone(phone);
  if (!carrierId || !digits) return 0;
  const why = reason ? String(reason).trim().slice(0, MAX_REASON_CHARS) || null : null;
  const { count } = await tx.contactConsent.updateMany({ where: { carrierId: String(carrierId), phone: digits, revokedAt: null }, data: { revokedAt: at, revokeReason: why } });
  return count;
}

/**
 * The consent that currently allows an automated call or text to this carrier at this number, or null.
 *   activeConsent(carrierId, { phone, channel })
 *   - phone: any US format; it is normalized to 10 digits. Missing or invalid gives null.
 *   - channel: 'sms' | 'voice'. When given, the record must cover it; an unknown channel gives null.
 * Only records that are not revoked, were granted for exactly that number and are not dated in the future count; the most
 * recent one is returned. No access check is made: callers pass a carrier the acting user may use.
 */
export async function activeConsent(carrierId, { phone, channel } = {}) {
  const digits = normalizePhone(phone);
  if (!carrierId || !digits) return null;
  if (channel != null && !CHANNELS.includes(channel)) return null;
  const rows = await prisma.contactConsent.findMany({
    where: { carrierId: String(carrierId), phone: digits, revokedAt: null, grantedAt: { lte: new Date() } },
    orderBy: { grantedAt: 'desc' }, take: 20,
  });
  return rows.find((r) => !channel || parseChannels(r.channels).includes(channel)) || null;
}

/** Every consent record of a carrier: active ones first, then revoked ones, newest first within each group. */
export async function listForCarrier(carrierId, { take = 100 } = {}) {
  const rows = await prisma.contactConsent.findMany({ where: { carrierId: String(carrierId) }, orderBy: { grantedAt: 'desc' }, take });
  return [...rows.filter((r) => !r.revokedAt), ...rows.filter((r) => r.revokedAt)];
}

/** Status for the carrier page: consented (with the channels and the earliest active date) | revoked | none. */
export function consentSummary(rows) {
  const active = rows.filter((r) => !r.revokedAt);
  if (active.length) {
    const channels = normalizeChannels(active.flatMap((r) => parseChannels(r.channels)));
    const since = active.reduce((min, r) => (new Date(r.grantedAt) < new Date(min) ? r.grantedAt : min), active[0].grantedAt);
    return { status: 'consented', channels, since, phones: [...new Set(active.map((r) => r.phone))] };
  }
  if (rows.length) {
    const last = rows.reduce((m, r) => (new Date(r.revokedAt) > new Date(m.revokedAt) ? r : m), rows[0]);
    return { status: 'revoked', channels: [], since: null, revokedAt: last.revokedAt, phones: [] };
  }
  return { status: 'none', channels: [], since: null, phones: [] };
}

/** API view of one record. */
export function consentView(row, { proofDocument } = {}) {
  return {
    id: row.id, carrierId: row.carrierId, phone: row.phone, phoneDisplay: formatPhone(row.phone), channels: parseChannels(row.channels),
    source: row.source, consentText: row.consentText, consentHash: row.consentHash, onboardingLinkId: row.onboardingLinkId,
    grantedAt: row.grantedAt, grantedByName: row.grantedByName, ip: row.ip, userAgent: row.userAgent, note: row.note,
    proofDocumentId: row.proofDocumentId, proofDocument: proofDocument ? { id: proofDocument.id, originalName: proofDocument.originalName, type: proofDocument.type } : null,
    revokedAt: row.revokedAt, revokeReason: row.revokeReason, active: !row.revokedAt, createdAt: row.createdAt,
  };
}
