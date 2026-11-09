import { Router } from 'express';
import fs from 'node:fs';
import { prisma } from '../db.js';
import { ah, notFound, badRequest, forbidden } from '../lib/errors.js';
import { parse, z, reqStr, optStr, optEmail, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { MARKET_CATEGORIES } from '../lib/constants.js';
import { requireAuth, requirePermission, hasPermission } from '../middleware/auth.js';
import { uploader, verifyFileSignature, removeFile, filePath } from '../middleware/upload.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/activity.js';

const r = Router();
const imageUpload = uploader('image', 'marketplace', 5);
const PRICE_TYPES = ['fixed', 'hourly', 'monthly', 'free', 'contact'];
export const REPORT_REASONS = ['spam', 'scam', 'abuse', 'inappropriate', 'other'];

const avatarUrl = (u) => (u?.avatarPath ? `/api/profile/avatar/${u.id}` : null);
const isModerator = (req) => hasPermission(req, 'admin.moderate');

function listingOut(l, req) {
  const authed = !!req.user;
  return {
    id: l.id, title: l.title, category: l.category, description: l.description,
    priceCents: l.priceCents, priceType: l.priceType, location: l.location, websiteUrl: l.websiteUrl,
    imageUrl: l.imagePath ? `/api/marketplace/listings/${l.id}/image?v=${l.updatedAt.getTime()}` : null,
    status: l.status, createdAt: l.createdAt, updatedAt: l.updatedAt,
    contactEmail: authed ? l.contactEmail : null,
    seller: l.seller ? { id: l.seller.id, name: l.seller.name, avatarUrl: avatarUrl(l.seller), memberSince: l.seller.createdAt } : undefined,
    isOwner: req.user?.id === l.sellerId,
    messageCount: l._count?.messages,
  };
}

const listingBody = z.object({
  title: reqStr(140),
  category: z.enum(MARKET_CATEGORIES),
  description: reqStr(8000),
  priceType: z.enum(PRICE_TYPES).optional(),
  priceCents: z.preprocess((v) => (v === '' || v == null ? null : Math.round(Number(v))), z.number().int().min(0).max(100_000_000).nullable().optional()),
  location: optStr(120),
  contactEmail: optEmail,
  websiteUrl: z.preprocess((v) => (v === '' ? null : v), z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Website must be http(s)').nullable().optional()),
});

function checkPrice(body) {
  if (['fixed', 'hourly', 'monthly'].includes(body.priceType) && (body.priceCents == null)) throw badRequest('priceCents: Enter a price for this price type');
  if (['free', 'contact'].includes(body.priceType)) body.priceCents = null;
}

const sellerSelect = { select: { id: true, name: true, avatarPath: true, createdAt: true } };

async function loadListing(id) {
  const l = await prisma.marketplaceListing.findUnique({ where: { id: String(id) }, include: { seller: sellerSelect } });
  if (!l) throw notFound('Listing not found');
  return l;
}

// ---------------------------------------------------------------------------
// Public browsing
// ---------------------------------------------------------------------------

r.get('/listings', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    q: z.string().trim().max(100).optional(),
    category: z.enum(MARKET_CATEGORIES).optional(),
    priceType: z.enum(PRICE_TYPES).optional(),
    sort: z.enum(['new', 'price_asc', 'price_desc']).default('new'),
  }), req.query);
  const where = {
    status: 'active',
    ...(q.category ? { category: q.category } : {}),
    ...(q.priceType ? { priceType: q.priceType } : {}),
    ...(q.q ? { OR: [{ title: { contains: q.q } }, { description: { contains: q.q } }, { location: { contains: q.q } }] } : {}),
  };
  const orderBy = q.sort === 'price_asc' ? [{ priceCents: 'asc' }, { createdAt: 'desc' }] : q.sort === 'price_desc' ? [{ priceCents: 'desc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }];
  const [items, total, counts] = await Promise.all([
    prisma.marketplaceListing.findMany({ where, orderBy, include: { seller: sellerSelect }, ...paginate(q) }),
    prisma.marketplaceListing.count({ where }),
    prisma.marketplaceListing.groupBy({ by: ['category'], where: { status: 'active' }, _count: { _all: true } }),
  ]);
  res.json({
    ...pageResult(items.map((l) => listingOut(l, req)), total, q),
    categories: MARKET_CATEGORIES.map((c) => ({ key: c, count: counts.find((x) => x.category === c)?._count._all ?? 0 })),
  });
}));

r.get('/listings/:id', ah(async (req, res) => {
  const l = await loadListing(req.params.id);
  const owner = req.user?.id === l.sellerId;
  if (l.status !== 'active' && !owner && !isModerator(req)) throw notFound('Listing not found');
  const more = await prisma.marketplaceListing.findMany({
    where: { sellerId: l.sellerId, status: 'active', NOT: { id: l.id } }, orderBy: { createdAt: 'desc' }, take: 4, include: { seller: sellerSelect },
  });
  res.json({ listing: listingOut(l, req), moreFromSeller: more.map((m) => listingOut(m, req)) });
}));

r.get('/listings/:id/image', ah(async (req, res) => {
  const l = await prisma.marketplaceListing.findUnique({ where: { id: String(req.params.id) }, select: { imagePath: true, status: true, sellerId: true } });
  if (!l?.imagePath) throw notFound();
  if (l.status !== 'active' && req.user?.id !== l.sellerId && !isModerator(req)) throw notFound();
  const p = filePath('marketplace', l.imagePath);
  if (!fs.existsSync(p)) throw notFound();
  res.set('Cache-Control', 'public, max-age=600');
  res.sendFile(p);
}));

// ---------------------------------------------------------------------------
// Seller management
// ---------------------------------------------------------------------------

r.get('/mine', requireAuth, ah(async (req, res) => {
  const items = await prisma.marketplaceListing.findMany({
    where: { sellerId: req.user.id }, orderBy: { createdAt: 'desc' },
    include: { seller: sellerSelect, _count: { select: { messages: true } } },
  });
  res.json({ items: items.map((l) => listingOut(l, req)) });
}));

r.post('/listings', requirePermission('marketplace.post'), ah(async (req, res) => {
  const body = parse(listingBody, req.body);
  body.priceType = body.priceType || 'fixed';
  checkPrice(body);
  const l = await prisma.marketplaceListing.create({ data: { ...clean(body), sellerId: req.user.id }, include: { seller: sellerSelect } });
  await audit(req, 'marketplace.listing_created', { entityType: 'marketplace_listing', entityId: l.id });
  res.status(201).json({ listing: listingOut(l, req) });
}));

async function loadOwnListing(req) {
  const l = await loadListing(req.params.id);
  if (l.sellerId !== req.user.id) throw notFound('Listing not found');
  return l;
}

r.patch('/listings/:id', requireAuth, ah(async (req, res) => {
  const l = await loadOwnListing(req);
  const body = parse(listingBody.partial().extend({ status: z.enum(['active', 'hidden']).optional() }), req.body);
  if (l.status === 'removed') throw forbidden('This listing was removed by a moderator and cannot be edited');
  const merged = { priceType: l.priceType, priceCents: l.priceCents, ...clean(body) };
  if (body.priceType !== undefined || body.priceCents !== undefined) checkPrice(merged);
  const data = clean({ ...body, priceCents: body.priceType !== undefined || body.priceCents !== undefined ? merged.priceCents : undefined });
  const updated = await prisma.marketplaceListing.update({ where: { id: l.id }, data, include: { seller: sellerSelect } });
  res.json({ listing: listingOut(updated, req) });
}));

r.delete('/listings/:id', requireAuth, ah(async (req, res) => {
  const l = await loadListing(req.params.id);
  if (l.sellerId !== req.user.id && !isModerator(req)) throw notFound('Listing not found');
  removeFile('marketplace', l.imagePath);
  await prisma.marketplaceListing.delete({ where: { id: l.id } });
  await audit(req, 'marketplace.listing_deleted', { entityType: 'marketplace_listing', entityId: l.id, details: { byModerator: l.sellerId !== req.user.id } });
  res.json({ ok: true });
}));

r.post('/listings/:id/image', requireAuth, imageUpload.single('file'), ah(async (req, res) => {
  let l;
  try { l = await loadOwnListing(req); } catch (e) { if (req.file) removeFile('marketplace', req.file.filename); throw e; }
  if (!req.file) throw badRequest('No image uploaded');
  verifyFileSignature(req.file);
  if (l.imagePath) removeFile('marketplace', l.imagePath);
  const updated = await prisma.marketplaceListing.update({ where: { id: l.id }, data: { imagePath: req.file.filename }, include: { seller: sellerSelect } });
  res.json({ listing: listingOut(updated, req) });
}));

r.delete('/listings/:id/image', requireAuth, ah(async (req, res) => {
  const l = await loadOwnListing(req);
  removeFile('marketplace', l.imagePath);
  const updated = await prisma.marketplaceListing.update({ where: { id: l.id }, data: { imagePath: null }, include: { seller: sellerSelect } });
  res.json({ listing: listingOut(updated, req) });
}));

// Moderators can hide, remove or restore any listing.
r.post('/listings/:id/moderate', requirePermission('admin.moderate'), ah(async (req, res) => {
  const { status, reason } = parse(z.object({ status: z.enum(['active', 'hidden', 'removed']), reason: optStr(500) }), req.body);
  const l = await loadListing(req.params.id);
  const updated = await prisma.marketplaceListing.update({ where: { id: l.id }, data: { status }, include: { seller: sellerSelect } });
  if (status === 'removed') await notify(l.sellerId, { type: 'moderation', title: `Your listing "${l.title}" was removed by a moderator`, body: reason || null, link: '/app/marketplace' });
  await audit(req, 'marketplace.listing_moderated', { entityType: 'marketplace_listing', entityId: l.id, details: { status, reason } });
  res.json({ listing: listingOut(updated, req) });
}));

// ---------------------------------------------------------------------------
// Contact & inbox
// ---------------------------------------------------------------------------

const msgOut = (m, me) => ({
  id: m.id, body: m.body, createdAt: m.createdAt, readAt: m.readAt, mine: m.senderId === me,
  sender: m.sender ? { id: m.sender.id, name: m.sender.name, avatarUrl: avatarUrl(m.sender) } : undefined,
});

r.post('/listings/:id/contact', requireAuth, ah(async (req, res) => {
  const { body } = parse(z.object({ body: reqStr(4000) }), req.body);
  const l = await loadListing(req.params.id);
  if (l.status !== 'active') throw notFound('Listing not found');
  if (l.sellerId === req.user.id) throw badRequest('You cannot message your own listing');
  const m = await prisma.marketplaceMessage.create({ data: { listingId: l.id, senderId: req.user.id, recipientId: l.sellerId, body }, include: { sender: true } });
  await notify(l.sellerId, { type: 'marketplace_message', title: `New message about "${l.title}"`, body: `${req.user.name}: ${body.slice(0, 120)}`, link: `/app/marketplace?tab=inbox&listing=${l.id}&user=${req.user.id}` });
  res.status(201).json({ message: msgOut(m, req.user.id), thread: { listingId: l.id, userId: l.sellerId } });
}));

r.get('/inbox', requireAuth, ah(async (req, res) => {
  const me = req.user.id;
  const rows = await prisma.marketplaceMessage.findMany({
    where: { OR: [{ senderId: me }, { recipientId: me }] },
    orderBy: { createdAt: 'desc' }, take: 2000,
    include: { listing: { select: { id: true, title: true, sellerId: true, status: true } }, sender: { select: { id: true, name: true, avatarPath: true } }, recipient: { select: { id: true, name: true, avatarPath: true } } },
  });
  const threads = new Map();
  for (const m of rows) {
    const other = m.senderId === me ? m.recipient : m.sender;
    const key = `${m.listingId}:${other.id}`;
    let t = threads.get(key);
    if (!t) {
      t = {
        listingId: m.listingId, listingTitle: m.listing.title, listingStatus: m.listing.status, iAmSeller: m.listing.sellerId === me,
        user: { id: other.id, name: other.name, avatarUrl: avatarUrl(other) },
        lastMessage: m.body.slice(0, 160), lastAt: m.createdAt, lastMine: m.senderId === me, unread: 0,
      };
      threads.set(key, t);
    }
    if (m.recipientId === me && !m.readAt) t.unread += 1;
  }
  const items = [...threads.values()];
  res.json({ items, unread: items.reduce((s, t) => s + t.unread, 0) });
}));

async function threadAccess(req) {
  const me = req.user.id;
  const otherId = String(req.params.userId);
  if (otherId === me) throw badRequest('Invalid thread');
  const listing = await prisma.marketplaceListing.findUnique({ where: { id: String(req.params.listingId) } });
  if (!listing || (listing.sellerId !== me && listing.sellerId !== otherId)) throw notFound('Conversation not found');
  return { listing, me, otherId };
}

r.get('/inbox/:listingId/:userId', requireAuth, ah(async (req, res) => {
  const { listing, me, otherId } = await threadAccess(req);
  const where = { listingId: listing.id, OR: [{ senderId: me, recipientId: otherId }, { senderId: otherId, recipientId: me }] };
  const rows = await prisma.marketplaceMessage.findMany({ where, orderBy: { createdAt: 'asc' }, include: { sender: true }, take: 1000 });
  if (!rows.length && listing.sellerId === me) throw notFound('Conversation not found');
  await prisma.marketplaceMessage.updateMany({ where: { listingId: listing.id, senderId: otherId, recipientId: me, readAt: null }, data: { readAt: new Date() } });
  const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true, name: true, avatarPath: true } });
  res.json({
    listing: { id: listing.id, title: listing.title, status: listing.status, iAmSeller: listing.sellerId === me },
    user: other ? { id: other.id, name: other.name, avatarUrl: avatarUrl(other) } : null,
    items: rows.map((m) => msgOut(m, me)),
  });
}));

r.post('/inbox/:listingId/:userId', requireAuth, ah(async (req, res) => {
  const { body } = parse(z.object({ body: reqStr(4000) }), req.body);
  const { listing, me, otherId } = await threadAccess(req);
  if (listing.sellerId === me) {
    // Sellers may only reply to people who contacted them about this listing.
    const contacted = await prisma.marketplaceMessage.count({ where: { listingId: listing.id, senderId: otherId, recipientId: me } });
    if (!contacted) throw forbidden('You can only reply to buyers who contacted you');
  } else if (listing.status !== 'active') {
    throw badRequest('This listing is no longer active');
  }
  const m = await prisma.marketplaceMessage.create({ data: { listingId: listing.id, senderId: me, recipientId: otherId, body }, include: { sender: true } });
  await notify(otherId, { type: 'marketplace_message', title: `New message about "${listing.title}"`, body: `${req.user.name}: ${body.slice(0, 120)}`, link: `/app/marketplace?tab=inbox&listing=${listing.id}&user=${me}` });
  res.status(201).json({ message: msgOut(m, me) });
}));

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

r.post('/listings/:id/report', requireAuth, ah(async (req, res) => {
  const body = parse(z.object({ reason: z.enum(REPORT_REASONS), details: optStr(2000) }), req.body);
  const l = await loadListing(req.params.id);
  if (l.sellerId === req.user.id) throw badRequest('You cannot report your own listing');
  const existing = await prisma.contentReport.findFirst({ where: { reporterId: req.user.id, listingId: l.id, status: 'open' } });
  if (existing) return res.json({ ok: true, report: { id: existing.id }, duplicate: true });
  const report = await prisma.contentReport.create({ data: { reporterId: req.user.id, listingId: l.id, reason: body.reason, details: body.details ?? null } });
  await audit(req, 'marketplace.listing_reported', { entityType: 'marketplace_listing', entityId: l.id, details: { reason: body.reason } });
  res.status(201).json({ ok: true, report: { id: report.id } });
}));

export default r;
