import { describe, it, expect } from 'vitest';
import { agent, registerUser, createAdmin, prisma } from './helpers.js';

describe('training center', () => {
  it('serves the seeded catalogue publicly, lesson content only to signed-in users', async () => {
    const anon = await agent();
    const list = await anon.get('/api/training/courses');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(5);
    const course = list.body.items.find((c) => c.slug === 'dispatch-fundamentals');
    expect(course.lessonCount).toBeGreaterThanOrEqual(4);
    expect(course.progress).toBeUndefined();

    const detail = await anon.get('/api/training/courses/dispatch-fundamentals');
    expect(detail.body.course.lessons.length).toBe(course.lessonCount);
    expect(detail.body.course.lessons[0]).not.toHaveProperty('content');
    const lessonId = detail.body.course.lessons[0].id;
    expect((await anon.get(`/api/training/lessons/${lessonId}`)).status).toBe(401);
  });

  it('tracks lesson progress and course completion', async () => {
    const { agent: a } = await registerUser();
    const { body } = await a.get('/api/training/courses/carrier-sales-cold-calling');
    const lessons = body.course.lessons;
    const lesson = await a.get(`/api/training/lessons/${lessons[0].id}`);
    expect(lesson.body.lesson.content.length).toBeGreaterThan(200);
    expect(lesson.body.lesson.next.id).toBe(lessons[1].id);

    let last;
    for (const l of lessons) last = await a.post(`/api/training/lessons/${l.id}/complete`);
    expect(last.body.courseComplete).toBe(true);

    const dash = await a.get('/api/training/me/dashboard');
    expect(dash.body.stats.coursesCompleted).toBe(1);
    expect(dash.body.stats.lessonsCompleted).toBe(lessons.length);

    await a.delete(`/api/training/lessons/${lessons[0].id}/complete`);
    const after = await a.get('/api/training/courses/carrier-sales-cold-calling');
    expect(after.body.course.progress.complete).toBe(false);
    expect(after.body.course.nextLessonId).toBe(lessons[0].id);
  });

  it('accepts public training requests and validates them', async () => {
    const anon = await agent();
    const ok = await anon.post('/api/training/requests').send({ name: 'Jane Doe', email: 'jane@example.test', phone: '+1 555 0100', message: 'Next batch?' });
    expect(ok.status).toBe(201);
    const bad = await anon.post('/api/training/requests').send({ name: '', email: 'not-an-email' });
    expect(bad.status).toBe(400);
  });

  it('restricts administration to training.manage', async () => {
    const { agent: user } = await registerUser();
    expect((await user.get('/api/training/admin/courses')).status).toBe(403);
    expect((await user.post('/api/training/admin/courses').send({ title: 'Hack' })).status).toBe(403);
    expect((await user.get('/api/training/admin/requests')).status).toBe(403);
  });

  it('lets admins manage courses, lessons, attachments, requests and trainer threads', async () => {
    const { agent: admin } = await createAdmin();
    const c = await admin.post('/api/training/admin/courses').send({ title: 'Reefer Deep Dive', category: 'operations', published: false });
    expect(c.status).toBe(201);
    expect(c.body.course.slug).toBe('reefer-deep-dive');
    const dup = await admin.post('/api/training/admin/courses').send({ title: 'Reefer deep dive' });
    expect(dup.status).toBe(409);

    // unpublished courses are hidden from the public
    const anon = await agent();
    expect((await anon.get('/api/training/courses/reefer-deep-dive')).status).toBe(404);

    const badVideo = await admin.post(`/api/training/admin/courses/${c.body.course.id}/lessons`).send({ title: 'Video', videoUrl: 'https://evil.example.com/x' });
    expect(badVideo.status).toBe(400);
    const l = await admin.post(`/api/training/admin/courses/${c.body.course.id}/lessons`).send({ title: 'Pre-cooling', content: '# Pre-cool\nAlways pre-cool.', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(l.status).toBe(201);
    expect(l.body.lesson.videoUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');

    const pdf = Buffer.from('%PDF-1.4\n%test\n');
    const up = await admin.post(`/api/training/admin/lessons/${l.body.lesson.id}/attachment`).attach('file', pdf, { filename: 'checklist.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(200);
    expect(up.body.lesson.attachmentName).toBe('checklist.pdf');
    const fake = await admin.post(`/api/training/admin/lessons/${l.body.lesson.id}/attachment`).attach('file', Buffer.from('not a pdf'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(fake.status).toBe(400);

    await admin.patch(`/api/training/admin/courses/${c.body.course.id}`).send({ published: true });
    const { agent: student, user } = await registerUser();
    const dl = await student.get(`/api/training/lessons/${l.body.lesson.id}/attachment`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('checklist.pdf');

    // trainer messaging round-trip
    const sent = await student.post('/api/training/messages').send({ body: 'How do I set reefer temps?' });
    expect(sent.status).toBe(201);
    const threads = await admin.get('/api/training/admin/threads');
    const thread = threads.body.items.find((t) => t.userId === user.id);
    expect(thread.unread).toBe(1);
    await admin.post(`/api/training/admin/threads/${user.id}`).send({ body: 'Follow the shipper instructions on the BOL.' });
    const mine = await student.get('/api/training/messages');
    expect(mine.body.items.map((m) => m.fromTrainer)).toEqual([false, true]);
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'trainer_message' } })).toBe(1);

    const reqs = await admin.get('/api/training/admin/requests');
    expect(reqs.body.items.length).toBeGreaterThan(0);
    const patched = await admin.patch(`/api/training/admin/requests/${reqs.body.items[0].id}`).send({ status: 'contacted' });
    expect(patched.body.request.status).toBe('contacted');

    expect((await admin.delete(`/api/training/admin/courses/${c.body.course.id}`)).status).toBe(200);
    expect(await prisma.trainingLesson.count({ where: { courseId: c.body.course.id } })).toBe(0);
  });
});
