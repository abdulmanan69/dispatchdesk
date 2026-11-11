import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, forbidden } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { invalidateCalendarFeed } from './calendarFeed.js';

/**
 * Private calendar feed settings for the signed-in user.
 * The link is shown once, when it is created or replaced: only the token's sha256 is stored, so the server cannot
 * show it again. Replacing or turning off the link stops the old one at once (cache dropped in every process).
 */
const r = Router();

// A personal API token must not be able to mint or read calendar links.
r.use((req, res, next) => next(req.apiToken ? forbidden('API tokens cannot manage calendar links') : undefined));

export function feedLinks(token) {
  const url = `${config.appUrl}/api/public/calendar/${token}.ics`;
  const webcalUrl = url.replace(/^https?:\/\//, 'webcal://');
  return {
    url,
    webcalUrl,
    googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`,
  };
}

async function currentHash(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { calendarTokenHash: true } });
  return u?.calendarTokenHash || null;
}

r.get('/', ah(async (req, res) => {
  res.json({ enabled: !!(await currentHash(req.user.id)) });
}));

/** Create the link, or replace it (the old link stops working). Returns the new URLs once. */
r.post('/token', ah(async (req, res) => {
  const previous = await currentHash(req.user.id);
  const token = randomToken(32);
  await prisma.user.update({ where: { id: req.user.id }, data: { calendarTokenHash: sha256(token) } });
  if (previous) invalidateCalendarFeed(previous);
  res.status(201).json({ enabled: true, replaced: !!previous, ...feedLinks(token) });
}));

r.delete('/token', ah(async (req, res) => {
  const previous = await currentHash(req.user.id);
  if (previous) {
    await prisma.user.update({ where: { id: req.user.id }, data: { calendarTokenHash: null } });
    invalidateCalendarFeed(previous);
  }
  res.json({ enabled: false });
}));

export default r;
