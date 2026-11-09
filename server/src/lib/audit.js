import { prisma } from '../db.js';

/** Append-only audit trail for security-relevant and administrative actions. Never throws. */
export async function audit(req, action, { entityType, entityId, details, actorId } = {}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actorId ?? req?.user?.id ?? null,
        action,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        ip: req?.ip ?? null,
        details: details ? JSON.stringify(details).slice(0, 4000) : null,
      },
    });
  } catch (err) {
    console.error('[audit] failed', action, err.message);
  }
}
