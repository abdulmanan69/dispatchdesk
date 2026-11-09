import { prisma } from '../db.js';

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

export async function notify(userId, { type, title, body = null, link = null }, tx = prisma) {
  return tx.notification.create({ data: { userId, type, title: title.slice(0, 200), body, link } });
}
