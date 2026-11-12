import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr } from '../lib/validate.js';
import { requireAuth, publicUser, invalidateUserSessions, avatarVersion, mailFlags } from '../middleware/auth.js';
import { uploader, verifyFileSignature, removeFile, filePath, storedFileSize } from '../middleware/upload.js';
import { audit } from '../lib/audit.js';
import { TZ_CHANGE_ACTION } from '../lib/plans.js';

const r = Router();
// Replacing an avatar frees the old one, so only the difference counts toward storage.
const avatarUpload = uploader('image', 'avatars', 3, { quotaCredit: (req) => storedFileSize('avatars', req.user?.avatarPath) });

const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
/** The same account shape as GET /api/auth/me (the client replaces its user with it). */
const accountJson = async (user, permissions) => ({ ...publicUser(user, permissions), ...(await mailFlags()) });

r.patch('/', requireAuth, ah(async (req, res) => {
  const body = parse(z.object({
    name: reqStr(120).optional(),
    phone: optStr(40),
    bio: optStr(1000),
    timezone: z.string().refine(validTz, 'Unknown time zone').optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    emailSignature: optStr(2000),
    // Postal address printed in the footer of every email (CAN-SPAM). Blank clears it.
    mailingAddress: optStr(300),
    // Fills {{my_company}} for users without a team. Trimmed; blank clears it.
    companyName: z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : v), z.string().max(120, 'Company name: at most 120 characters').nullable().optional()),
    notifyEmail: z.boolean().optional(),
    notifyInApp: z.boolean().optional(),
    notifyFollowUps: z.boolean().optional(),
    notifyCommunity: z.boolean().optional(),
    notifyPush: z.boolean().optional(),
    notifyDigest: z.boolean().optional(),
  }), req.body);
  // Partial update: only fields present in the request body are written.
  const data = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && Object.hasOwn(req.body || {}, k)));
  const user = await prisma.user.update({
    where: { id: req.user.id }, data,
    include: { role: true, teamMembership: { include: { team: true } } },
  });
  // After the write, so a request running meanwhile cannot cache the old account (time zone, notification settings).
  invalidateUserSessions(req.user.id);
  // Daily and monthly limits keep counting from the old zone's midnight for two days (lib/plans.js limitDayStart).
  if (data.timezone && data.timezone !== req.user.timezone) {
    await audit(req, TZ_CHANGE_ACTION, { entityType: 'user', entityId: req.user.id, details: { from: req.user.timezone, to: data.timezone } });
  }
  res.json({ user: await accountJson(user, req.permissions) });
}));

r.post('/avatar', requireAuth, avatarUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw notFound('No file uploaded');
  verifyFileSignature(req.file);
  const previous = req.user.avatarPath;
  const user = await prisma.user.update({
    where: { id: req.user.id }, data: { avatarPath: req.file.filename },
    include: { role: true, teamMembership: { include: { team: true } } },
  });
  invalidateUserSessions(req.user.id);
  // The old picture goes only once the account points at the new one.
  if (previous && previous !== req.file.filename) removeFile('avatars', previous);
  await audit(req, 'profile.avatar_updated');
  res.json({ user: await accountJson(user, req.permissions) });
}));

r.delete('/avatar', requireAuth, ah(async (req, res) => {
  if (req.user.avatarPath) removeFile('avatars', req.user.avatarPath);
  await prisma.user.update({ where: { id: req.user.id }, data: { avatarPath: null } });
  invalidateUserSessions(req.user.id);
  res.json({ ok: true });
}));

/**
 * Avatars are shown on community posts, marketplace listings and team pages, so they are public.
 * app.js mounts this before the session lookup and the API rate limit. A URL whose ?v= matches the current picture
 * is cached for a year (the version changes with the picture); other URLs get a short cache.
 */
export const serveAvatar = ah(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: String(req.params.userId) }, select: { avatarPath: true } });
  if (!user?.avatarPath) throw notFound();
  const versioned = typeof req.query.v === 'string' && req.query.v === avatarVersion(user.avatarPath);
  res.set('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  res.set('X-Content-Type-Options', 'nosniff');
  await new Promise((resolve, reject) => {
    res.sendFile(filePath('avatars', user.avatarPath), (err) => {
      if (!err) return resolve();
      if (res.headersSent) { res.destroy?.(); return resolve(); }
      res.removeHeader('Cache-Control');
      reject(err.code === 'ENOENT' || err.status === 404 || err.statusCode === 404 ? notFound() : err);
    });
  });
});

r.get('/avatar/:userId', serveAvatar);

export default r;
