import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { parse, z, reqStr } from '../lib/validate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';

/**
 * Personal access tokens (browser extension / integrations).
 * The plaintext token is returned exactly once at creation; only its sha256 is stored.
 * Mounted with requireAuth. Bearer tokens themselves cannot reach this router (see middleware/auth.js).
 */
const r = Router();
const MAX_ACTIVE = 10;

const serialize = (t) => ({
  id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt,
  expiresAt: t.expiresAt, revokedAt: t.revokedAt,
  active: !t.revokedAt && (!t.expiresAt || t.expiresAt > new Date()),
});

r.get('/', ah(async (req, res) => {
  const rows = await prisma.apiToken.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } });
  res.json({ items: rows.map(serialize) });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(z.object({
    name: reqStr(80),
    expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).optional().default(90),
  }), req.body);
  const active = await prisma.apiToken.count({
    where: { userId: req.user.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  });
  if (active >= MAX_ACTIVE) throw badRequest(`You can have at most ${MAX_ACTIVE} active tokens. Revoke one first.`);
  const token = `ddk_${randomToken(32)}`;
  const row = await prisma.apiToken.create({
    data: {
      userId: req.user.id,
      name: body.name,
      prefix: token.slice(0, 12),
      tokenHash: sha256(token),
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400000) : null,
    },
  });
  await audit(req, 'token.create', { entityType: 'api_token', entityId: row.id, details: { name: row.name, expiresInDays: body.expiresInDays } });
  res.status(201).json({ token, item: serialize(row) });
}));

r.delete('/:id', ah(async (req, res) => {
  const row = await prisma.apiToken.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
  if (!row) throw notFound('Token not found');
  if (!row.revokedAt) await prisma.apiToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  await audit(req, 'token.revoke', { entityType: 'api_token', entityId: row.id, details: { name: row.name } });
  res.json({ ok: true });
}));

export default r;
