import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, conflict } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { destroySession, invalidateUserSessions } from '../middleware/auth.js';

const r = Router();

// Upload sub-directories that can hold files owned by a user (see middleware/upload.js callers).
const FILE_DIRS = ['avatars', 'documents', 'knowledge', 'marketplace', 'training'];

function rmStored(storedName) {
  if (!storedName) return;
  const base = path.basename(storedName);
  for (const dir of FILE_DIRS) fs.rmSync(path.join(config.uploadDir, dir, base), { force: true });
}

/** Remove a user's uploaded files from disk (DB rows are removed by cascading deletes). */
export async function deleteUserFiles(userId) {
  const [user, docs, knowledge, listings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { avatarPath: true } }),
    prisma.document.findMany({ where: { ownerId: userId }, select: { storedName: true } }),
    prisma.aIKnowledgeDocument.findMany({ where: { ownerId: userId }, select: { storedName: true } }),
    prisma.marketplaceListing.findMany({ where: { sellerId: userId }, select: { imagePath: true } }),
  ]);
  rmStored(user?.avatarPath);
  docs.forEach((d) => rmStored(d.storedName));
  knowledge.forEach((d) => rmStored(d.storedName));
  listings.forEach((l) => rmStored(l.imagePath));
}

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

/** Everything the user owns, as JSON. Never includes other users' data, password hashes or credentials. */
r.get('/export', ah(async (req, res) => {
  const id = req.user.id;
  const [user, carriers, brokers, loads, templates, sequences, emails, activities, followUps, calls, documents, tags, lists, automations, conversations, listings, posts, comments, payments, mailboxes] = await Promise.all([
    prisma.user.findUnique({ where: { id }, include: { role: { select: { key: true, name: true } } } }),
    prisma.carrier.findMany({
      where: { ownerId: id },
      include: { stage: { select: { key: true } }, contacts: true, notes: true, tags: { include: { tag: { select: { name: true } } } }, opportunity: true, customer: { include: { lanes: true } } },
    }),
    prisma.broker.findMany({ where: { ownerId: id } }),
    prisma.load.findMany({ where: { ownerId: id } }),
    prisma.emailTemplate.findMany({ where: { ownerId: id } }),
    prisma.emailSequence.findMany({ where: { ownerId: id }, include: { steps: true, enrollments: true } }),
    prisma.email.findMany({ where: { userId: id }, select: { id: true, carrierId: true, brokerId: true, toEmail: true, subject: true, body: true, status: true, sentAt: true, scheduledAt: true, createdAt: true } }),
    prisma.activity.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.followUp.findMany({ where: { userId: id } }),
    prisma.call.findMany({ where: { userId: id } }),
    prisma.document.findMany({ where: { ownerId: id }, select: { id: true, carrierId: true, loadId: true, type: true, originalName: true, mimeType: true, sizeBytes: true, expiresAt: true, createdAt: true } }),
    prisma.tag.findMany({ where: { ownerId: id } }),
    prisma.prospectList.findMany({ where: { ownerId: id }, include: { items: true } }),
    prisma.automation.findMany({ where: { ownerId: id } }),
    prisma.aIConversation.findMany({ where: { userId: id }, include: { messages: true } }),
    prisma.marketplaceListing.findMany({ where: { sellerId: id } }),
    prisma.communityPost.findMany({ where: { authorId: id } }),
    prisma.communityComment.findMany({ where: { authorId: id } }),
    prisma.payment.findMany({ where: { userId: id } }),
    prisma.emailAccount.findMany({ where: { userId: id }, select: { id: true, provider: true, label: true, fromEmail: true, fromName: true, status: true, createdAt: true } }),
  ]);
  const payload = {
    exportedAt: new Date().toISOString(),
    format: 'dispatchdesk-export/1',
    profile: omit(user, ['passwordHash', 'roleId']),
    carriers, brokers, loads, emailTemplates: templates, sequences, emails, calls, followUps, activities, documents,
    tags, prospectLists: lists, automations, aiConversations: conversations, marketplaceListings: listings,
    communityPosts: posts, communityComments: comments, payments, mailboxes,
    note: 'Uploaded file contents are not included; download documents individually from the app. Mailbox credentials are never exported.',
  };
  await audit(req, 'account.data_exported');
  const name = `dispatchdesk-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send(JSON.stringify(payload, null, 2));
}));

r.delete('/account', ah(async (req, res) => {
  const body = parse(z.object({ password: z.string().min(1, 'Enter your password'), confirm: z.string() }), req.body);
  if (body.confirm !== 'DELETE') throw badRequest('Type DELETE to confirm');
  if (!(await bcrypt.compare(body.password, req.user.passwordHash))) throw badRequest('Password is incorrect');
  const m = req.user.teamMembership;
  if (m?.role === 'owner') {
    const others = await prisma.teamMember.count({ where: { teamId: m.teamId, NOT: { userId: req.user.id } } });
    if (others) throw conflict('You own a team with other members. Transfer ownership or remove members first (Team page).');
  }
  const live = await prisma.subscription.count({ where: { userId: req.user.id, status: { in: ['active', 'trialing', 'past_due'] } } });
  if (live) throw conflict('Cancel your subscription in Billing first. Account deletion never cancels payments silently.');
  if (req.user.role?.key === 'super_admin') {
    const supers = await prisma.user.count({ where: { role: { key: 'super_admin' }, status: 'active' } });
    if (supers <= 1) throw conflict('You are the only super admin. Promote another super admin before deleting this account.');
  }
  await deleteUserFiles(req.user.id);
  await prisma.team.deleteMany({ where: { ownerId: req.user.id } });
  await audit(req, 'account.deleted', { entityType: 'user', entityId: req.user.id, details: { email: req.user.email } });
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: `user.${req.user.id}.` } } }); // per-user settings (e.g. spot rates)
  await prisma.user.delete({ where: { id: req.user.id } });
  invalidateUserSessions(req.user.id);
  await destroySession(req, res);
  res.json({ ok: true });
}));

export default r;
