import request from 'supertest';
import { describe, it, expect, afterEach } from 'vitest';
import { app, registerUser, agent, prisma } from './helpers.js';
import calendarFeedRouter, { icsEscape, foldLine, buildIcs, icsDateTime, icsDate, MAX_EVENTS } from '../src/routes/calendarFeed.js';
import { linkLimiter } from '../src/middleware/security.js';

const DAY = 86400000;
const feedPath = (url) => new URL(url).pathname + new URL(url).search;
const unfold = (ics) => ics.replace(/\r\n /g, '');
const events = (ics) => (unfold(ics).match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []);

async function makeLoad(ownerId, data = {}) {
  return prisma.load.create({
    data: { ownerId, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 780, rateCents: 250000, status: 'booked', ...data },
  });
}

async function makeCarrier(a, companyName) {
  const res = await a.post('/api/carriers').send({ companyName });
  if (res.status !== 201) throw new Error(`carrier ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.carrier || res.body;
}

async function enableFeed(a) {
  const res = await a.post('/api/calendar/token').send({});
  expect(res.status).toBe(201);
  return res.body;
}

afterEach(() => { delete process.env.CALENDAR_FEED_RATE_LIMIT; });

describe('calendar: iCalendar helpers', () => {
  it('escapes TEXT values', () => {
    expect(icsEscape('Pickup; dock 4, door B\\C\nline two\r\nthree')).toBe('Pickup\\; dock 4\\, door B\\\\C\\nline two\\nthree');
    expect(icsEscape('bell\u0007 ok')).toBe('bell ok');
    expect(icsEscape(null)).toBe('');
  });

  it('folds long lines at 75 octets without splitting UTF-8 characters', () => {
    const line = `SUMMARY:${'Pickup in Montréal — ✓ '.repeat(12)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, p] of parts.entries()) {
      expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
      if (i > 0) expect(p.startsWith(' ')).toBe(true);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(foldLine('SHORT:ok')).toBe('SHORT:ok');
  });

  it('builds a valid calendar with timed and all-day events and CRLF line endings', () => {
    const start = new Date(Date.UTC(2026, 10, 12, 14, 0));
    const ics = buildIcs([
      { uid: 'a@x', start, end: new Date(start.getTime() + 2 * 3600000), summary: 'Pickup: Dallas, TX', alarmMinutes: 60, updated: start },
      { uid: 'b@x', start, allDay: true, tz: 'America/Chicago', summary: 'Invoice #4 due', updated: start },
    ], { timezone: 'America/Chicago', now: start });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(ics).toContain('DTSTART:20261112T140000Z\r\nDTEND:20261112T160000Z');
    expect(ics).toContain('SUMMARY:Pickup: Dallas\\, TX');
    expect(ics).toContain('TRIGGER:-PT60M');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261112\r\nDTEND;VALUE=DATE:20261113');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(icsDate(new Date(Date.UTC(2026, 10, 13, 3, 0)), 'America/Chicago')).toBe('20261112');
  });
});

describe('calendar: feed settings', () => {
  it('creates, shows state, rotates and turns off a private link', async () => {
    const A = await registerUser();
    expect((await A.agent.get('/api/calendar')).body).toEqual({ enabled: false });
    const first = await enableFeed(A.agent);
    expect(first.url).toMatch(/\/api\/public\/calendar\/[A-Za-z0-9_-]{40,}\.ics$/);
    expect(first.webcalUrl.startsWith('webcal://')).toBe(true);
    expect(first.googleUrl).toContain(encodeURIComponent(first.webcalUrl));
    expect((await A.agent.get('/api/calendar')).body).toEqual({ enabled: true });
    const user = await prisma.user.findUnique({ where: { id: A.user.id }, select: { calendarTokenHash: true } });
    expect(user.calendarTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.url).not.toContain(user.calendarTokenHash);

    expect((await request(app).get(feedPath(first.url))).status).toBe(200);
    const second = await enableFeed(A.agent);
    expect(second.replaced).toBe(true);
    expect(second.url).not.toBe(first.url);
    // The old link stops at once (its cached copy is dropped); the new one works.
    expect((await request(app).get(feedPath(first.url))).status).toBe(404);
    expect((await request(app).get(feedPath(second.url))).status).toBe(200);

    expect((await A.agent.delete('/api/calendar/token')).body).toEqual({ enabled: false });
    expect((await request(app).get(feedPath(second.url))).status).toBe(404);
    expect((await A.agent.get('/api/calendar')).body).toEqual({ enabled: false });
  });

  it('requires a session and refuses personal API tokens', async () => {
    const anon = await agent();
    expect((await anon.get('/api/calendar')).status).toBe(401);
    expect((await anon.post('/api/calendar/token').send({})).status).toBe(401);
    const A = await registerUser();
    const tok = await A.agent.post('/api/tokens').send({ name: 'ext' });
    expect((await request(app).post('/api/calendar/token').set('Authorization', `Bearer ${tok.body.token}`).send({})).status).toBe(403);
  });
});

describe('calendar: public feed', () => {
  it('lists appointments, follow-ups, invoice due dates and document expirations for the owner only', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const now = Date.now();
    const base = new Date(now + 3 * DAY);
    const windowStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 14, 0));
    const windowEnd = new Date(windowStart.getTime() + 2 * 3600000);
    const deliveryDay = new Date(now + 5 * DAY);
    deliveryDay.setUTCHours(18, 0, 0, 0); // a date-only delivery (noon Central)
    const carrier = await makeCarrier(A.agent, 'Lone Star Hauling, LLC');
    await makeLoad(A.user.id, {
      referenceNumber: 'RC-1001', carrierId: carrier.id, pickupDate: windowStart, pickupWindowStart: windowStart, pickupWindowEnd: windowEnd,
      pickupTz: 'America/Chicago', pickupFacility: 'Acme DC; Dock 4', deliveryDate: deliveryDay,
    });
    await makeLoad(A.user.id, { referenceNumber: 'CANCELED', status: 'canceled', pickupDate: windowStart });
    await makeLoad(A.user.id, { referenceNumber: 'OLD', pickupDate: new Date(now - 90 * DAY) });
    await makeLoad(B.user.id, { referenceNumber: 'B-SECRET', pickupDate: windowStart, pickupFacility: 'B private yard' });
    await prisma.followUp.create({ data: { carrierId: carrier.id, userId: A.user.id, dueAt: new Date(now + 2 * DAY), type: 'call', note: 'Ask about the reefer' } });
    await prisma.followUp.create({ data: { carrierId: carrier.id, userId: A.user.id, dueAt: new Date(now + 2 * DAY), type: 'call', status: 'done' } });
    await prisma.invoice.create({ data: { ownerId: A.user.id, number: 7, billToName: 'Big Broker Inc', lines: '[]', amountCents: 125000, paidCents: 25000, status: 'sent', dueAt: new Date(now + 10 * DAY) } });
    await prisma.invoice.create({ data: { ownerId: A.user.id, number: 8, billToName: 'Paid Broker', lines: '[]', amountCents: 5000, status: 'paid', dueAt: new Date(now + 10 * DAY) } });
    await prisma.document.create({
      data: { ownerId: A.user.id, uploadedById: A.user.id, carrierId: carrier.id, type: 'coi', originalName: 'coi.pdf', storedName: `cal-test-${now}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, expiresAt: new Date(now + 20 * DAY) },
    });

    const feed = await enableFeed(A.agent);
    const res = await request(app).get(feedPath(feed.url));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['cache-control']).toContain('private');
    const ics = res.text;
    const list = events(ics);
    expect(list).toHaveLength(5); // pickup, delivery, follow-up, invoice, document

    const pickup = list.find((e) => e.includes('-pickup@'));
    expect(pickup).toContain(`DTSTART:${icsDateTime(windowStart)}`);
    expect(pickup).toContain(`DTEND:${icsDateTime(windowEnd)}`);
    expect(pickup).toContain('SUMMARY:Pickup: Dallas\\, TX · Lone Star Hauling\\, LLC');
    expect(pickup).toContain('LOCATION:Acme DC\\; Dock 4');
    expect(pickup).toContain('#RC-1001');
    expect(pickup).toContain('BEGIN:VALARM');
    const delivery = list.find((e) => e.includes('-delivery@'));
    expect(delivery).toContain(`DTSTART;VALUE=DATE:${icsDate(deliveryDay, 'America/Chicago')}`);
    expect(list.some((e) => e.includes('SUMMARY:Call: Lone Star Hauling\\, LLC'))).toBe(true);
    expect(list.some((e) => e.includes('SUMMARY:Invoice #7 due: $1\\,000.00 · Big Broker Inc'))).toBe(true);
    expect(list.some((e) => e.includes('SUMMARY:Certificate of insurance expires: Lone Star Hauling\\, LLC'))).toBe(true);
    expect(ics).not.toContain('B-SECRET');
    expect(ics).not.toContain('B private yard');
    expect(ics).not.toContain('CANCELED');
    expect(ics).not.toContain('Paid Broker');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);

    // Names can be left out.
    const anon = await request(app).get(`${feedPath(feed.url)}?names=0`);
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain('Lone Star');
    expect(anon.text).not.toContain('Big Broker');
    expect(anon.text).not.toContain('reefer');
    expect(events(anon.text)).toHaveLength(5);

    // Conditional requests.
    const again = await request(app).get(feedPath(feed.url)).set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);

    // B's link shows only B's data.
    const feedB = await enableFeed(B.agent);
    const icsB = (await request(app).get(feedPath(feedB.url))).text;
    expect(icsB).toContain('B-SECRET');
    expect(icsB).not.toContain('RC-1001');
  });

  it('caps the feed at the event limit, upcoming events first', async () => {
    const A = await registerUser();
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 200; i++) {
      rows.push({
        ownerId: A.user.id, originCity: 'Reno', originState: 'NV', destCity: 'Boise', destState: 'ID', loadedMiles: 420, rateCents: 90000, status: 'booked',
        pickupDate: new Date(now + (1 + (i % 50)) * DAY), deliveryDate: new Date(now + (2 + (i % 50)) * DAY),
      });
    }
    await prisma.load.createMany({ data: rows });
    await prisma.invoice.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({ ownerId: A.user.id, number: 1000 + i, billToName: 'X', lines: '[]', amountCents: 100, status: 'sent', dueAt: new Date(now + 3 * DAY) })),
    });
    await prisma.document.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        ownerId: A.user.id, uploadedById: A.user.id, type: 'permit', originalName: 'p.pdf', storedName: `cal-cap-${now}-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 1, expiresAt: new Date(now + 4 * DAY),
      })),
    });
    // 400 load stops + 100 invoices + 60 documents = 560 candidates.
    const feed = await enableFeed(A.agent);
    const ics = (await request(app).get(feedPath(feed.url))).text;
    expect(events(ics)).toHaveLength(MAX_EVENTS);
  });

  it('keeps upcoming loads and follow-ups when past ones exceed the per-list caps', async () => {
    const A = await registerUser();
    const now = Date.now();
    const carrier = await makeCarrier(A.agent, 'Busy Fleet LLC');
    // 210 loads picked up in the last 13 days (more than the 200-load cap), plus one upcoming load.
    await prisma.load.createMany({
      data: Array.from({ length: 210 }, (_, i) => ({
        ownerId: A.user.id, originCity: 'Reno', originState: 'NV', destCity: 'Boise', destState: 'ID', loadedMiles: 420, rateCents: 90000, status: 'delivered',
        referenceNumber: `PAST-${i}`, pickupDate: new Date(now - (1 + (i % 12)) * DAY - 3600000),
      })),
    });
    await makeLoad(A.user.id, { referenceNumber: 'NEXT-WEEK', pickupDate: new Date(now + 7 * DAY) });
    // 160 overdue follow-ups from this week (more than the follow-up cap), plus one upcoming follow-up.
    await prisma.followUp.createMany({
      data: Array.from({ length: 160 }, (_, i) => ({ carrierId: carrier.id, userId: A.user.id, dueAt: new Date(now - (1 + (i % 6)) * DAY), type: 'call', title: `Overdue ${i}` })),
    });
    await prisma.followUp.create({ data: { carrierId: carrier.id, userId: A.user.id, dueAt: new Date(now + 20 * DAY), type: 'email', title: 'Send the agreement' } });

    const feed = await enableFeed(A.agent);
    const ics = unfold((await request(app).get(feedPath(feed.url))).text);
    expect(ics).toContain('#NEXT-WEEK');
    expect(ics).toContain('Send the agreement');
    expect(events(ics).length).toBeLessThanOrEqual(MAX_EVENTS);
  });

  it('answers 404 for unknown or malformed tokens and rate limits per client', async () => {
    expect((await request(app).get('/api/public/calendar/not-a-real-token-but-long-enough-0123456789.ics')).status).toBe(404);
    expect((await request(app).get('/api/public/calendar/short.ics')).status).toBe(404);
    expect((await request(app).get('/api/public/calendar/abc')).status).toBe(404);
    process.env.CALENDAR_FEED_RATE_LIMIT = '2';
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await request(app).get('/api/public/calendar/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.ics')).status);
    expect(statuses).toContain(429);
  });

  it('also gives each link its own stricter budget (shared link limiter, off in tests like the other limiters)', () => {
    expect(calendarFeedRouter.stack.some((layer) => layer.handle === linkLimiter)).toBe(true);
  });
});
