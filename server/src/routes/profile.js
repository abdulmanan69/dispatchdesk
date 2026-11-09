import { Router } from 'express';
import fs from 'node:fs';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr } from '../lib/validate.js';
import { requireAuth, publicUser } from '../middleware/auth.js';
import { uploader, verifyFileSignature, removeFile, filePath } from '../middleware/upload.js';
import { audit } from '../lib/audit.js';

const r = Router();
const avatarUpload = uploader('image', 'avatars', 3);

const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

r.patch('/', requireAuth, ah(async (req, res) => {
  const body = parse(z.object({
    name: reqStr(120).optional(),
    phone: optStr(40),
    bio: optStr(1000),
    timezone: z.string().refine(validTz, 'Unknown time zone').optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    emailSignature: optStr(2000),
    notifyEmail: z.boolean().optional(),
    notifyInApp: z.boolean().optional(),
    notifyFollowUps: z.boolean().optional(),
    notifyCommunity: z.boolean().optional(),
  }), req.body);
  const data = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  const user = await prisma.user.update({
    where: { id: req.user.id }, data,
    include: { role: true, teamMembership: { include: { team: true } } },
  });
  res.json({ user: publicUser(user, req.permissions) });
}));

r.post('/avatar', requireAuth, avatarUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw notFound('No file uploaded');
  verifyFileSignature(req.file);
  if (req.user.avatarPath) removeFile('avatars', req.user.avatarPath);
  const user = await prisma.user.update({
    where: { id: req.user.id }, data: { avatarPath: req.file.filename },
    include: { role: true, teamMembership: { include: { team: true } } },
  });
  await audit(req, 'profile.avatar_updated');
  res.json({ user: publicUser(user, req.permissions) });
}));

r.delete('/avatar', requireAuth, ah(async (req, res) => {
  if (req.user.avatarPath) removeFile('avatars', req.user.avatarPath);
  await prisma.user.update({ where: { id: req.user.id }, data: { avatarPath: null } });
  res.json({ ok: true });
}));

// Avatars are shown on community posts and marketplace listings, so they are public.
r.get('/avatar/:userId', ah(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: String(req.params.userId) }, select: { avatarPath: true } });
  if (!user?.avatarPath) throw notFound();
  const p = filePath('avatars', user.avatarPath);
  if (!fs.existsSync(p)) throw notFound();
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(p);
}));

export default r;
