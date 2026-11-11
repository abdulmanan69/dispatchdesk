import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db.js';
import { ah, notFound, badRequest, conflict } from '../lib/errors.js';
import { parse, z, reqStr, optStr, reqEmail, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { TRAINING_CATEGORIES } from '../lib/constants.js';
import { requireAuth, requirePermission, avatarUrl } from '../middleware/auth.js';
import { publicFormLimiter } from '../middleware/security.js';
import { uploader, verifyFileSignature, removeFile, filePath } from '../middleware/upload.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/activity.js';

const r = Router();
const attachmentUpload = uploader('training', 'training', 200);
const manage = requirePermission('training.manage');

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 80);

/** Accept YouTube/Vimeo URLs only and normalise them to an embeddable player URL. */
export function normalizeVideoUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw badRequest('Video URL is not a valid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('Video URL must be http(s)');
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const idOk = (id) => /^[\w-]{6,20}$/.test(id || '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/);
    if (!id && m) id = m[1];
    if (!idOk(id)) throw badRequest('Could not read the YouTube video id');
    return `https://www.youtube-nocookie.com/embed/${id}`;
  }
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (!idOk(id)) throw badRequest('Could not read the YouTube video id');
    return `https://www.youtube-nocookie.com/embed/${id}`;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(\d{5,12})/);
    if (!m) throw badRequest('Could not read the Vimeo video id');
    return `https://player.vimeo.com/video/${m[1]}`;
  }
  throw badRequest('Only YouTube or Vimeo video links are supported');
}

async function trainerIds() {
  const users = await prisma.user.findMany({
    where: { status: 'active', role: { permissions: { some: { permission: { key: 'training.manage' } } } } },
    select: { id: true }, take: 25,
  });
  return users.map((u) => u.id);
}

async function progressByCourse(userId, courseIds) {
  if (!userId || !courseIds.length) return new Map();
  const rows = await prisma.trainingProgress.findMany({
    where: { userId, lesson: { courseId: { in: courseIds } } },
    select: { lesson: { select: { courseId: true } }, completedAt: true },
  });
  const map = new Map();
  for (const row of rows) {
    const c = map.get(row.lesson.courseId) || { completed: 0, lastAt: null };
    c.completed += 1;
    if (!c.lastAt || row.completedAt > c.lastAt) c.lastAt = row.completedAt;
    map.set(row.lesson.courseId, c);
  }
  return map;
}

const courseSummary = (c, prog) => {
  const total = c._count?.lessons ?? c.lessons?.length ?? 0;
  const done = prog?.completed ?? 0;
  return {
    id: c.id, title: c.title, slug: c.slug, description: c.description, category: c.category, level: c.level,
    published: c.published, sortOrder: c.sortOrder, lessonCount: total,
    totalMinutes: c.lessons ? c.lessons.reduce((s, l) => s + (l.durationMinutes || 0), 0) : undefined,
    progress: prog !== undefined ? { completed: done, total, percent: total ? Math.round((done / total) * 100) : 0, complete: total > 0 && done >= total, lastActivityAt: prog?.lastAt ?? null } : undefined,
  };
};

// ---------------------------------------------------------------------------
// Public catalogue
// ---------------------------------------------------------------------------

r.get('/courses', ah(async (req, res) => {
  const q = parse(z.object({ category: z.enum(TRAINING_CATEGORIES).optional(), q: z.string().max(100).optional() }), req.query);
  const courses = await prisma.trainingCourse.findMany({
    where: {
      published: true,
      ...(q.category ? { category: q.category } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q } }, { description: { contains: q.q } }] } : {}),
    },
    include: { lessons: { select: { durationMinutes: true } }, _count: { select: { lessons: true } } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const prog = req.user ? await progressByCourse(req.user.id, courses.map((c) => c.id)) : null;
  res.json({ items: courses.map((c) => courseSummary(c, prog ? prog.get(c.id) ?? { completed: 0 } : undefined)), categories: TRAINING_CATEGORIES });
}));

r.get('/courses/:slug', ah(async (req, res) => {
  const course = await prisma.trainingCourse.findUnique({
    where: { slug: String(req.params.slug) },
    include: { lessons: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, durationMinutes: true, sortOrder: true, videoUrl: true, attachmentName: true } } },
  });
  const isManager = req.permissions?.has('training.manage');
  if (!course || (!course.published && !isManager)) throw notFound('Course not found');
  let completedIds = new Set();
  if (req.user) {
    const rows = await prisma.trainingProgress.findMany({ where: { userId: req.user.id, lessonId: { in: course.lessons.map((l) => l.id) } }, select: { lessonId: true } });
    completedIds = new Set(rows.map((x) => x.lessonId));
  }
  const total = course.lessons.length;
  res.json({
    course: {
      ...courseSummary(course, req.user ? { completed: completedIds.size } : undefined),
      lessons: course.lessons.map((l) => ({ id: l.id, title: l.title, durationMinutes: l.durationMinutes, hasVideo: !!l.videoUrl, hasAttachment: !!l.attachmentName, completed: completedIds.has(l.id) })),
      nextLessonId: course.lessons.find((l) => !completedIds.has(l.id))?.id ?? course.lessons[0]?.id ?? null,
      totalLessons: total,
    },
  });
}));

// ---------------------------------------------------------------------------
// Learner endpoints
// ---------------------------------------------------------------------------

async function loadLessonForLearner(req, id) {
  const lesson = await prisma.trainingLesson.findUnique({ where: { id: String(id) }, include: { course: true } });
  if (!lesson || (!lesson.course.published && !req.permissions?.has('training.manage'))) throw notFound('Lesson not found');
  return lesson;
}

r.get('/lessons/:id', requireAuth, ah(async (req, res) => {
  const lesson = await loadLessonForLearner(req, req.params.id);
  const siblings = await prisma.trainingLesson.findMany({ where: { courseId: lesson.courseId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true } });
  const idx = siblings.findIndex((s) => s.id === lesson.id);
  const done = await prisma.trainingProgress.findUnique({ where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } } });
  res.json({
    lesson: {
      id: lesson.id, title: lesson.title, content: lesson.content, videoUrl: lesson.videoUrl, durationMinutes: lesson.durationMinutes,
      attachmentName: lesson.attachmentName, hasAttachment: !!lesson.attachmentPath, completed: !!done, completedAt: done?.completedAt ?? null,
      position: idx + 1, total: siblings.length,
      prev: siblings[idx - 1] ?? null, next: siblings[idx + 1] ?? null,
      course: { id: lesson.course.id, title: lesson.course.title, slug: lesson.course.slug },
    },
  });
}));

r.post('/lessons/:id/complete', requireAuth, ah(async (req, res) => {
  const lesson = await loadLessonForLearner(req, req.params.id);
  await prisma.trainingProgress.upsert({
    where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } },
    create: { userId: req.user.id, lessonId: lesson.id }, update: {},
  });
  const [total, done] = await Promise.all([
    prisma.trainingLesson.count({ where: { courseId: lesson.courseId } }),
    prisma.trainingProgress.count({ where: { userId: req.user.id, lesson: { courseId: lesson.courseId } } }),
  ]);
  const courseComplete = total > 0 && done >= total;
  if (courseComplete) await notify(req.user.id, { type: 'training', title: `Course completed: ${lesson.course.title}`, link: `/app/training/${lesson.course.slug}` });
  res.json({ ok: true, completed: done, total, courseComplete });
}));

r.delete('/lessons/:id/complete', requireAuth, ah(async (req, res) => {
  await prisma.trainingProgress.deleteMany({ where: { userId: req.user.id, lessonId: String(req.params.id) } });
  res.json({ ok: true });
}));

r.get('/lessons/:id/attachment', requireAuth, ah(async (req, res) => {
  const lesson = await loadLessonForLearner(req, req.params.id);
  if (!lesson.attachmentPath) throw notFound('No attachment');
  const p = filePath('training', lesson.attachmentPath);
  if (!fs.existsSync(p)) throw notFound('Attachment file missing');
  res.download(p, lesson.attachmentName || path.basename(p));
}));

r.get('/me/dashboard', requireAuth, ah(async (req, res) => {
  const courses = await prisma.trainingCourse.findMany({
    where: { published: true },
    include: { lessons: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, durationMinutes: true } }, _count: { select: { lessons: true } } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const progressRows = await prisma.trainingProgress.findMany({ where: { userId: req.user.id }, select: { lessonId: true, completedAt: true } });
  const doneSet = new Set(progressRows.map((p) => p.lessonId));
  const prog = await progressByCourse(req.user.id, courses.map((c) => c.id));
  const items = courses.map((c) => {
    const s = courseSummary(c, prog.get(c.id) ?? { completed: 0 });
    const next = c.lessons.find((l) => !doneSet.has(l.id));
    return { ...s, nextLesson: next ? { id: next.id, title: next.title } : null };
  });
  const started = items.filter((c) => c.progress.completed > 0 && !c.progress.complete);
  const completed = items.filter((c) => c.progress.complete);
  const continueCourse = started.sort((a, b) => new Date(b.progress.lastActivityAt) - new Date(a.progress.lastActivityAt))[0] ?? null;
  const unreadTrainer = await prisma.trainerMessage.count({ where: { threadUserId: req.user.id, fromTrainer: true, readAt: null } });
  res.json({
    stats: { lessonsCompleted: progressRows.length, coursesStarted: started.length + completed.length, coursesCompleted: completed.length, totalCourses: items.length, unreadTrainerMessages: unreadTrainer },
    continueCourse,
    courses: items,
  });
}));

// ---------------------------------------------------------------------------
// Training requests (public "book a slot" form)
// ---------------------------------------------------------------------------

r.post('/requests', publicFormLimiter, ah(async (req, res) => {
  const body = parse(z.object({ name: reqStr(120), email: reqEmail, phone: optStr(40), message: optStr(2000) }), req.body);
  const row = await prisma.trainingRequest.create({ data: { ...body, userId: req.user?.id ?? null } });
  for (const id of await trainerIds()) {
    await notify(id, { type: 'training_request', title: `New training request from ${body.name}`, body: body.email, link: '/app/admin/training?tab=requests' });
  }
  res.status(201).json({ ok: true, id: row.id, message: 'Your interest is saved. A trainer will contact you about the next batch — this does not reserve a seat yet.' });
}));

// ---------------------------------------------------------------------------
// Trainer messaging (student side)
// ---------------------------------------------------------------------------

const authorSelect = { id: true, name: true, avatarPath: true };
const msgOut = (m) => ({ id: m.id, body: m.body, fromTrainer: m.fromTrainer, readAt: m.readAt, createdAt: m.createdAt, author: m.author ? { id: m.author.id, name: m.author.name, avatarUrl: avatarUrl(m.author) } : null });

r.get('/messages', requireAuth, ah(async (req, res) => {
  const rows = await prisma.trainerMessage.findMany({ where: { threadUserId: req.user.id }, include: { author: { select: authorSelect } }, orderBy: { createdAt: 'asc' }, take: 500 });
  await prisma.trainerMessage.updateMany({ where: { threadUserId: req.user.id, fromTrainer: true, readAt: null }, data: { readAt: new Date() } });
  res.json({ items: rows.map(msgOut) });
}));

r.post('/messages', requireAuth, ah(async (req, res) => {
  const { body } = parse(z.object({ body: reqStr(4000) }), req.body);
  const m = await prisma.trainerMessage.create({ data: { threadUserId: req.user.id, authorId: req.user.id, fromTrainer: false, body }, include: { author: { select: authorSelect } } });
  for (const id of await trainerIds()) {
    if (id !== req.user.id) await notify(id, { type: 'trainer_message', title: `Training question from ${req.user.name}`, body: body.slice(0, 140), link: `/app/admin/training?tab=inbox&user=${req.user.id}` });
  }
  res.status(201).json({ message: msgOut(m) });
}));

// ---------------------------------------------------------------------------
// Administration (training.manage)
// ---------------------------------------------------------------------------

const courseBody = z.object({
  title: reqStr(160),
  slug: z.string().trim().max(80).optional(),
  description: optStr(2000),
  category: z.enum(TRAINING_CATEGORIES).optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  published: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
});

r.get('/admin/courses', manage, ah(async (req, res) => {
  const courses = await prisma.trainingCourse.findMany({
    include: { _count: { select: { lessons: true } } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  res.json({ items: courses.map((c) => courseSummary(c)) });
}));

r.get('/admin/courses/:id', manage, ah(async (req, res) => {
  const course = await prisma.trainingCourse.findUnique({ where: { id: String(req.params.id) }, include: { lessons: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } });
  if (!course) throw notFound('Course not found');
  res.json({
    course: {
      ...courseSummary(course),
      lessons: course.lessons.map((l) => ({ id: l.id, title: l.title, content: l.content, videoUrl: l.videoUrl, durationMinutes: l.durationMinutes, sortOrder: l.sortOrder, attachmentName: l.attachmentName, hasAttachment: !!l.attachmentPath })),
    },
  });
}));

r.post('/admin/courses', manage, ah(async (req, res) => {
  const body = parse(courseBody, req.body);
  const slug = slugify(body.slug || body.title);
  if (!slug) throw badRequest('Slug is empty');
  if (await prisma.trainingCourse.findUnique({ where: { slug } })) throw conflict('A course with this slug already exists');
  const course = await prisma.trainingCourse.create({ data: { ...clean(body), slug, createdById: req.user.id } });
  await audit(req, 'training.course_created', { entityType: 'training_course', entityId: course.id, details: { title: course.title } });
  res.status(201).json({ course: courseSummary({ ...course, _count: { lessons: 0 } }) });
}));

r.patch('/admin/courses/:id', manage, ah(async (req, res) => {
  const body = parse(courseBody.partial(), req.body);
  const existing = await prisma.trainingCourse.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw notFound('Course not found');
  const data = clean(body);
  if (data.slug !== undefined) {
    data.slug = slugify(data.slug);
    if (!data.slug) throw badRequest('Slug is empty');
    const other = await prisma.trainingCourse.findUnique({ where: { slug: data.slug } });
    if (other && other.id !== existing.id) throw conflict('A course with this slug already exists');
  }
  const course = await prisma.trainingCourse.update({ where: { id: existing.id }, data, include: { _count: { select: { lessons: true } } } });
  await audit(req, 'training.course_updated', { entityType: 'training_course', entityId: course.id, details: data });
  res.json({ course: courseSummary(course) });
}));

r.delete('/admin/courses/:id', manage, ah(async (req, res) => {
  const course = await prisma.trainingCourse.findUnique({ where: { id: String(req.params.id) }, include: { lessons: true } });
  if (!course) throw notFound('Course not found');
  for (const l of course.lessons) removeFile('training', l.attachmentPath);
  await prisma.trainingCourse.delete({ where: { id: course.id } });
  await audit(req, 'training.course_deleted', { entityType: 'training_course', entityId: course.id, details: { title: course.title } });
  res.json({ ok: true });
}));

const lessonBody = z.object({
  title: reqStr(200),
  content: z.string().max(100000).optional(),
  videoUrl: optStr(500),
  durationMinutes: z.coerce.number().int().min(1).max(600).optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
});

const lessonOut = (l) => ({ id: l.id, courseId: l.courseId, title: l.title, content: l.content, videoUrl: l.videoUrl, durationMinutes: l.durationMinutes, sortOrder: l.sortOrder, attachmentName: l.attachmentName, hasAttachment: !!l.attachmentPath });

r.post('/admin/courses/:id/lessons', manage, ah(async (req, res) => {
  const course = await prisma.trainingCourse.findUnique({ where: { id: String(req.params.id) } });
  if (!course) throw notFound('Course not found');
  const body = parse(lessonBody, req.body);
  const max = await prisma.trainingLesson.aggregate({ where: { courseId: course.id }, _max: { sortOrder: true } });
  const lesson = await prisma.trainingLesson.create({
    data: {
      courseId: course.id, title: body.title, content: body.content ?? '', videoUrl: normalizeVideoUrl(body.videoUrl),
      durationMinutes: body.durationMinutes ?? 10, sortOrder: body.sortOrder ?? (max._max.sortOrder ?? -1) + 1,
    },
  });
  await audit(req, 'training.lesson_created', { entityType: 'training_lesson', entityId: lesson.id });
  res.status(201).json({ lesson: lessonOut(lesson) });
}));

r.patch('/admin/lessons/:id', manage, ah(async (req, res) => {
  const body = parse(lessonBody.partial(), req.body);
  const lesson = await prisma.trainingLesson.findUnique({ where: { id: String(req.params.id) } });
  if (!lesson) throw notFound('Lesson not found');
  const data = clean(body);
  if ('videoUrl' in body) data.videoUrl = normalizeVideoUrl(body.videoUrl);
  const updated = await prisma.trainingLesson.update({ where: { id: lesson.id }, data });
  await audit(req, 'training.lesson_updated', { entityType: 'training_lesson', entityId: lesson.id });
  res.json({ lesson: lessonOut(updated) });
}));

r.delete('/admin/lessons/:id', manage, ah(async (req, res) => {
  const lesson = await prisma.trainingLesson.findUnique({ where: { id: String(req.params.id) } });
  if (!lesson) throw notFound('Lesson not found');
  removeFile('training', lesson.attachmentPath);
  await prisma.trainingLesson.delete({ where: { id: lesson.id } });
  await audit(req, 'training.lesson_deleted', { entityType: 'training_lesson', entityId: lesson.id });
  res.json({ ok: true });
}));

r.post('/admin/lessons/:id/attachment', manage, attachmentUpload.single('file'), ah(async (req, res) => {
  const lesson = await prisma.trainingLesson.findUnique({ where: { id: String(req.params.id) } });
  if (!lesson) { if (req.file) removeFile('training', req.file.filename); throw notFound('Lesson not found'); }
  if (!req.file) throw badRequest('No file uploaded');
  verifyFileSignature(req.file);
  if (lesson.attachmentPath) removeFile('training', lesson.attachmentPath);
  const updated = await prisma.trainingLesson.update({
    where: { id: lesson.id },
    data: { attachmentPath: req.file.filename, attachmentName: path.basename(req.file.originalname).slice(0, 200) },
  });
  await audit(req, 'training.attachment_uploaded', { entityType: 'training_lesson', entityId: lesson.id, details: { name: updated.attachmentName } });
  res.json({ lesson: lessonOut(updated) });
}));

r.delete('/admin/lessons/:id/attachment', manage, ah(async (req, res) => {
  const lesson = await prisma.trainingLesson.findUnique({ where: { id: String(req.params.id) } });
  if (!lesson) throw notFound('Lesson not found');
  removeFile('training', lesson.attachmentPath);
  const updated = await prisma.trainingLesson.update({ where: { id: lesson.id }, data: { attachmentPath: null, attachmentName: null } });
  res.json({ lesson: lessonOut(updated) });
}));

const REQUEST_STATUSES = ['new', 'contacted', 'enrolled', 'closed'];

r.get('/admin/requests', manage, ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, status: z.enum(REQUEST_STATUSES).optional(), q: z.string().max(100).optional() }), req.query);
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.q ? { OR: [{ name: { contains: q.q } }, { email: { contains: q.q } }, { phone: { contains: q.q } }] } : {}),
  };
  const [items, total, counts] = await Promise.all([
    prisma.trainingRequest.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
    prisma.trainingRequest.count({ where }),
    prisma.trainingRequest.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  res.json({ ...pageResult(items, total, q), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) });
}));

r.patch('/admin/requests/:id', manage, ah(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(REQUEST_STATUSES) }), req.body);
  const row = await prisma.trainingRequest.update({ where: { id: String(req.params.id) }, data: { status } });
  await audit(req, 'training.request_status', { entityType: 'training_request', entityId: row.id, details: { status } });
  res.json({ request: row });
}));

r.get('/admin/threads', manage, ah(async (req, res) => {
  const latest = await prisma.trainerMessage.groupBy({ by: ['threadUserId'], _max: { createdAt: true }, orderBy: { _max: { createdAt: 'desc' } }, take: 200 });
  const unread = await prisma.trainerMessage.groupBy({ by: ['threadUserId'], where: { fromTrainer: false, readAt: null }, _count: { _all: true } });
  const unreadMap = new Map(unread.map((u) => [u.threadUserId, u._count._all]));
  const users = await prisma.user.findMany({ where: { id: { in: latest.map((l) => l.threadUserId) } }, select: { id: true, name: true, email: true, avatarPath: true } });
  const userMap = new Map(users.map((u) => [u.id, u]));
  const lastMessages = await Promise.all(latest.map((l) => prisma.trainerMessage.findFirst({ where: { threadUserId: l.threadUserId }, orderBy: { createdAt: 'desc' } })));
  res.json({
    items: latest.map((l, i) => {
      const u = userMap.get(l.threadUserId);
      return {
        userId: l.threadUserId, name: u?.name ?? 'Unknown', email: u?.email ?? null,
        avatarUrl: avatarUrl(u),
        lastMessage: lastMessages[i]?.body?.slice(0, 160) ?? '', lastFromTrainer: lastMessages[i]?.fromTrainer ?? false,
        lastAt: l._max.createdAt, unread: unreadMap.get(l.threadUserId) ?? 0,
      };
    }),
  });
}));

r.get('/admin/threads/:userId', manage, ah(async (req, res) => {
  const student = await prisma.user.findUnique({ where: { id: String(req.params.userId) }, select: { id: true, name: true, email: true } });
  if (!student) throw notFound('User not found');
  const rows = await prisma.trainerMessage.findMany({ where: { threadUserId: student.id }, include: { author: { select: authorSelect } }, orderBy: { createdAt: 'asc' }, take: 500 });
  await prisma.trainerMessage.updateMany({ where: { threadUserId: student.id, fromTrainer: false, readAt: null }, data: { readAt: new Date() } });
  res.json({ student, items: rows.map(msgOut) });
}));

r.post('/admin/threads/:userId', manage, ah(async (req, res) => {
  const { body } = parse(z.object({ body: reqStr(4000) }), req.body);
  const student = await prisma.user.findUnique({ where: { id: String(req.params.userId) } });
  if (!student) throw notFound('User not found');
  const m = await prisma.trainerMessage.create({ data: { threadUserId: student.id, authorId: req.user.id, fromTrainer: true, body }, include: { author: { select: authorSelect } } });
  await notify(student.id, { type: 'trainer_message', title: `Your trainer replied`, body: body.slice(0, 140), link: '/app/training/messages' });
  await audit(req, 'training.trainer_reply', { entityType: 'user', entityId: student.id });
  res.status(201).json({ message: msgOut(m) });
}));

export default r;
