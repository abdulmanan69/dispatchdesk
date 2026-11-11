import cluster from 'node:cluster';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ClusterMemoryStoreWorker } from '@express-rate-limit/cluster-memory-store';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { broadcast, onBroadcast } from '../lib/broadcast.js';
import { linkLimiter } from '../middleware/security.js';

/**
 * Public, private iCalendar feed: GET /api/public/calendar/<token>.ics
 * The token in the URL is the credential (only its sha256 is stored, in User.calendarTokenHash). The feed holds the
 * user's own load pickups and deliveries (appointment windows when set, otherwise all-day), pending follow-ups,
 * invoice due dates (sent or partly paid) and document expirations, from 14 days back to 60 days ahead, at most
 * MAX_EVENTS events. `?names=0` leaves carrier, broker and customer names out.
 * Each feed is cached for 5 minutes per process; rotating or turning off a link drops it in every process.
 */
const r = Router();

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 2000;
const CACHE_MAX_BYTES = 32 * 1024 * 1024; // per process
export const MAX_EVENTS = 500;
const DAY = 86400000;

// ---------------------------------------------------------------------------------------------------------------
// RFC 5545 text helpers
// ---------------------------------------------------------------------------------------------------------------

/** Escape a TEXT value: backslash, semicolon, comma and newlines. Other control characters are dropped. */
export function icsEscape(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Fold a content line at 75 octets (continuation lines start with one space), never splitting a UTF-8 character. */
export function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > limit) {
      out.push(current);
      current = '';
      bytes = 0;
      limit = 74; // the leading space of a continuation line counts toward its 75 octets
    }
    current += ch;
    bytes += n;
  }
  if (current) out.push(current);
  return out.join('\r\n ');
}

const pad = (n) => String(n).padStart(2, '0');
/** UTC date-time, e.g. 20261112T143000Z. */
export const icsDateTime = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}${pad(x.getUTCSeconds())}Z`;
};

// Building an Intl formatter costs about 0.1 ms and a feed checks zones a few times per event, so the answer is cached.
const zoneOk = new Map(); // zone name -> valid?
const validZone = (tz) => {
  if (!tz) return null;
  let ok = zoneOk.get(tz);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true; } catch { ok = false; }
    if (zoneOk.size >= 1000) zoneOk.clear();
    zoneOk.set(tz, ok);
  }
  return ok ? tz : null;
};

const ymdCache = new Map();
/** Calendar date (YYYYMMDD) of an instant in a time zone. */
export function icsDate(d, tz) {
  const zone = validZone(tz) || 'UTC';
  let f = ymdCache.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }); ymdCache.set(zone, f); }
  const parts = Object.fromEntries(f.formatToParts(new Date(d)).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}
const nextDay = (ymd) => {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)) + 1);
  const x = new Date(t);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}`;
};

const timeFmtCache = new Map();
/** "8:00 AM CST" in the given zone (falls back to UTC). */
function localTime(d, tz) {
  const zone = validZone(tz) || 'UTC';
  let f = timeFmtCache.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); timeFmtCache.set(zone, f); }
  return f.format(new Date(d));
}

const moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (cents) => `$${moneyFmt.format(Number(cents || 0) / 100)}`;
const place = (city, state) => [city, state].filter(Boolean).join(', ');
const LABEL = { call: 'Call', email: 'Email', text: 'Text', task: 'Task', meeting: 'Meeting' };
const DOC_LABEL = { agreement: 'Agreement', mc_authority: 'MC authority', w9: 'W-9', coi: 'Certificate of insurance', permit: 'Permit', rate_confirmation: 'Rate confirmation', bol: 'Bill of lading', pod: 'Proof of delivery', lumper_receipt: 'Lumper receipt', scale_ticket: 'Scale ticket', fuel_receipt: 'Fuel receipt', other: 'Document' };

/**
 * Serialize events to an iCalendar document.
 * event: { uid, start, end?, allDay?, tz?, summary, description?, location?, url?, updated?, status?, alarmMinutes?, category? }
 */
export function buildIcs(events, { name = 'DispatchDesk', description = '', timezone = 'UTC', now = new Date() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DispatchDesk//Calendar feed 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    ...(description ? [`X-WR-CALDESC:${icsEscape(description)}`] : []),
    `X-WR-TIMEZONE:${icsEscape(validZone(timezone) || 'UTC')}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of events) {
    const stamp = icsDateTime(e.updated || now);
    lines.push('BEGIN:VEVENT', `UID:${icsEscape(e.uid)}`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`);
    if (e.allDay) {
      const day = icsDate(e.start, e.tz || timezone);
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextDay(day)}`);
    } else {
      const end = e.end && new Date(e.end) > new Date(e.start) ? e.end : new Date(new Date(e.start).getTime() + 30 * 60000);
      lines.push(`DTSTART:${icsDateTime(e.start)}`, `DTEND:${icsDateTime(end)}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
    if (e.url) lines.push(`URL:${String(e.url).replace(/[\r\n]/g, '')}`);
    if (e.category) lines.push(`CATEGORIES:${icsEscape(e.category)}`);
    lines.push(`STATUS:${e.status || 'CONFIRMED'}`, 'TRANSP:TRANSPARENT');
    if (!e.allDay && e.alarmMinutes != null) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(e.summary)}`, `TRIGGER:-PT${Math.max(0, Math.round(e.alarmMinutes))}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Feed contents
// ---------------------------------------------------------------------------------------------------------------

const uidHost = () => { try { return new URL(config.appUrl).hostname || 'dispatchdesk'; } catch { return 'dispatchdesk'; } };
const appLink = (path) => `${config.appUrl}${path}`;

function loadStop(load, kind, { names, tz }) {
  const pickup = kind === 'pickup';
  const windowStart = pickup ? load.pickupWindowStart : load.deliveryWindowStart;
  const windowEnd = pickup ? load.pickupWindowEnd : load.deliveryWindowEnd;
  const day = pickup ? load.pickupDate : load.deliveryDate;
  const start = windowStart || day;
  if (!start) return null;
  const stopTz = validZone(pickup ? load.pickupTz : load.deliveryTz) || tz;
  const from = place(load.originCity, load.originState);
  const to = place(load.destCity, load.destState);
  const facility = pickup ? load.pickupFacility : load.deliveryFacility;
  const address = pickup ? load.pickupAddress : load.deliveryAddress;
  const ref = load.referenceNumber ? `#${load.referenceNumber} ` : '';
  const description = [
    `${pickup ? 'Pickup' : 'Delivery'} for load ${ref}${from} to ${to}`.replace(/\s+/g, ' ').trim(),
    windowStart ? `Appointment ${localTime(windowStart, stopTz)}${windowEnd ? ` to ${localTime(windowEnd, stopTz)}` : ''} (facility time)` : 'No appointment time set',
    names && load.carrier?.companyName ? `Carrier: ${load.carrier.companyName}` : null,
    names && load.broker?.companyName ? `Broker: ${load.broker.companyName}` : null,
    load.equipment ? `Equipment: ${String(load.equipment).replace(/_/g, ' ')}` : null,
    `Status: ${String(load.status).replace(/_/g, ' ')}`,
    `Open in DispatchDesk: ${appLink('/app/loads')}`,
  ].filter(Boolean).join('\n');
  return {
    uid: `load-${load.id}-${kind}@${uidHost()}`,
    start,
    end: windowStart ? windowEnd || new Date(new Date(windowStart).getTime() + 60 * 60000) : null,
    allDay: !windowStart,
    tz: stopTz,
    summary: `${pickup ? 'Pickup' : 'Delivery'}: ${pickup ? from : to}${names && load.carrier?.companyName ? ` · ${load.carrier.companyName}` : ''}`,
    location: [facility, address || (pickup ? from : to)].filter(Boolean).join(', '),
    description,
    url: appLink('/app/loads'),
    updated: load.updatedAt,
    status: load.status === 'planned' ? 'TENTATIVE' : 'CONFIRMED',
    alarmMinutes: windowStart ? 60 : null,
    category: pickup ? 'Pickup' : 'Delivery',
  };
}

/** All events for a user's feed (bounded), soonest upcoming first, then the most recent past ones. */
export async function feedEvents(user, { names = true, now = new Date() } = {}) {
  const tz = validZone(user.timezone) || 'America/Chicago';
  const from = new Date(now.getTime() - 14 * DAY);
  const to = new Date(now.getTime() + 60 * DAY);
  const range = { gte: from, lte: to };
  const followUpSelect = { id: true, dueAt: true, type: true, title: true, note: true, remindMinutesBefore: true, updatedAt: true, carrier: { select: { id: true, companyName: true } } };
  // Loads: upcoming stops (from yesterday on) soonest first, and a smaller list of past ones newest first, so when a
  // list is longer than its cap the furthest-out and the oldest items are left out, never today's.
  const recent = new Date(now.getTime() - DAY);
  const loadSelect = {
    id: true, referenceNumber: true, status: true, equipment: true, updatedAt: true,
    originCity: true, originState: true, destCity: true, destState: true,
    pickupDate: true, deliveryDate: true, pickupWindowStart: true, pickupWindowEnd: true, deliveryWindowStart: true, deliveryWindowEnd: true,
    pickupTz: true, deliveryTz: true, pickupFacility: true, pickupAddress: true, deliveryFacility: true, deliveryAddress: true,
    carrier: { select: { companyName: true } }, broker: { select: { companyName: true } },
  };
  const stopsIn = (r) => [{ pickupDate: r }, { deliveryDate: r }, { pickupWindowStart: r }, { deliveryWindowStart: r }];
  const [upcomingLoads, pastLoads, upcomingFollowUps, overdueFollowUps, upcomingInvoices, pastInvoices, documents] = await Promise.all([
    prisma.load.findMany({
      where: { ownerId: user.id, status: { not: 'canceled' }, OR: stopsIn({ gte: recent, lte: to }) },
      select: loadSelect,
      orderBy: [{ pickupDate: { sort: 'asc', nulls: 'last' } }, { deliveryDate: { sort: 'asc', nulls: 'last' } }],
      take: 200,
    }),
    prisma.load.findMany({
      where: {
        ownerId: user.id, status: { not: 'canceled' },
        // Loads that also have an upcoming stop are in the first list (duplicates are dropped below).
        OR: stopsIn({ gte: from, lt: recent }),
      },
      select: loadSelect,
      orderBy: { pickupDate: { sort: 'desc', nulls: 'last' } },
      take: 50,
    }),
    prisma.followUp.findMany({
      where: { userId: user.id, status: 'pending', dueAt: { gte: now, lte: to } },
      select: followUpSelect,
      orderBy: { dueAt: 'asc' },
      take: 150,
    }),
    prisma.followUp.findMany({
      where: { userId: user.id, status: 'pending', dueAt: { gte: new Date(now.getTime() - 7 * DAY), lt: now } },
      select: followUpSelect,
      orderBy: { dueAt: 'desc' },
      take: 50,
    }),
    prisma.invoice.findMany({
      where: { ownerId: user.id, status: { in: ['sent', 'partial'] }, dueAt: { gte: recent, lte: to } },
      select: { id: true, number: true, kind: true, dueAt: true, amountCents: true, paidCents: true, billToName: true, updatedAt: true },
      orderBy: { dueAt: 'asc' },
      take: 100,
    }),
    prisma.invoice.findMany({
      where: { ownerId: user.id, status: { in: ['sent', 'partial'] }, dueAt: { gte: new Date(now.getTime() - 30 * DAY), lt: recent } },
      select: { id: true, number: true, kind: true, dueAt: true, amountCents: true, paidCents: true, billToName: true, updatedAt: true },
      orderBy: { dueAt: 'desc' },
      take: 30,
    }),
    prisma.document.findMany({
      where: { ownerId: user.id, expiresAt: { gte: new Date(now.getTime() - 7 * DAY), lte: to } },
      select: { id: true, type: true, expiresAt: true, updatedAt: true, carrierId: true, carrier: { select: { companyName: true } } },
      orderBy: { expiresAt: 'asc' },
      take: 100,
    }),
  ]);

  const loads = [...upcomingLoads, ...pastLoads.filter((l) => !upcomingLoads.some((u) => u.id === l.id))];
  const invoices = [...upcomingInvoices, ...pastInvoices];
  const events = [];
  for (const l of loads) {
    for (const kind of ['pickup', 'delivery']) {
      const e = loadStop(l, kind, { names, tz });
      if (e) events.push(e);
    }
  }
  for (const f of [...upcomingFollowUps, ...overdueFollowUps]) {
    const what = LABEL[f.type] || 'Follow-up';
    const who = names && f.carrier?.companyName ? f.carrier.companyName : null;
    events.push({
      uid: `followup-${f.id}@${uidHost()}`,
      start: f.dueAt,
      end: new Date(new Date(f.dueAt).getTime() + 15 * 60000),
      summary: `${what}${who ? `: ${who}` : ' follow-up'}${f.title && names ? ` · ${f.title}` : ''}`,
      description: [names && f.note ? f.note : null, `Open in DispatchDesk: ${appLink(f.carrier?.id ? `/app/carriers/${f.carrier.id}` : '/app/follow-ups')}`].filter(Boolean).join('\n'),
      url: appLink(f.carrier?.id ? `/app/carriers/${f.carrier.id}` : '/app/follow-ups'),
      updated: f.updatedAt,
      alarmMinutes: f.remindMinutesBefore > 0 ? f.remindMinutesBefore : 0,
      category: 'Follow-up',
    });
  }
  for (const inv of invoices) {
    const open = Math.max(0, (inv.amountCents || 0) - (inv.paidCents || 0));
    events.push({
      uid: `invoice-${inv.id}@${uidHost()}`,
      start: inv.dueAt,
      allDay: true,
      summary: `Invoice #${inv.number} due: ${money(open)}${names && inv.billToName ? ` · ${inv.billToName}` : ''}`,
      description: [
        `${inv.kind === 'dispatch_fee' ? 'Dispatch fee invoice' : 'Freight invoice'} #${inv.number}`,
        `Open balance ${money(open)} of ${money(inv.amountCents)}`,
        `Open in DispatchDesk: ${appLink('/app/invoices')}`,
      ].join('\n'),
      url: appLink('/app/invoices'),
      updated: inv.updatedAt,
      category: 'Invoice',
    });
  }
  for (const d of documents) {
    const label = DOC_LABEL[d.type] || 'Document';
    const who = names && d.carrier?.companyName ? d.carrier.companyName : null;
    events.push({
      uid: `document-${d.id}@${uidHost()}`,
      start: d.expiresAt,
      allDay: true,
      summary: `${label} expires${who ? `: ${who}` : ''}`,
      description: `Ask for an updated copy before it expires.\nOpen in DispatchDesk: ${appLink(d.carrierId ? `/app/carriers/${d.carrierId}` : '/app')}`,
      url: appLink(d.carrierId ? `/app/carriers/${d.carrierId}` : '/app'),
      updated: d.updatedAt,
      category: 'Document',
    });
  }

  const t = (e) => new Date(e.start).getTime();
  const nowMs = now.getTime() - DAY; // all-day items of today still count as upcoming
  const upcoming = events.filter((e) => t(e) >= nowMs).sort((a, b) => t(a) - t(b));
  const past = events.filter((e) => t(e) < nowMs).sort((a, b) => t(b) - t(a));
  return [...upcoming, ...past].slice(0, MAX_EVENTS);
}

export async function buildFeed(user, opts = {}) {
  const now = opts.now || new Date();
  const events = await feedEvents(user, { ...opts, now });
  return buildIcs(events, {
    name: 'DispatchDesk',
    description: 'Pickups, deliveries, follow-ups, invoice due dates and document expirations from DispatchDesk',
    timezone: user.timezone,
    now,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Cache (per process, bounded) and cross-process invalidation
// ---------------------------------------------------------------------------------------------------------------

const cache = new Map(); // `${tokenHash}:${names}` -> { at, body, etag, bytes }
let cacheBytes = 0;
let epoch = 0;

function cacheDelete(key) {
  const hit = cache.get(key);
  if (!hit) return;
  cacheBytes -= hit.bytes || 0;
  cache.delete(key);
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cacheDelete(key); return null; }
  return hit;
}
/** Bounded by entry count and by total size (a full feed is a few hundred KB), oldest dropped first. */
function cacheSet(key, value) {
  cacheDelete(key);
  const bytes = Buffer.byteLength(value.body, 'utf8');
  if (bytes > CACHE_MAX_BYTES / 4) return; // never let one feed take a large share of the budget
  cache.set(key, { ...value, bytes });
  cacheBytes += bytes;
  while (cache.size && (cache.size > CACHE_MAX || cacheBytes > CACHE_MAX_BYTES)) cacheDelete(cache.keys().next().value);
}

onBroadcast('calendar-feed', (hash) => {
  epoch += 1;
  if (!hash) { cache.clear(); cacheBytes = 0; return; }
  for (const k of [...cache.keys()]) if (k.startsWith(`${hash}:`)) cacheDelete(k);
});

/** Drop a feed (by token hash) from every process's cache; call after rotating or turning off a link. */
export function invalidateCalendarFeed(tokenHash) {
  broadcast('calendar-feed', tokenHash || null);
}

// ---------------------------------------------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------------------------------------------

// Calendar apps poll every few hours, but their fetchers share IP addresses, so the per-IP limit is generous.
const feedLimiter = rateLimit({
  windowMs: 60_000,
  limit: () => Number(process.env.CALENDAR_FEED_RATE_LIMIT) || 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  ...(cluster.isWorker ? { store: new ClusterMemoryStoreWorker({ prefix: 'calfeed:' }) } : {}),
  skip: () => !process.env.CALENDAR_FEED_RATE_LIMIT && (config.rateLimitDisabled || config.isTest),
  handler: (req, res) => res.status(429).type('text/plain').send('Too many requests. Try again in a minute.'),
});

const TOKEN_FILE = /^([A-Za-z0-9_-]{32,128})\.ics$/;

// Per link as well (app.js already allows 120 a minute per link): one feed never needs more than a few fetches a
// minute, so a leaked link cannot be polled hard even from many addresses.
r.use(linkLimiter);

r.get('/:file', feedLimiter, ah(async (req, res) => {
  const m = TOKEN_FILE.exec(String(req.params.file || ''));
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (!m) return res.status(404).type('text/plain').send('Calendar feed not found');
  const hash = sha256(m[1]);
  const names = req.query.names !== '0';
  const key = `${hash}:${names ? 1 : 0}`;
  let entry = cacheGet(key);
  if (!entry) {
    const startedAt = epoch;
    const user = await prisma.user.findUnique({ where: { calendarTokenHash: hash }, select: { id: true, timezone: true, status: true } });
    if (!user || user.status !== 'active') return res.status(404).type('text/plain').send('Calendar feed not found');
    const body = await buildFeed(user, { names });
    entry = { at: Date.now(), body, etag: `"${sha256(body).slice(0, 32)}"` };
    if (startedAt === epoch) cacheSet(key, entry); // a rotation landed meanwhile: do not cache the old link
  }
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="dispatchdesk.ics"',
    'Cache-Control': 'private, max-age=300',
    ETag: entry.etag,
  });
  if (req.fresh) return res.status(304).end();
  res.send(entry.body);
}));

export default r;
