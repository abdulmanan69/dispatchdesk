import { prisma } from '../../db.js';
import { notify } from '../../lib/activity.js';
import { lastContacts, checkCallSettings, checkCallDue } from '../../services/fleet/insights.js';
import { invalidateToday } from '../../services/fleet/today.js';

/**
 * Check-call reminders. Every 15 minutes, loads in transit with no driver GPS fix, check-in or dispatcher check call within
 * the owner's interval (default 4 hours, Fleet settings) get one reminder per interval: an in-app notification and push.
 * Nothing is dialed or texted. Batched: loads are found through the Load(ownerId, status) index one user at a time,
 * in chunks, with a saved cursor so a very large platform is covered over several runs.
 */
const MIN = 60_000;
const CURSOR_KEY = 'fleet.checkcalls.cursor';
export const REMINDER_TYPE = 'check_call_due';

/**
 * Cursor: "<ownerId>" (every load of that owner and those before it are done) or "<ownerId>|<loadId>" (inside an owner
 * with more in-transit loads than one chunk: that owner's loads up to loadId are done; an empty loadId means none yet).
 */
async function readCursor() {
  const row = await prisma.systemSetting.findUnique({ where: { key: CURSOR_KEY } });
  const [owner = '', loadId] = String(row?.value || '').split('|');
  return { owner, loadId: loadId === undefined ? null : loadId };
}
async function writeCursor({ owner, loadId }) {
  const value = loadId !== null ? `${owner}|${loadId}` : owner;
  await prisma.systemSetting.upsert({ where: { key: CURSOR_KEY }, create: { key: CURSOR_KEY, value, secret: false }, update: { value } });
}

/** Ids of in-transit loads for users after `cursor` (CROSS JOIN keeps User as the outer loop, so each user is an index probe). */
async function inTransitChunk(cursor, limit) {
  return prisma.$queryRaw`SELECT l."id" AS "id", u."id" AS "ownerId" FROM "User" u CROSS JOIN "Load" l ON l."ownerId" = u."id" AND l."status" = 'in_transit' WHERE u."id" > ${cursor} ORDER BY u."id" LIMIT ${limit}`;
}

/** One owner's in-transit loads after `afterId`, in id order (an owner with more loads than one chunk is paged). */
async function ownerChunk(ownerId, afterId, limit) {
  const rows = await prisma.load.findMany({
    where: { ownerId, status: 'in_transit', ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: 'asc' }, take: limit, select: { id: true, ownerId: true },
  });
  return rows;
}

export async function runCheckCalls(now = new Date(), { maxLoads = 2000, chunk = 400, budgetMs = 5000 } = {}) {
  const started = Date.now();
  const start = await readCursor();
  let cursor = { ...start };
  let checked = 0;
  let due = 0;
  let notified = 0;
  let wrapped = false;
  while (checked < maxLoads && Date.now() - started < budgetMs) {
    let rows;
    if (cursor.loadId !== null) {
      // Inside one owner with many loads in transit: page that owner's loads by id.
      rows = await ownerChunk(cursor.owner, cursor.loadId, chunk);
      cursor = rows.length === chunk ? { owner: cursor.owner, loadId: rows[rows.length - 1].id } : { owner: cursor.owner, loadId: null };
      if (!rows.length) continue;
    } else {
      rows = await inTransitChunk(cursor.owner, chunk);
      // After wrapping around, stop where this run started.
      if (wrapped && start.owner) rows = rows.filter((x) => x.ownerId <= start.owner);
      if (!rows.length) {
        if (wrapped || start.owner === '') { cursor = { owner: '', loadId: null }; break; }
        cursor = { owner: '', loadId: null };
        wrapped = true;
        continue;
      }
      const lastOwner = rows[rows.length - 1].ownerId;
      if (rows.length === chunk) {
        if (rows.every((x) => x.ownerId === lastOwner)) {
          // One owner fills the whole chunk: page that owner's loads by id from the start (next iteration).
          cursor = { owner: lastOwner, loadId: '' };
          continue;
        }
        // A user whose loads straddle the chunk boundary is handled whole in the next chunk.
        rows = rows.filter((x) => x.ownerId !== lastOwner);
      }
      cursor = { owner: rows[rows.length - 1].ownerId, loadId: null };
    }

    const loads = await prisma.load.findMany({
      where: { id: { in: rows.map((x) => x.id) } },
      select: { id: true, ownerId: true, carrierId: true, status: true, lastCheckCallAt: true, updatedAt: true, originCity: true, destCity: true, referenceNumber: true, carrier: { select: { companyName: true } } },
    });
    checked += loads.length;
    const [contacts, settings] = await Promise.all([lastContacts(loads), checkCallSettings(loads.map((l) => l.ownerId))]);
    const list = loads.map((l) => ({ l, d: checkCallDue(l, contacts[l.id], settings[l.ownerId], now.getTime()) })).filter((x) => x.d);
    due += list.length;
    if (!list.length) continue;
    const owners = [...new Set(list.map((x) => x.l.ownerId))];
    const longest = Math.max(...list.map((x) => x.d.hours));
    const recent = await prisma.notification.findMany({
      where: { userId: { in: owners }, type: REMINDER_TYPE, createdAt: { gt: new Date(now.getTime() - longest * 3600_000) } },
      select: { userId: true, link: true, createdAt: true },
    });
    for (const { l, d } of list) {
      const link = `/app/fleet?truck=${l.carrierId || ''}&trip=${l.id}`;
      // One reminder per interval and load.
      if (recent.some((n) => n.userId === l.ownerId && n.link === link && now.getTime() - n.createdAt.getTime() < d.hours * 3600_000)) continue;
      const ago = d.lastContactAt ? Math.round((now.getTime() - new Date(d.lastContactAt).getTime()) / (60 * MIN)) : null;
      await notify(l.ownerId, {
        type: REMINDER_TYPE,
        title: `Check call due: ${l.carrier?.companyName || 'truck in transit'}`.slice(0, 200),
        body: `${l.originCity} → ${l.destCity}${l.referenceNumber ? ` · ref ${l.referenceNumber}` : ''}. ${ago != null ? `No update for about ${ago} h.` : 'No update since it left.'} Call the driver or ask for a check-in.`,
        link,
      });
      invalidateToday(l.ownerId);
      notified++;
    }
  }
  await writeCursor(cursor);
  return { checked, due, notified, ms: Date.now() - started };
}

export const jobs = [
  {
    name: 'check-calls', label: 'Remind dispatchers about loads in transit with no update (check calls)', everyMs: 15 * MIN, lane: 'priority',
    run: (now) => runCheckCalls(now),
  },
];
