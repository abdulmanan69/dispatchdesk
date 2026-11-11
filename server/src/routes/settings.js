import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, conflict } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { withLock, LockBusyError } from '../lib/locks.js';
import { invalidatePlans } from '../lib/plans.js';
import { destroySession, invalidateUserSessions } from '../middleware/auth.js';
import { verifyPassword } from '../middleware/passwordHash.js';

const r = Router();

const BATCH = 400;
/** Let other requests run between batches. */
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

async function rmStored(subdir, storedName) {
  if (!storedName) return;
  await fsp.rm(path.join(config.uploadDir, subdir, path.basename(storedName)), { force: true }).catch(() => {});
}

/** Page through rows with a cursor on id (stable, uses the primary key). Calls onPage(rows) for each page. */
async function eachPage(model, args, onPage, size = BATCH) {
  let cursor = null;
  for (;;) {
    const rows = await prisma[model].findMany({ ...args, orderBy: { id: 'asc' }, take: size, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!rows.length) return;
    const stop = await onPage(rows);
    if (stop === false || rows.length < size) return;
    cursor = rows[rows.length - 1].id;
    await yieldLoop();
  }
}

/** Remove a user's uploaded files from disk (DB rows are removed separately). Reads ids in batches. */
export async function deleteUserFiles(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarPath: true } });
  await rmStored('avatars', user?.avatarPath);
  // Documents the user owns, and documents they uploaded to a teammate's records (those rows go with the user too).
  await eachPage('document', { where: { OR: [{ ownerId: userId }, { uploadedById: userId }] }, select: { id: true, storedName: true } }, async (rows) => {
    await Promise.all(rows.map((d) => rmStored('documents', d.storedName)));
  });
  await eachPage('aIKnowledgeDocument', { where: { ownerId: userId }, select: { id: true, storedName: true } }, async (rows) => {
    await Promise.all(rows.map((d) => rmStored('knowledge', d.storedName)));
  });
  await eachPage('marketplaceListing', { where: { sellerId: userId, imagePath: { not: null } }, select: { id: true, imagePath: true } }, async (rows) => {
    await Promise.all(rows.map((l) => rmStored('marketplace', l.imagePath)));
  });
}

/** Delete matching rows a batch at a time, so every write transaction stays short. Returns the count. */
async function deleteBatched(model, where, size = BATCH) {
  let total = 0;
  for (;;) {
    const rows = await prisma[model].findMany({ where, select: { id: true }, take: size });
    if (!rows.length) return total;
    total += (await prisma[model].deleteMany({ where: { id: { in: rows.map((x) => x.id) } } })).count;
    if (rows.length < size) return total;
    await yieldLoop();
  }
}

/**
 * Delete everything an account owns in batches, largest tables first, then the user row (whose remaining cascades are
 * small by then). One giant cascading DELETE used to hold the SQLite write lock for the whole account.
 */
export async function purgeUserData(userId) {
  // Audit history is kept (it is the platform's record), detached from the account in batches.
  for (;;) {
    const rows = await prisma.auditLog.findMany({ where: { actorId: userId }, select: { id: true }, take: 1000 });
    if (!rows.length) break;
    await prisma.auditLog.updateMany({ where: { id: { in: rows.map((x) => x.id) } }, data: { actorId: null } });
    if (rows.length < 1000) break;
    await yieldLoop();
  }
  // Location pings can be the largest table: clear them share by share.
  await eachPage('locationShare', { where: { ownerId: userId }, select: { id: true } }, async (shares) => {
    for (const s of shares) await deleteBatched('locationPing', { shareId: s.id }, 1000);
  }, 100);
  const steps = [
    ['email', { userId }],
    ['activity', { userId }],
    ['notification', { userId }],
    ['callAttempt', { userId }],
    ['call', { userId }],
    ['followUp', { userId }],
    ['sequenceEnrollment', { userId }],
    ['loadEvent', { ownerId: userId }],
    ['document', { OR: [{ ownerId: userId }, { uploadedById: userId }] }],
    ['locationShare', { ownerId: userId }],
    ['invoice', { ownerId: userId }],
    ['load', { ownerId: userId }],
    ['carrier', { ownerId: userId }, 200], // each carrier also removes its contacts, notes, tags and list items
    ['broker', { ownerId: userId }],
    ['aIConversation', { userId }, 100],
  ];
  for (const [model, where, size] of steps) {
    if (!prisma[model]) continue;
    await deleteBatched(model, where, size || BATCH);
    await yieldLoop();
  }
}

/**
 * Checks that must pass before anything is deleted. Only Stripe subscriptions block deletion (they would keep charging);
 * plans granted by an admin end with the account.
 */
export async function assertAccountDeletable(user, { self }) {
  const m = user.teamMembership;
  if (m?.role === 'owner') {
    const others = await prisma.teamMember.count({ where: { teamId: m.teamId, NOT: { userId: user.id } } });
    if (others) {
      throw conflict(self
        ? 'You own a team with other members. Transfer ownership or remove members first (Team page).'
        : 'This user owns a team with other members. Transfer ownership first.');
    }
  }
  const paying = await prisma.subscription.count({ where: { userId: user.id, status: { in: ['active', 'trialing', 'past_due'] }, stripeSubscriptionId: { not: null } } });
  if (paying) {
    throw conflict(self
      ? 'Cancel your subscription in Billing first. Account deletion never cancels payments silently.'
      : 'This user has a live Stripe subscription. Cancel it in Stripe first.');
  }
  if (self && user.role?.key === 'super_admin') {
    const supers = await prisma.user.count({ where: { role: { key: 'super_admin' }, status: 'active' } });
    if (supers <= 1) throw conflict('You are the only super admin. Promote another super admin before deleting this account.');
  }
}

/** Delete an account after assertAccountDeletable passed: files, owned (now empty) teams, data in batches, then the user. */
export async function deleteAccount(user) {
  return withLock(`account-delete.${user.id}`, 30 * 60_000, async () => {
    await deleteUserFiles(user.id);
    const teamIds = [user.teamMembership?.role === 'owner' ? user.teamMembership.teamId : null].filter(Boolean);
    await prisma.team.deleteMany({ where: { OR: [{ ownerId: user.id }, ...(teamIds.length ? [{ id: { in: teamIds } }] : [])] } });
    await purgeUserData(user.id);
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: `user.${user.id}.` } } }); // per-user settings (e.g. spot rates)
    await prisma.user.delete({ where: { id: user.id } });
    invalidateUserSessions(user.id);
    invalidatePlans();
  });
}

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !keys.includes(k)));

/** Tables in the export, in order: [key, model, findMany args, page size, map]. Every query is scoped to the user. */
function exportSections(id) {
  return [
    ['carriers', 'carrier', {
      where: { ownerId: id },
      include: { stage: { select: { key: true } }, contacts: true, notes: true, tags: { include: { tag: { select: { name: true } } } }, opportunity: true, customer: { include: { lanes: true } } },
    }, 200],
    ['brokers', 'broker', { where: { ownerId: id } }],
    ['loads', 'load', { where: { ownerId: id } }],
    ['invoices', 'invoice', { where: { ownerId: id } }],
    ['emailTemplates', 'emailTemplate', { where: { ownerId: id } }],
    ['textTemplates', 'textTemplate', { where: { ownerId: id } }],
    ['sequences', 'emailSequence', { where: { ownerId: id }, include: { steps: true, enrollments: true } }, 25],
    // Bodies can be large HTML: smaller pages keep memory flat.
    ['emails', 'email', { where: { userId: id }, select: { id: true, carrierId: true, brokerId: true, toEmail: true, subject: true, body: true, status: true, sentAt: true, scheduledAt: true, createdAt: true } }, 100],
    ['calls', 'call', { where: { userId: id } }],
    ['followUps', 'followUp', { where: { userId: id } }],
    ['activities', 'activity', { where: { userId: id } }, 1000],
    ['documents', 'document', { where: { ownerId: id }, select: { id: true, carrierId: true, loadId: true, type: true, originalName: true, mimeType: true, sizeBytes: true, expiresAt: true, createdAt: true } }],
    ['tags', 'tag', { where: { ownerId: id } }],
    ['prospectLists', 'prospectList', { where: { ownerId: id }, include: { items: true } }, 25],
    ['automations', 'automation', { where: { ownerId: id } }],
    ['aiConversations', 'aIConversation', { where: { userId: id }, include: { messages: true } }, 25],
    ['marketplaceListings', 'marketplaceListing', { where: { sellerId: id } }],
    ['communityPosts', 'communityPost', { where: { authorId: id } }],
    ['communityComments', 'communityComment', { where: { authorId: id } }],
    ['payments', 'payment', { where: { userId: id } }],
    ['mailboxes', 'emailAccount', { where: { userId: id }, select: { id: true, provider: true, label: true, fromEmail: true, fromName: true, status: true, createdAt: true } }],
  ];
}

/**
 * res.write that waits for the socket to drain, and reports whether the client is still there.
 * One 'drain' and one 'close' listener for the whole response: compression() moves 'drain' listeners onto its gzip
 * stream, where res.off() cannot remove them, so adding one per wait would pile them up on a large export.
 */
function writer(req, res) {
  let gone = false;
  let wake = null;
  const resume = () => { const w = wake; wake = null; w?.(); };
  res.on('close', () => { gone = true; resume(); });
  res.on('drain', resume);
  return {
    get gone() { return gone || res.destroyed; },
    async write(chunk) {
      if (gone || res.destroyed) return false;
      if (!res.write(chunk)) await new Promise((resolve) => { wake = resolve; });
      return !(gone || res.destroyed);
    },
  };
}

/**
 * Everything the user owns, as one JSON document. Never includes other users' data, password hashes or credentials.
 * Streamed table by table with cursor pagination, so a large account never sits in memory and the event loop keeps
 * serving other requests. One export per user at a time.
 */
r.get('/export', ah(async (req, res) => {
  const id = req.user.id;
  try {
    await withLock(`export.${id}`, 15 * 60_000, async () => {
      const user = await prisma.user.findUnique({ where: { id }, include: { role: { select: { key: true, name: true } } } });
      await audit(req, 'account.data_exported');
      const name = `dispatchdesk-export-${new Date().toISOString().slice(0, 10)}.json`;
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${name}"`);
      res.set('Cache-Control', 'private, no-store');
      const out = writer(req, res);
      const head = { exportedAt: new Date().toISOString(), format: 'dispatchdesk-export/1', profile: omit(user, ['passwordHash', 'roleId', 'calendarTokenHash']) };
      if (!(await out.write(JSON.stringify(head).slice(0, -1)))) return;
      for (const [key, model, args, size] of exportSections(id)) {
        if (!(await out.write(`,${JSON.stringify(key)}:[`))) return;
        let first = true;
        await eachPage(model, args, async (rows) => {
          const text = rows.map((row) => JSON.stringify(row)).join(',');
          const ok = await out.write(first ? text : `,${text}`);
          first = false;
          return ok;
        }, size || 500);
        if (!(await out.write(']'))) return;
      }
      await out.write(`,"note":${JSON.stringify('Uploaded file contents are not included; download documents individually from the app. Mailbox credentials are never exported.')}}`);
      res.end();
    });
  } catch (err) {
    if (err instanceof LockBusyError && !res.headersSent) throw conflict('An export of this account is already running. Try again when it finishes.');
    throw err;
  }
}));

r.delete('/account', ah(async (req, res) => {
  const body = parse(z.object({ password: z.string().min(1, 'Enter your password'), confirm: z.string() }), req.body);
  if (body.confirm !== 'DELETE') throw badRequest('Type DELETE to confirm');
  if (!(await verifyPassword(body.password, req.user.passwordHash))) throw badRequest('Password is incorrect');
  await assertAccountDeletable(req.user, { self: true });
  await audit(req, 'account.deleted', { entityType: 'user', entityId: req.user.id, details: { email: req.user.email } });
  try {
    await deleteAccount(req.user);
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('This account is already being deleted.');
    throw err;
  }
  await destroySession(req, res);
  res.json({ ok: true });
}));

export default r;
