import crypto from 'node:crypto';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { randomToken, sha256, hmac, safeEqual } from '../../lib/crypto.js';
import { haversineMiles } from '../market/geo.js';

/**
 * Consent-based live location. A dispatcher creates a share for a carrier; the driver opens
 * `${APP_URL}/track/<token>` on their phone, agrees, and the page sends GPS fixes while it is open.
 * Only the sha256 of the token is stored. Pings are kept 30 days.
 *
 * Anti-forwarding: the first phone that claims a link (PIN, consent or check-in) gets a device secret; only its hash
 * is stored and every later request must carry it, so a forwarded link does not work on a second phone.
 * An optional 6-digit PIN (read to the driver separately) must be entered before anything is shown.
 * Each fix is checked for plausibility; implausible jumps never move the truck on the dispatcher's map.
 */
export const SHARE_HOURS = [8, 24, 72, 168];
export const CLAIM_MINUTES = [30, 120, 360];
export const ACTIVE_SHARE = ['pending', 'sharing', 'paused'];
export const MIN_PING_MS = 10_000;
export const MAX_PINGS_PER_DAY = 600;
export const PING_RETENTION_DAYS = 30;

export const PIN_MAX_ATTEMPTS = 5;
const FLAG_CAP = 50;
const FLAG_DEDUPE_MS = 10 * 60_000;
export const ALERT_EVERY_MS = 30 * 60_000;
const RECENT_MS = 6 * 3600_000;
const JUMP_MPH = 110;
const JUMP_MILES = 300;
const LOW_ACCURACY_M = 1000;
const CLOCK_SKEW_MS = 10 * 60_000;
const FAR_FROM_TRIP_MILES = 150;
const REFERENCE_MAX_AGE_MS = 24 * 3600_000; // a dispatcher-set position older than this is not used to judge jumps

export const trackUrl = (token) => `${config.appUrl}/track/${token}`;

const digits = (p) => String(p || '').replace(/\D/g, '');
const e164 = (p) => { const d = digits(p); return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : d ? `+${d}` : null; };

/** Prefilled message plus the links a dispatcher can send it with. The PIN is never part of the message. */
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

// ---------------------------------------------------------------------------
// PIN and device helpers
// ---------------------------------------------------------------------------

/** A uniformly random 6-digit PIN. */
export const newPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** PINs are stored as an HMAC keyed with the app secret and salted with the link's token hash. */
export const pinHashFor = (tokenHash, pin) => hmac(`pin:${tokenHash}:${pin}`);

export function checkPin(share, pin) {
  const clean = String(pin ?? '').replace(/\D/g, '');
  if (!share.pinHash || clean.length !== 6) return false;
  return safeEqual(pinHashFor(share.tokenHash, clean), share.pinHash);
}

export const deviceHashFor = (secret) => sha256(`device:${secret}`);

export function deviceMatches(share, header) {
  const secret = String(header || '').trim();
  if (!share.deviceHash || !secret || secret.length > 200) return false;
  return safeEqual(deviceHashFor(secret), share.deviceHash);
}

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i;
const DESKTOP_UA = /Windows NT|Macintosh|X11|Linux x86_64|CrOS/i;

/** Short, human device label ("iPhone · Safari") and a kind: mobile | desktop | unknown. Signals come from the page. */
export function describeDevice(ua = '', signals = {}) {
  const u = String(ua);
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /CrOS/.test(u) ? 'Chromebook'
    : /Windows NT/.test(u) ? 'Windows' : /Macintosh/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : null;
  const browser = /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera'
    : /Firefox|FxiOS/.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : null;
  const touch = signals?.touch === true;
  const coarse = signals?.coarse === true;
  let kind = 'unknown';
  // iPadOS Safari reports a Mac user agent; a touch screen with a coarse pointer is treated as a phone/tablet.
  if (MOBILE_UA.test(u) || (touch && coarse)) kind = 'mobile';
  else if (DESKTOP_UA.test(u) || (signals && signals.touch === false && signals.coarse === false)) kind = 'desktop';
  const label = [os === 'Mac' && touch && coarse ? 'iPad' : os, browser].filter(Boolean).join(' · ') || 'Unknown device';
  return { label: label.slice(0, 60), kind };
}

/** Coarse network only (/24 for IPv4, /48 for IPv6): enough to tell two places apart, never the full address. */
export function coarseIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (s === '::1' || s.startsWith('127.')) return 'this server';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return `${s.split('.').slice(0, 3).join('.')}.x`;
  if (s.includes(':')) {
    // Keep the first three groups; "::" compression means the omitted groups are zeros.
    const [head, tail] = s.split('::');
    const groups = head.split(':').filter(Boolean);
    if (tail !== undefined) while (groups.length < 3) groups.push('0');
    return groups.length ? `${groups.slice(0, 3).join(':')}::/48` : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flags (stored on the share as a capped JSON list)
// ---------------------------------------------------------------------------

export function parseFlags(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** Prepend new flags (dropping a repeat of the same type and detail within 10 minutes) and cap the list. */
export function addFlags(raw, items, now = new Date()) {
  const list = parseFlags(raw);
  const t = now.getTime();
  for (const f of items) {
    const dup = list.find((x) => x.type === f.type && (x.detail || '') === (f.detail || '') && t - Date.parse(x.at) < FLAG_DEDUPE_MS);
    if (!dup) list.unshift({ type: f.type, at: now.toISOString(), detail: f.detail ? String(f.detail).slice(0, 160) : undefined });
  }
  return JSON.stringify(list.slice(0, FLAG_CAP));
}

const FLAG_TEXT = {
  other_device: 'Opened on another device',
  wrong_pin: 'Wrong PIN entered',
  impossible_jump: 'GPS jumped too far to be real',
  low_accuracy: 'Very low GPS accuracy',
  desktop: 'Shared from a computer',
  stale_clock: "Phone clock doesn't match",
  far_from_trip: 'Far from the loaded trip route',
  locked: 'Locked after wrong PINs',
  off_route: 'Off the planned road route',
};
export const flagText = (type) => FLAG_TEXT[type] || type;

// ---------------------------------------------------------------------------
// Plausibility checks for one fix
// ---------------------------------------------------------------------------

/** Distance in miles from point p to segment a–b (equirectangular projection; fine at trip scale). */
export function milesToSegment(p, a, b) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const toXY = (q) => ({ x: q.lng * 69.172 * k, y: q.lat * 69.0 });
  const P = toXY(p); const A = toXY(a); const B = toXY(b);
  const dx = B.x - A.x; const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2)) : 0;
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

/**
 * Judge a fix. `reference` is the last trusted position ({ lat, lng, at, accuracy }); `trip` has { status, origin, dest }
 * points and, when the load has a road route, `offRouteMiles` (distance from that route, used instead of the straight line).
 * Returns { flags: [{ type, detail }], trusted } where trusted=false means the fix must not move the truck.
 */
export function evaluateFix({ fix, reference, trip, deviceKind, now = new Date() }) {
  const flags = [];
  let trusted = true;
  if (fix.accuracy != null && fix.accuracy > LOW_ACCURACY_M) {
    flags.push({ type: 'low_accuracy', detail: `±${Math.round(fix.accuracy / 100) / 10} km` });
  }
  if (fix.clientTime != null && Number.isFinite(fix.clientTime) && Math.abs(now.getTime() - fix.clientTime) > CLOCK_SKEW_MS) {
    flags.push({ type: 'stale_clock', detail: `${Math.round(Math.abs(now.getTime() - fix.clientTime) / 60000)} min off` });
  }
  if (deviceKind === 'desktop') flags.push({ type: 'desktop' });
  if (reference && reference.lat != null && reference.at) {
    const miles = haversineMiles([reference.lat, reference.lng], [fix.lat, fix.lng]);
    const hours = Math.max((now.getTime() - new Date(reference.at).getTime()) / 3600_000, 1 / 3600);
    // GPS noise must not trip the check: ignore moves smaller than a few miles or twice the combined accuracy.
    const noiseMiles = Math.max(3, (((fix.accuracy || 0) + (reference.accuracy || 0)) / 1609.34) * 2);
    const mph = miles / hours;
    if (miles > noiseMiles && (mph > JUMP_MPH || (miles > JUMP_MILES && hours < 3))) {
      flags.push({ type: 'impossible_jump', detail: `${Math.round(miles)} mi in ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${Math.round(hours * 10) / 10} h`}` });
      trusted = false;
    }
  }
  // A loaded truck should be on its lane; before pickup a long empty run is normal, so only in-transit trips are checked.
  if (trip?.status === 'in_transit' && (trip.offRouteMiles != null || (trip.origin && trip.dest))) {
    const off = trip.offRouteMiles != null ? trip.offRouteMiles : milesToSegment(fix, trip.origin, trip.dest);
    if (off > FAR_FROM_TRIP_MILES) flags.push({ type: 'far_from_trip', detail: `${Math.round(off)} mi off the route` });
  }
  return { flags, trusted };
}

/** The position a new fix is compared against: the latest of the share's last trusted fix and a recent dispatcher-set position. */
export function referenceFor(share, carrier, now = new Date()) {
  const cands = [];
  if (share.trustedAt && share.trustedLat != null) cands.push({ lat: share.trustedLat, lng: share.trustedLng, at: share.trustedAt, accuracy: share.lastAccuracy });
  if (carrier && carrier.locationSource !== 'driver_link' && carrier.locationLat != null && carrier.locationUpdatedAt
    && now.getTime() - new Date(carrier.locationUpdatedAt).getTime() < REFERENCE_MAX_AGE_MS) {
    cands.push({ lat: carrier.locationLat, lng: carrier.locationLng, at: carrier.locationUpdatedAt, accuracy: null });
  }
  cands.sort((a, b) => new Date(b.at) - new Date(a.at));
  return cands[0] || null;
}

// ---------------------------------------------------------------------------
// Trust summary shown to the dispatcher
// ---------------------------------------------------------------------------

/** Confidence (high | medium | low | null when not opened) with plain-language reasons. */
export function trustFor(s, now = Date.now()) {
  const flags = parseFlags(s.flags);
  const within = (ms, type) => flags.filter((f) => f.type === type && now - Date.parse(f.at) < ms);
  const last = new Set(String(s.lastPingFlags || '').split(',').filter(Boolean));
  const legacy = !s.deviceHash && !s.firstBoundAt && !!s.consentAt;
  const base = {
    pinEnabled: !!s.pinHash, pinVerified: !!s.pinVerifiedAt, deviceLabel: s.deviceLabel || null, deviceKind: s.deviceKind || null,
    recentFlags: flags.slice(0, 5).map((f) => ({ type: f.type, at: f.at, detail: f.detail || null, text: flagText(f.type) })),
  };
  if (!s.deviceHash && !legacy) return { ...base, confidence: null, reasons: [s.status === 'locked' ? 'Locked after too many wrong PINs' : 'Not opened by the driver yet'] };

  const bad = [];
  const warn = [];
  const good = [];
  if (last.has('impossible_jump')) bad.push('Latest GPS fix jumped too far to be real, so it was not used');
  else if (within(3600_000, 'impossible_jump').length) bad.push('GPS jumped in the last hour');
  if (last.has('far_from_trip')) bad.push('Far from the loaded trip route');
  if (s.deviceKind === 'desktop' || within(RECENT_MS, 'desktop').length) bad.push('Shared from a computer, not a phone');
  if (s.lastAccuracy != null && s.lastAccuracy > LOW_ACCURACY_M) bad.push(`Low accuracy (±${Math.round(s.lastAccuracy / 100) / 10} km), typical of Wi-Fi or a computer`);

  const others = within(RECENT_MS, 'other_device');
  if (others.length) warn.push(`Someone tried the link on another device (${others.length}×)`);
  if (within(RECENT_MS, 'wrong_pin').length) warn.push('Wrong PIN entered');
  if (last.has('stale_clock')) warn.push("Phone clock doesn't match the server");
  if (legacy) warn.push('Link created before phone locking');
  else if (!s.pinHash) warn.push('No PIN on this link');
  if (!legacy && (!s.deviceKind || s.deviceKind === 'unknown')) warn.push('Device type unknown');

  if (s.deviceHash) good.push(`Locked to one phone${s.deviceLabel ? ` (${s.deviceLabel})` : ''}`);
  if (s.pinVerifiedAt) good.push('PIN checked');
  if (s.lastAccuracy != null && s.lastAccuracy <= 100) good.push(`Phone GPS ±${Math.round(s.lastAccuracy)} m`);

  const confidence = bad.length ? 'low' : warn.length ? 'medium' : 'high';
  return { ...base, confidence, reasons: [...bad, ...warn, ...good] };
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------

export async function createShare(user, carrier, { driverName, driverPhone, loadId, hours, pin = true, claimMinutes = 120 }) {
  const token = randomToken(24);
  const tokenHash = sha256(token);
  const code = pin ? newPin() : null;
  const share = await prisma.locationShare.create({
    data: {
      carrierId: carrier.id, ownerId: user.id, tokenHash,
      driverName: driverName || null, driverPhone: driverPhone || carrier.phone || null, loadId: loadId || null,
      // Until a phone claims the link it expires after the claim window; claiming starts the full duration.
      status: 'pending', durationHours: hours, claimMinutes, expiresAt: new Date(Date.now() + claimMinutes * 60_000),
      pinHash: code ? pinHashFor(tokenHash, code) : null,
    },
  });
  const link = trackUrl(token);
  return { share, token, link, pin: code, message: shareMessage({ companyName: carrier.companyName, link, driverPhone: share.driverPhone }) };
}

export function shareView(s, now = Date.now()) {
  const expired = new Date(s.expiresAt).getTime() <= now;
  return {
    id: s.id, carrierId: s.carrierId, driverName: s.driverName, driverPhone: s.driverPhone, loadId: s.loadId,
    status: expired && ACTIVE_SHARE.includes(s.status) ? 'expired' : s.status,
    consentAt: s.consentAt, expiresAt: s.expiresAt, createdAt: s.createdAt,
    durationHours: s.durationHours, claimBy: s.firstBoundAt ? null : s.expiresAt,
    deviceBoundAt: s.deviceBoundAt, pinAttemptsLeft: s.pinHash ? Math.max(0, PIN_MAX_ATTEMPTS - (s.pinAttempts || 0)) : null,
    trust: trustFor(s, now),
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
  if (share.status === 'locked') return { gone: 'locked', share };
  if (share.status === 'expired' || share.expiresAt <= new Date()) {
    if (share.status !== 'expired') await prisma.locationShare.update({ where: { id: share.id }, data: { status: 'expired' } }).catch(() => {});
    return { gone: share.firstBoundAt || share.consentAt ? 'expired' : 'unopened', share };
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
