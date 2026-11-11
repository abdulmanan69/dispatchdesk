import { prisma } from '../db.js';
import { enqueuePush } from '../services/push.js';

/**
 * Record an activity on the user's timeline (and the carrier's, when given).
 * teamId is denormalised from the user's membership so team feeds are cheap.
 */
export async function logActivity(user, { type, summary, carrierId = null, metadata = null }, tx = prisma) {
  const teamId = user.teamMembership?.teamId ?? (await tx.teamMember.findUnique({ where: { userId: user.id }, select: { teamId: true } }))?.teamId ?? null;
  return tx.activity.create({
    data: {
      userId: user.id,
      carrierId,
      teamId,
      type,
      summary: String(summary).slice(0, 500),
      metadata: metadata ? JSON.stringify(metadata).slice(0, 2000) : null,
    },
  });
}

/**
 * Create an in-app notification and queue a Web Push to the user's subscribed devices (when User.notifyPush is on).
 * The push is fire-and-forget: it never delays or fails the caller (see services/push.js).
 */
export async function notify(userId, { type, title, body = null, link = null }, tx = prisma) {
  const row = await tx.notification.create({ data: { userId, type, title: title.slice(0, 200), body, link } });
  enqueuePush(row, { inTx: tx !== prisma });
  return row;
}
