import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { randomToken, sha256 } from '../../lib/crypto.js';

/**
 * Consent-based live location. A dispatcher creates a share for a carrier; the driver opens
 * `${APP_URL}/track/<token>` on their phone, agrees, and the page sends GPS fixes while it is open.
 * Only the sha256 of the token is stored. Pings are kept 30 days.
 */
export const SHARE_HOURS = [8, 24, 72, 168];
export const ACTIVE_SHARE = ['pending', 'sharing', 'paused'];
export const MIN_PING_MS = 10_000;
export const MAX_PINGS_PER_DAY = 600;
export const PING_RETENTION_DAYS = 30;

export const trackUrl = (token) => `${config.appUrl}/track/${token}`;

const digits = (p) => String(p || '').replace(/\D/g, '');
const e164 = (p) => { const d = digits(p); return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : d ? `+${d}` : null; };

/** Prefilled message plus the links a dispatcher can send it with. */
export function shareMessage({ companyName, link, driverPhone }) {
  const text = `${companyName} dispatch: share your location for today's trip: ${link}`;
  const to = e164(driverPhone);
  return {
    text,
    sms: `sms:${to || ''}?&body=${encodeURIComponent(text)}`,
    googleVoice: to ? `https://voice.google.com/u/0/messages?itemId=t.${encodeURIComponent(to)}` : 'https://voice.google.com/u/0/messages',
    email: `mailto:?subject=${encodeURIComponent(`${companyName}: share your location`)}&body=${encodeURIComponent(text)}`,
  };
}

export async function createShare(user, carrier, { driverName, driverPhone, loadId, hours }) {
  const token = randomToken(24);
  const share = await prisma.locationShare.create({
    data: {
      carrierId: carrier.id, ownerId: user.id, tokenHash: sha256(token),
      driverName: driverName || null, driverPhone: driverPhone || carrier.phone || null, loadId: loadId || null,
      status: 'pending', expiresAt: new Date(Date.now() + hours * 3600_000),
    },
  });
  const link = trackUrl(token);
  return { share, token, link, message: shareMessage({ companyName: carrier.companyName, link, driverPhone: share.driverPhone }) };
}

export function shareView(s, now = Date.now()) {
  const expired = new Date(s.expiresAt).getTime() <= now;
  return {
    id: s.id, carrierId: s.carrierId, driverName: s.driverName, driverPhone: s.driverPhone, loadId: s.loadId,
    status: expired && ACTIVE_SHARE.includes(s.status) ? 'expired' : s.status,
    consentAt: s.consentAt, expiresAt: s.expiresAt, createdAt: s.createdAt,
    last: s.lastAt ? { lat: s.lastLat, lng: s.lastLng, accuracyM: s.lastAccuracy, speedMph: s.lastSpeed != null ? Math.round(s.lastSpeed * 2.23694) : null, heading: s.lastHeading, at: s.lastAt } : null,
  };
}

/** Resolve a public token. Returns { share } or { gone: reason }. */
export async function findShareByToken(token) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(token || ''))) return { gone: 'invalid' };
  const share = await prisma.locationShare.findUnique({
    where: { tokenHash: sha256(token) },
    include: { carrier: true, owner: { select: { id: true, name: true } } },
  });
  if (!share) return { gone: 'invalid' };
  if (share.status === 'stopped') return { gone: 'stopped', share };
  if (share.status === 'expired' || share.expiresAt <= new Date()) {
    if (share.status !== 'expired') await prisma.locationShare.update({ where: { id: share.id }, data: { status: 'expired' } }).catch(() => {});
    return { gone: 'expired', share };
  }
  return { share };
}

/** Delete pings older than the retention window. Safe to call from the scheduler. */
export async function prunePings(now = new Date()) {
  const cutoff = new Date(now.getTime() - PING_RETENTION_DAYS * 86400000);
  const { count } = await prisma.locationPing.deleteMany({ where: { at: { lt: cutoff } } });
  // Shares past their expiry are marked expired so the map stops calling them live.
  await prisma.locationShare.updateMany({ where: { status: { in: ACTIVE_SHARE }, expiresAt: { lte: now } }, data: { status: 'expired' } });
  return count;
}
