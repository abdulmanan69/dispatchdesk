import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { verifyPayload, sha256 } from '../lib/crypto.js';
import { getSettings } from '../lib/settings.js';
import { publicFormLimiter } from '../middleware/security.js';

const r = Router();

/**
 * Unsubscribe links in outbound email carry a signed { o: ownerId, e: email } token.
 * GET previews, POST (also RFC 8058 one-click) applies. Both are idempotent.
 */
function decode(req) {
  const payload = verifyPayload(String(req.query.token || req.body?.token || ''));
  if (!payload?.o || !payload?.e) throw badRequest('This unsubscribe link is invalid or has expired');
  return { ownerId: String(payload.o), email: String(payload.e).toLowerCase() };
}

const ANNOUNCEMENT_KEYS = ['announcement.enabled', 'announcement.text', 'announcement.linkUrl', 'announcement.linkLabel', 'announcement.tone', 'announcement.audience'];

/** The announcement bar set in Admin → System settings (null when off). `id` changes with the content. */
r.get('/announcement', ah(async (req, res) => {
  const s = await getSettings(ANNOUNCEMENT_KEYS);
  res.set('Cache-Control', 'public, max-age=60');
  if (s['announcement.enabled'] !== 'true' || !s['announcement.text']) return res.json({ announcement: null });
  const a = {
    text: s['announcement.text'], linkUrl: s['announcement.linkUrl'] || null, linkLabel: s['announcement.linkLabel'] || null,
    tone: s['announcement.tone'] || 'info', audience: s['announcement.audience'] || 'everyone',
  };
  res.json({ announcement: { id: sha256(JSON.stringify(a)).slice(0, 12), ...a } });
}));

r.get('/unsubscribe', ah(async (req, res) => {
  const { ownerId, email } = decode(req);
  const [owner, existing] = await Promise.all([
    prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } }),
    prisma.emailSuppression.findUnique({ where: { ownerId_email: { ownerId, email } } }),
  ]);
  if (!owner) throw badRequest('This unsubscribe link is no longer valid');
  res.json({ email, sender: owner.name, unsubscribed: !!existing });
}));

r.post('/unsubscribe', publicFormLimiter, ah(async (req, res) => {
  const { ownerId, email } = decode(req);
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
  if (!owner) throw badRequest('This unsubscribe link is no longer valid');
  await prisma.emailSuppression.upsert({
    where: { ownerId_email: { ownerId, email } },
    create: { ownerId, email, reason: 'unsubscribed' },
    update: {},
  });
  await prisma.carrier.updateMany({ where: { ownerId, email }, data: { doNotEmail: true } });
  await prisma.email.updateMany({ where: { userId: ownerId, toEmail: email, status: 'scheduled' }, data: { status: 'canceled', error: 'Recipient unsubscribed' } });
  await prisma.sequenceEnrollment.updateMany({
    where: { userId: ownerId, status: 'active', carrier: { email } },
    data: { status: 'stopped', stopReason: 'unsubscribed', nextStepAt: null },
  });
  res.json({ ok: true, email, unsubscribed: true });
}));

export default r;
