import fs from 'node:fs';
import crypto from 'node:crypto';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { HttpError, badRequest, notFound } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { logActivity, notify } from '../../lib/activity.js';
import { filePath, removeFile } from '../../middleware/upload.js';
import { normDot, normMc } from '../carriers/normalize.js';
import { census, censusRows } from '../carriers/profile.js';
import { sendSystemMail } from '../email/system.js';
import { carrierCodeMessage } from '../email/platformTemplate.js';
import { mailDomainOk } from '../email/mx.js';
import { getSetting } from '../../lib/settings.js';

/**
 * Carrier accounts (see the CarrierAccount models in prisma/schema.prisma).
 *
 * Sign-in: the carrier enters its USDOT (or MC) number; a 6-digit code goes to the email address FMCSA has on file
 * for that number (Company Census). Only the person who reads that mailbox can sign in, so a dispatcher, a broker or
 * a fraudster cannot open a carrier's account by knowing its numbers. Codes last 10 minutes, take 5 tries, and at
 * most 3 are sent per USDOT number an hour. A session is a random token in an httpOnly cookie (30 days), stored
 * hashed.
 *
 * Connections: dispatchers that invited this carrier, i.e. a dispatcher's carrier record with the same USDOT number
 * that has a dispatch-agreement link or a customer profile. A record that is only a lead in some dispatcher's list
 * is never shown to the carrier, and no dispatcher ever sees another dispatcher's connection.
 *
 * Sharing: per connection the carrier picks document types; current vault documents of those types are copied into
 * that dispatcher's documents (once each), and with autoUpdate a newer upload (a renewed insurance certificate) is
 * sent to them too. Stopping a share stops future copies; files a dispatcher already received stay with them.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_TRIES = 5;
export const CODES_PER_HOUR = 3;
// A carrier who never asked must not get a stream of codes from someone typing their number (spam complaints hurt the
// platform sender), so codes per USDOT are also capped per day.
export const CODES_PER_DAY = 6;
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'dd_carrier';
export const VAULT_DIR = 'carrier-vault';
export const MAX_VAULT_FILES = 40;
export const VAULT_FILE_MB = 15;

export const VAULT_TYPES = ['w9', 'coi', 'mc_authority', 'noa', 'voided_check', 'cdl', 'registration', 'other'];
export const VAULT_LABEL = {
  w9: 'W-9', coi: 'Certificate of insurance', mc_authority: 'MC authority letter', noa: 'Notice of assignment (factoring)',
  voided_check: 'Voided check', cdl: "Driver's license (CDL)", registration: 'Truck or trailer registration', other: 'Other document',
};
/** Dispatcher Document.type for each vault type. */
const DOCUMENT_TYPE = { w9: 'w9', coi: 'coi', mc_authority: 'mc_authority', noa: 'noa', voided_check: 'voided_check', cdl: 'other', registration: 'permit', other: 'other' };
/** Types shared by default when the carrier first shares with a dispatcher (what a dispatcher needs to onboard). */
export const DEFAULT_SHARE = ['w9', 'coi', 'mc_authority', 'noa'];

const DAY = 86_400_000;

/** "de***@gmail.com" */
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return null;
  return `${user.slice(0, Math.min(2, user.length))}${'*'.repeat(Math.max(3, user.length - 2))}@${domain}`;
}

const codeHash = (code, salt = randomToken(8)) => `${salt}.${sha256(`${salt}:${code}`)}`;
function codeMatches(stored, code) {
  const [salt, hex] = String(stored).split('.');
  if (!salt || !hex) return false;
  const want = Buffer.from(sha256(`${salt}:${code}`));
  const got = Buffer.from(hex);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** The FMCSA census row for a USDOT or MC number (best row), or null. */
async function censusFor({ dot, mc }) {
  try {
    if (dot) return (await census(`dot_number='${dot}'`, 3)).rows[0] || null;
    const rows = await censusRows({ $where: `docket1prefix='MC' AND docket1='${mc}'`, $limit: '3' });
    return rows[0] || null;
  } catch (err) {
    throw new HttpError(502, `FMCSA records are not available right now. Try again in a few minutes. (${String(err?.message || err).slice(0, 120)})`);
  }
}

/** Parse "USDOT 123", "MC 456" or a bare number. A bare number is taken as a USDOT number. */
export function parseNumber(input) {
  const raw = String(input ?? '').trim();
  const mc = /^(MC|MX)[\s#:-]*0*(\d{1,8})$/i.exec(raw);
  if (mc) return { mc: normMc(mc[2]) };
  const dot = /^(US\s*)?(DOT)?[\s#:-]*0*(\d{1,9})$/i.exec(raw);
  if (dot) return { dot: normDot(dot[3]) };
  return null;
}

/**
 * Step 1 of sign-in: send a code to the FMCSA email of this USDOT / MC number.
 * Returns { dot, maskedEmail, expiresInMinutes }. Throws 422 when FMCSA has no usable email (with what to do).
 */
export async function startLogin({ number, ip }) {
  const parsed = parseNumber(number);
  if (!parsed) throw badRequest('Enter your USDOT number (or MC number).');
  const row = await censusFor(parsed);
  const dot = normDot(row?.dot_number);
  if (!row || !dot) throw notFound(`FMCSA has no carrier with ${parsed.dot ? `USDOT ${parsed.dot}` : `MC ${parsed.mc}`}. Check the number.`);
  const email = String(row.email_address || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) {
    throw new HttpError(422, `FMCSA has no email address on file for USDOT ${dot}, so we cannot send you a code. Add your email to your MCS-150 with FMCSA, or ask your dispatcher for your portal link.`, { code: 'NO_FMCSA_EMAIL' });
  }
  const [recent, today] = await Promise.all([
    prisma.carrierLoginCode.count({ where: { dotNumber: dot, createdAt: { gt: new Date(Date.now() - 3_600_000) } } }),
    prisma.carrierLoginCode.count({ where: { dotNumber: dot, createdAt: { gt: new Date(Date.now() - 86_400_000) } } }),
  ]);
  if (today >= CODES_PER_DAY) throw new HttpError(429, 'Too many codes for this USDOT number today. Try again tomorrow, or use the last code we sent.');
  if (recent >= CODES_PER_HOUR) throw new HttpError(429, 'Too many codes for this USDOT number. Wait an hour, or use the last code we sent.');
  // An address whose domain takes no mail would bounce, and bounces hurt the platform sender. DNS not answering is no reason to refuse.
  if ((await mailDomainOk(email)) === false) {
    throw new HttpError(422, `The email FMCSA has on file for USDOT ${dot} (${maskEmail(email)}) cannot receive mail, so we cannot send you a code. Update your email on your MCS-150 with FMCSA, or ask your dispatcher for your portal link.`, { code: 'EMAIL_UNREACHABLE' });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const row2 = await prisma.carrierLoginCode.create({ data: { dotNumber: dot, email, codeHash: codeHash(code), expiresAt: new Date(Date.now() + CODE_TTL_MS), ip: ip ? String(ip).slice(0, 64) : null } });
  const name = String(row.legal_name || `USDOT ${dot}`).trim();
  // Local development (EXPOSE_DEV_TOKENS=true, never set in production): the address is a real trucker's FMCSA email,
  // so nothing is sent; the code comes back in the response (devCode) and the sign-in page shows it.
  const local = config.exposeDevTokens && !config.isTest;
  if (local) {
    console.log(`[carrier] local sign-in code for USDOT ${dot}: ${code} (not emailed)`);
  } else {
    const appName = await getSetting('app.name');
    const mail = await sendSystemMail({ to: email, category: 'auth', ...carrierCodeMessage({ appName, code, name, dot, signInUrl: `${config.appUrl}/carrier` }) });
    if (!mail.sent) {
      await prisma.carrierLoginCode.delete({ where: { id: row2.id } }).catch(() => {});
      throw new HttpError(503, 'We could not send the code right now. Try again in a few minutes.', { code: 'MAIL_FAILED' });
    }
  }
  // name: FMCSA legal name, so a carrier who typed the wrong number sees it before entering the code (public data).
  // sender: the platform From address the code comes from (never a dispatcher's mailbox), so they know what to look for.
  const sender = String((await getSetting('smtp.from')) || '').trim() || null;
  return { dot, name, maskedEmail: maskEmail(email), sender, expiresInMinutes: CODE_TTL_MS / 60_000, ...(local ? { devCode: code } : {}) };
}

/** Step 2: check the code, create (or update) the account and a session. Returns { account, token }. */
export async function verifyLogin({ number, code, userAgent }) {
  const parsed = parseNumber(number);
  if (!parsed) throw badRequest('Enter your USDOT number (or MC number).');
  const clean = String(code ?? '').replace(/\D/g, '');
  if (clean.length !== 6) throw badRequest('Enter the 6-digit code from the email.');
  let dot = parsed.dot;
  if (!dot) dot = normDot((await censusFor(parsed))?.dot_number);
  if (!dot) throw badRequest('Ask for a new code.');
  const row = await prisma.carrierLoginCode.findFirst({ where: { dotNumber: dot, usedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!row || row.expiresAt < new Date()) throw badRequest('This code has expired. Ask for a new one.', { code: 'CODE_EXPIRED' });
  if (row.attempts >= CODE_TRIES) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.', { code: 'CODE_LOCKED' });
  if (!codeMatches(row.codeHash, clean)) {
    await prisma.carrierLoginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    throw badRequest(`That code is not right. ${Math.max(0, CODE_TRIES - row.attempts - 1)} tries left.`, { code: 'CODE_WRONG' });
  }
  // Single use, even under a double submit.
  const used = await prisma.carrierLoginCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!used.count) throw badRequest('This code was already used. Ask for a new one.');
  const now = new Date();
  const account = await prisma.carrierAccount.upsert({
    where: { dotNumber: dot },
    create: { dotNumber: dot, verifiedEmail: row.email, verifiedAt: now, lastLoginAt: now },
    update: { verifiedEmail: row.email, verifiedAt: now, lastLoginAt: now },
  });
  if (!account.legalName) {
    const c = await censusFor({ dot }).catch(() => null);
    if (c?.legal_name) await prisma.carrierAccount.update({ where: { id: account.id }, data: { legalName: String(c.legal_name).trim().slice(0, 200) } }).catch(() => {});
  }
  const token = randomToken(32);
  await prisma.carrierSession.create({ data: { accountId: account.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_DAYS * DAY), userAgent: userAgent ? String(userAgent).slice(0, 200) : null } });
  // Old codes for this number are done.
  await prisma.carrierLoginCode.deleteMany({ where: { dotNumber: dot, OR: [{ usedAt: { not: null } }, { expiresAt: { lt: now } }] } }).catch(() => {});
  return { account, token };
}

export const sessionCookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: SESSION_DAYS * DAY });

/** The account behind a session cookie, or null. Refreshes lastSeenAt at most every 10 minutes. */
export async function accountForSession(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const s = await prisma.carrierSession.findUnique({ where: { tokenHash: sha256(token) }, include: { account: true } });
  if (!s || s.expiresAt < new Date()) return null;
  if (Date.now() - s.lastSeenAt.getTime() > 10 * 60_000) await prisma.carrierSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return { account: s.account, sessionId: s.id };
}

export async function endSession(token) {
  if (token) await prisma.carrierSession.deleteMany({ where: { tokenHash: sha256(String(token)) } });
}

// ---------------------------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------------------------

/** Dispatcher records that invited this carrier (agreement link or customer), with this account's share on each. */
export async function connectionsFor(account) {
  const rows = await prisma.carrier.findMany({
    where: { dotNumber: account.dotNumber, OR: [{ onboardingLinks: { some: {} } }, { customer: { isNot: null } }] },
    select: {
      id: true, companyName: true, ownerId: true,
      owner: { select: { name: true, companyName: true, email: true, phone: true, teamMembership: { select: { team: { select: { name: true } } } } } },
      customer: { select: { id: true, status: true, signedAt: true, portalTokenHash: true, portalExpiresAt: true } },
      onboardingLinks: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, createdAt: true, signedAt: true, expiresAt: true, revokedAt: true } },
      carrierShares: { where: { accountId: account.id }, select: { id: true, docTypes: true, autoUpdate: true, hidden: true, revokedAt: true, updatedAt: true, _count: { select: { files: true } } } },
    },
    take: 50,
  });
  const now = new Date();
  return rows.map((c) => {
    const share = c.carrierShares[0] || null;
    const link = c.onboardingLinks[0] || null;
    const linkState = !link ? null : link.revokedAt ? 'revoked' : link.status === 'signed' ? 'signed' : link.expiresAt < now ? 'expired' : 'pending';
    return {
      id: c.id,
      dispatcher: {
        name: c.owner?.name || null,
        company: c.owner?.teamMembership?.team?.name || c.owner?.companyName || null,
        email: c.owner?.email || null,
        phone: c.owner?.phone || null,
      },
      relationship: c.customer ? (c.customer.status === 'active' ? 'customer' : c.customer.status) : 'invited',
      agreement: link ? { status: linkState, sentAt: link.createdAt, signedAt: link.signedAt } : null,
      statements: !!(c.customer?.portalTokenHash && (!c.customer.portalExpiresAt || c.customer.portalExpiresAt > now)),
      share: share ? {
        docTypes: share.docTypes ? share.docTypes.split(',').filter(Boolean) : [],
        autoUpdate: share.autoUpdate, hidden: share.hidden, active: !share.revokedAt && !share.hidden && !!share.docTypes,
        filesShared: share._count.files, updatedAt: share.updatedAt,
      } : null,
    };
  }).sort((a, b) => Number(!!a.share?.hidden) - Number(!!b.share?.hidden));
}

async function connectionRow(account, carrierId) {
  const c = await prisma.carrier.findFirst({
    where: { id: String(carrierId), dotNumber: account.dotNumber, OR: [{ onboardingLinks: { some: {} } }, { customer: { isNot: null } }] },
    include: { owner: { include: { teamMembership: true } } },
  });
  if (!c) throw notFound('This dispatcher is not connected to your USDOT number.');
  return c;
}

const cleanName = (s) => String(s || '').replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const extOf = (name) => (String(name).toLowerCase().match(/\.(pdf|png|jpe?g)$/)?.[0] || '.pdf').replace('.jpeg', '.jpg');

/** Copy one vault document into a dispatcher's documents through a share (idempotent). Returns the Document or null. */
async function copyToDispatcher(share, carrier, vaultDoc, companyName) {
  const exists = await prisma.carrierShareDoc.findUnique({ where: { shareId_vaultDocumentId: { shareId: share.id, vaultDocumentId: vaultDoc.id } } });
  if (exists) return null;
  const src = filePath(VAULT_DIR, vaultDoc.storedName);
  if (!fs.existsSync(src)) return null;
  const storedName = `cp-${share.id.slice(-8)}-${randomToken(10)}${extOf(vaultDoc.storedName)}`;
  fs.copyFileSync(src, filePath('documents', storedName));
  try {
    return await prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          ownerId: carrier.ownerId, uploadedById: carrier.ownerId, carrierId: carrier.id, type: DOCUMENT_TYPE[vaultDoc.type] || 'other',
          originalName: `${cleanName(`${VAULT_LABEL[vaultDoc.type] || 'Document'} - ${companyName}`)}${extOf(vaultDoc.storedName)}`,
          storedName, mimeType: vaultDoc.mimeType, sizeBytes: vaultDoc.sizeBytes, expiresAt: vaultDoc.expiresAt, source: 'carrier_profile',
        },
      });
      await tx.carrierShareDoc.create({ data: { shareId: share.id, vaultDocumentId: vaultDoc.id, documentId: doc.id } });
      return doc;
    });
  } catch (err) {
    removeFile('documents', storedName);
    if (err?.code === 'P2002') return null; // a parallel request copied it first
    throw err;
  }
}

/** Current (not replaced) vault documents of an account. */
export const currentDocuments = (accountId, types = null) => prisma.carrierVaultDocument.findMany({
  where: { accountId, replacedAt: null, ...(types ? { type: { in: types } } : {}) },
  orderBy: { createdAt: 'desc' },
});

/**
 * Share document types with a dispatcher: saves the choice and copies the current documents of those types.
 * Returns { share, copied } (copied = number of new files the dispatcher received).
 */
export async function shareWith(account, carrierId, { docTypes, autoUpdate = true }) {
  const types = [...new Set((docTypes || []).filter((t) => VAULT_TYPES.includes(t)))];
  if (!types.length) throw badRequest('Pick at least one document to share.');
  const carrier = await connectionRow(account, carrierId);
  const share = await prisma.carrierShare.upsert({
    where: { accountId_carrierId: { accountId: account.id, carrierId: carrier.id } },
    create: { accountId: account.id, carrierId: carrier.id, ownerId: carrier.ownerId, docTypes: types.join(','), autoUpdate: !!autoUpdate },
    update: { docTypes: types.join(','), autoUpdate: !!autoUpdate, hidden: false, revokedAt: null, ownerId: carrier.ownerId },
  });
  const company = account.legalName || carrier.companyName;
  let copied = 0;
  for (const d of await currentDocuments(account.id, types)) {
    if (await copyToDispatcher(share, carrier, d, company)) copied += 1;
  }
  const names = types.map((t) => VAULT_LABEL[t]).join(', ');
  await logActivity(carrier.owner, { type: 'document', carrierId: carrier.id, summary: `${company} shared ${copied ? `${copied} document${copied === 1 ? '' : 's'}` : 'access'} from their DispatchDesk carrier profile (${names})` }).catch(() => {});
  if (copied) {
    await notify(carrier.ownerId, { type: 'onboarding', title: `${company} shared ${copied} document${copied === 1 ? '' : 's'} with you`.slice(0, 200), body: names, link: `/app/carriers/${carrier.id}?tab=documents` }).catch(() => {});
  }
  return { share, copied };
}

/** Stop sharing with a dispatcher (no further copies). `hide` also removes the connection from the carrier's list. */
export async function stopSharing(account, carrierId, { hide = false } = {}) {
  const carrier = await connectionRow(account, carrierId);
  await prisma.carrierShare.upsert({
    where: { accountId_carrierId: { accountId: account.id, carrierId: carrier.id } },
    create: { accountId: account.id, carrierId: carrier.id, ownerId: carrier.ownerId, docTypes: '', autoUpdate: false, hidden: !!hide, revokedAt: new Date() },
    update: { autoUpdate: false, revokedAt: new Date(), ...(hide ? { hidden: true } : {}) },
  });
  await logActivity(carrier.owner, { type: 'document', carrierId: carrier.id, summary: `${account.legalName || carrier.companyName} stopped sharing documents from their DispatchDesk carrier profile` }).catch(() => {});
}

/** After a new vault upload: send it to every dispatcher that shares this type with auto-update on. Returns the count. */
export async function fanOutUpload(account, vaultDoc) {
  const shares = await prisma.carrierShare.findMany({
    where: { accountId: account.id, revokedAt: null, hidden: false, autoUpdate: true },
    include: { carrier: { include: { owner: { include: { teamMembership: true } } } } },
  });
  let sent = 0;
  for (const s of shares) {
    if (!s.docTypes.split(',').includes(vaultDoc.type)) continue;
    if (s.carrier.dotNumber !== account.dotNumber) continue; // the dispatcher changed the record's USDOT number
    const company = account.legalName || s.carrier.companyName;
    const doc = await copyToDispatcher(s, s.carrier, vaultDoc, company).catch(() => null);
    if (!doc) continue;
    sent += 1;
    await logActivity(s.carrier.owner, { type: 'document', carrierId: s.carrier.id, summary: `${company} sent an updated ${VAULT_LABEL[vaultDoc.type]} from their DispatchDesk carrier profile` }).catch(() => {});
    await notify(s.carrier.ownerId, { type: 'onboarding', title: `${company} sent an updated ${VAULT_LABEL[vaultDoc.type]}`.slice(0, 200), body: 'From their DispatchDesk carrier profile', link: `/app/carriers/${s.carrier.id}?tab=documents` }).catch(() => {});
  }
  return sent;
}

/** What a dispatcher may see about the carrier's account on its own record: only its own share. */
export async function shareForDispatcher(carrierId) {
  const s = await prisma.carrierShare.findFirst({ where: { carrierId }, include: { account: { select: { verifiedAt: true } } } });
  if (!s) return null;
  return {
    verifiedAt: s.account.verifiedAt,
    docTypes: s.docTypes ? s.docTypes.split(',').filter(Boolean) : [],
    autoUpdate: s.autoUpdate,
    active: !s.revokedAt && !s.hidden && !!s.docTypes,
    updatedAt: s.updatedAt,
  };
}
