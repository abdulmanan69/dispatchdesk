import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { parse, z, reqStr, optStr, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { COMMUNITY_CATEGORIES } from '../lib/constants.js';
import { requireAuth, requirePermission, hasPermission } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/activity.js';
import { REPORT_REASONS } from './marketplace.js';

const r = Router();
const avatarUrl = (u) => (u?.avatarPath ? `/api/profile/avatar/${u.id}` : null);
const isModerator = (req) => hasPermission(req, 'admin.moderate');
const authorSelect = { select: { id: true, name: true, avatarPath: true } };
const authorOut = (a) => (a ? { id: a.id, name: a.name, avatarUrl: avatarUrl(a) } : null);

function excerpt(text, n = 240) {
  const t = String(text || '').replace(/[#*`>_[\]()]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function postOut(p, req, { full = false } = {}) {
  return {
    id: p.id, title: p.title, category: p.category, status: p.status, pinned: p.pinned,
    body: full ? p.body : undefined, excerpt: excerpt(p.body),
    createdAt: p.createdAt, updatedAt: p.updatedAt, edited: p.updatedAt.getTime() - p.createdAt.getTime() > 60000,
    author: authorOut(p.author), commentCount: p._count?.comments ?? 0,
    isOwner: req.user?.id === p.authorId,
  };
}

function commentBody(c) {
  if (c.status === 'deleted') return '[deleted]';
  if (c.status === 'removed' || c.status === 'hidden') return '[removed by a moderator]';
  return c.body;
}

const postBody = z.object({ title: reqStr(200), body: reqStr(20000), category: z.enum(COMMUNITY_CATEGORIES).default('general') });

async function loadPost(req, id) {
  const p = await prisma.communityPost.findUnique({ where: { id: String(id) }, include: { author: authorSelect, _count: { select: { comments: true } } } });
  if (!p) throw notFound('Post not found');
  if (p.status !== 'published' && req.user?.id !== p.authorId && !isModerator(req)) throw notFound('Post not found');
  return p;
}

// ---------------------------------------------------------------------------
// Reading (public)
// ---------------------------------------------------------------------------

r.get('/posts', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    q: z.string().trim().max(100).optional(),
    category: z.enum(COMMUNITY_CATEGORIES).optional(),
    sort: z.enum(['new', 'top']).default('new'),
    authorId: z.string().max(40).optional(),
  }), req.query);
  const where = {
    status: 'published',
    ...(q.category ? { category: q.category } : {}),
    ...(q.authorId ? { authorId: q.authorId } : {}),
    ...(q.q ? { OR: [{ title: { contains: q.q } }, { body: { contains: q.q } }] } : {}),
  };
  const orderBy = q.sort === 'top'
    ? [{ pinned: 'desc' }, { comments: { _count: 'desc' } }, { createdAt: 'desc' }]
    : [{ pinned: 'desc' }, { createdAt: 'desc' }];
  const [items, total, counts] = await Promise.all([
    prisma.communityPost.findMany({ where, orderBy, include: { author: authorSelect, _count: { select: { comments: true } } }, ...paginate(q) }),
    prisma.communityPost.count({ where }),
    prisma.communityPost.groupBy({ by: ['category'], where: { status: 'published' }, _count: { _all: true } }),
  ]);
  res.json({
    ...pageResult(items.map((p) => postOut(p, req)), total, q),
    categories: COMMUNITY_CATEGORIES.map((c) => ({ key: c, count: counts.find((x) => x.category === c)?._count._all ?? 0 })),
  });
}));

r.get('/posts/:id', ah(async (req, res) => {
  const p = await loadPost(req, req.params.id);
  const comments = await prisma.communityComment.findMany({ where: { postId: p.id }, orderBy: { createdAt: 'asc' }, include: { author: authorSelect } });
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c) => { let x = c; let guard = 0; while (x.parentId && byId.has(x.parentId) && guard++ < 50) x = byId.get(x.parentId); return x; };
  const out = (c) => {
    const parent = c.parentId ? byId.get(c.parentId) : null;
    const gone = c.status !== 'published';
    return {
      id: c.id, parentId: c.parentId, body: commentBody(c), status: c.status, createdAt: c.createdAt,
      edited: c.updatedAt.getTime() - c.createdAt.getTime() > 60000 && !gone,
      author: gone ? null : authorOut(c.author), isOwner: !gone && req.user?.id === c.authorId,
      replyingTo: parent && parent.parentId ? (parent.status === 'published' ? parent.author?.name : null) : undefined,
    };
  };
  const roots = comments.filter((c) => !c.parentId).map((c) => ({ ...out(c), replies: [] }));
  const rootMap = new Map(roots.map((x) => [x.id, x]));
  for (const c of comments) {
    if (!c.parentId) continue;
    const root = rootMap.get(rootOf(c).id);
    if (root) root.replies.push(out(c));
  }
  res.json({ post: postOut(p, req, { full: true }), comments: roots, canModerate: isModerator(req) });
}));

r.get('/users/:id', ah(async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, name: true, bio: true, avatarPath: true, createdAt: true, status: true } });
  if (!u || u.status !== 'active') throw notFound('User not found');
  const [postCount, commentCount, posts, listings] = await Promise.all([
    prisma.communityPost.count({ where: { authorId: u.id, status: 'published' } }),
    prisma.communityComment.count({ where: { authorId: u.id, status: 'published' } }),
    prisma.communityPost.findMany({ where: { authorId: u.id, status: 'published' }, orderBy: { createdAt: 'desc' }, take: 10, include: { author: authorSelect, _count: { select: { comments: true } } } }),
    prisma.marketplaceListing.findMany({ where: { sellerId: u.id, status: 'active' }, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, title: true, category: true } }),
  ]);
  res.json({
    user: { id: u.id, name: u.name, bio: u.bio, avatarUrl: avatarUrl(u), memberSince: u.createdAt, postCount, commentCount },
    posts: posts.map((p) => postOut(p, req)),
    listings,
  });
}));

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

r.post('/posts', requirePermission('community.post'), ah(async (req, res) => {
  const body = parse(postBody, req.body);
  const p = await prisma.communityPost.create({ data: { ...body, authorId: req.user.id }, include: { author: authorSelect, _count: { select: { comments: true } } } });
  res.status(201).json({ post: postOut(p, req, { full: true }) });
}));

r.patch('/posts/:id', requireAuth, ah(async (req, res) => {
  const p = await loadPost(req, req.params.id);
  if (p.authorId !== req.user.id) throw notFound('Post not found');
  if (p.status === 'removed') throw badRequest('This post was removed by a moderator');
  const body = parse(z.object({ title: reqStr(200).optional(), body: reqStr(20000).optional(), category: z.enum(COMMUNITY_CATEGORIES).optional() }), req.body);
  const updated = await prisma.communityPost.update({ where: { id: p.id }, data: clean(body), include: { author: authorSelect, _count: { select: { comments: true } } } });
  res.json({ post: postOut(updated, req, { full: true }) });
}));

r.delete('/posts/:id', requireAuth, ah(async (req, res) => {
  const p = await loadPost(req, req.params.id);
  const mod = isModerator(req);
  if (p.authorId !== req.user.id && !mod) throw notFound('Post not found');
  await prisma.communityPost.delete({ where: { id: p.id } });
  if (p.authorId !== req.user.id) await audit(req, 'community.post_deleted', { entityType: 'community_post', entityId: p.id, details: { title: p.title } });
  res.json({ ok: true });
}));

r.post('/posts/:id/comments', requirePermission('community.post'), ah(async (req, res) => {
  const body = parse(z.object({ body: reqStr(8000), parentId: optStr(40) }), req.body);
  const p = await loadPost(req, req.params.id);
  if (p.status !== 'published') throw badRequest('Comments are closed on this post');
  let parent = null;
  if (body.parentId) {
    parent = await prisma.communityComment.findUnique({ where: { id: body.parentId } });
    if (!parent || parent.postId !== p.id) throw badRequest('Reply target not found on this post');
  }
  const c = await prisma.communityComment.create({ data: { postId: p.id, authorId: req.user.id, parentId: parent?.id ?? null, body: body.body }, include: { author: authorSelect } });

  const recipients = new Set();
  if (p.authorId !== req.user.id) recipients.add(p.authorId);
  if (parent && parent.authorId !== req.user.id) recipients.add(parent.authorId);
  if (recipients.size) {
    const users = await prisma.user.findMany({ where: { id: { in: [...recipients] }, notifyCommunity: true, notifyInApp: true }, select: { id: true } });
    for (const u of users) {
      await notify(u.id, {
        type: 'community_comment',
        title: u.id === parent?.authorId && u.id !== p.authorId ? `${req.user.name} replied to your comment` : `${req.user.name} commented on "${p.title.slice(0, 80)}"`,
        body: body.body.slice(0, 140), link: `/app/community/${p.id}#c-${c.id}`,
      });
    }
  }
  res.status(201).json({ comment: { id: c.id, parentId: c.parentId, body: c.body, status: c.status, createdAt: c.createdAt, author: authorOut(c.author), isOwner: true } });
}));

async function loadComment(id) {
  const c = await prisma.communityComment.findUnique({ where: { id: String(id) }, include: { _count: { select: { replies: true } } } });
  if (!c) throw notFound('Comment not found');
  return c;
}

r.patch('/comments/:id', requireAuth, ah(async (req, res) => {
  const { body } = parse(z.object({ body: reqStr(8000) }), req.body);
  const c = await loadComment(req.params.id);
  if (c.authorId !== req.user.id || c.status !== 'published') throw notFound('Comment not found');
  const updated = await prisma.communityComment.update({ where: { id: c.id }, data: { body } });
  res.json({ comment: { id: updated.id, body: updated.body, updatedAt: updated.updatedAt } });
}));

r.delete('/comments/:id', requireAuth, ah(async (req, res) => {
  const c = await loadComment(req.params.id);
  const mod = isModerator(req);
  if (c.authorId !== req.user.id && !mod) throw notFound('Comment not found');
  if (c._count.replies > 0) {
    await prisma.communityComment.update({ where: { id: c.id }, data: { status: c.authorId === req.user.id ? 'deleted' : 'removed', body: '[deleted]' } });
  } else {
    await prisma.communityComment.delete({ where: { id: c.id } });
  }
  if (c.authorId !== req.user.id) await audit(req, 'community.comment_deleted', { entityType: 'community_comment', entityId: c.id });
  res.json({ ok: true, softDeleted: c._count.replies > 0 });
}));

// ---------------------------------------------------------------------------
// Reporting & moderation
// ---------------------------------------------------------------------------

const reportBody = z.object({ reason: z.enum(REPORT_REASONS), details: optStr(2000) });

r.post('/posts/:id/report', requireAuth, ah(async (req, res) => {
  const body = parse(reportBody, req.body);
  const p = await loadPost(req, req.params.id);
  if (p.authorId === req.user.id) throw badRequest('You cannot report your own post');
  const existing = await prisma.contentReport.findFirst({ where: { reporterId: req.user.id, postId: p.id, commentId: null, status: 'open' } });
  if (existing) return res.json({ ok: true, duplicate: true, report: { id: existing.id } });
  const rep = await prisma.contentReport.create({ data: { reporterId: req.user.id, postId: p.id, reason: body.reason, details: body.details ?? null } });
  await audit(req, 'community.post_reported', { entityType: 'community_post', entityId: p.id, details: { reason: body.reason } });
  res.status(201).json({ ok: true, report: { id: rep.id } });
}));

r.post('/comments/:id/report', requireAuth, ah(async (req, res) => {
  const body = parse(reportBody, req.body);
  const c = await loadComment(req.params.id);
  if (c.authorId === req.user.id) throw badRequest('You cannot report your own comment');
  const existing = await prisma.contentReport.findFirst({ where: { reporterId: req.user.id, commentId: c.id, status: 'open' } });
  if (existing) return res.json({ ok: true, duplicate: true, report: { id: existing.id } });
  const rep = await prisma.contentReport.create({ data: { reporterId: req.user.id, commentId: c.id, postId: c.postId, reason: body.reason, details: body.details ?? null } });
  await audit(req, 'community.comment_reported', { entityType: 'community_comment', entityId: c.id, details: { reason: body.reason } });
  res.status(201).json({ ok: true, report: { id: rep.id } });
}));

r.post('/posts/:id/pin', requirePermission('admin.moderate'), ah(async (req, res) => {
  const { pinned } = parse(z.object({ pinned: z.boolean() }), req.body);
  const p = await prisma.communityPost.update({ where: { id: String(req.params.id) }, data: { pinned } });
  await audit(req, pinned ? 'community.post_pinned' : 'community.post_unpinned', { entityType: 'community_post', entityId: p.id });
  res.json({ ok: true, pinned: p.pinned });
}));

r.post('/posts/:id/moderate', requirePermission('admin.moderate'), ah(async (req, res) => {
  const { status, reason } = parse(z.object({ status: z.enum(['published', 'hidden', 'removed']), reason: optStr(500) }), req.body);
  const p = await prisma.communityPost.update({ where: { id: String(req.params.id) }, data: { status } });
  if (status !== 'published') await notify(p.authorId, { type: 'moderation', title: `Your post "${p.title.slice(0, 80)}" was ${status} by a moderator`, body: reason || null, link: `/app/community/${p.id}` });
  await audit(req, 'community.post_moderated', { entityType: 'community_post', entityId: p.id, details: { status, reason } });
  res.json({ ok: true, status: p.status });
}));

r.post('/comments/:id/moderate', requirePermission('admin.moderate'), ah(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['published', 'removed']) }), req.body);
  const c = await prisma.communityComment.update({ where: { id: String(req.params.id) }, data: { status } });
  await audit(req, 'community.comment_moderated', { entityType: 'community_comment', entityId: c.id, details: { status } });
  res.json({ ok: true, status: c.status });
}));

export default r;
