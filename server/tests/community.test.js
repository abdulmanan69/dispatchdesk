import { describe, it, expect } from 'vitest';
import { agent, registerUser, createAdmin, prisma } from './helpers.js';

describe('community', () => {
  it('creates posts, lists them publicly with search and category filters', async () => {
    const { agent: a } = await registerUser({ name: 'Poster' });
    const p = await a.post('/api/community/posts').send({ title: 'Best flatbed lanes out of Houston?', body: 'Looking for advice on **flatbed** lanes.', category: 'loads' });
    expect(p.status).toBe(201);
    const anon = await agent();
    const list = await anon.get('/api/community/posts?category=loads&q=Houston');
    expect(list.body.items.some((x) => x.id === p.body.post.id)).toBe(true);
    expect(list.body.categories.find((c) => c.key === 'loads').count).toBeGreaterThan(0);
    const detail = await anon.get(`/api/community/posts/${p.body.post.id}`);
    expect(detail.body.post.body).toContain('flatbed');
    expect((await anon.post('/api/community/posts').send({ title: 'x', body: 'y' })).status).toBe(401);
  });

  it('threads comments and replies and notifies the author', async () => {
    const { agent: author, user: authorUser } = await registerUser();
    const { agent: c1, user: c1User } = await registerUser({ name: 'Commenter' });
    const { agent: c2 } = await registerUser({ name: 'Replier' });
    const { body } = await author.post('/api/community/posts').send({ title: 'Broker paid late', body: 'What do you do?', category: 'brokers' });
    const postId = body.post.id;
    const top = await c1.post(`/api/community/posts/${postId}/comments`).send({ body: 'Send a polite reminder first.' });
    expect(top.status).toBe(201);
    const reply = await c2.post(`/api/community/posts/${postId}/comments`).send({ body: 'Agree.', parentId: top.body.comment.id });
    const nested = await author.post(`/api/community/posts/${postId}/comments`).send({ body: 'Thanks both', parentId: reply.body.comment.id });
    expect(nested.status).toBe(201);

    const detail = await (await agent()).get(`/api/community/posts/${postId}`);
    expect(detail.body.comments).toHaveLength(1);
    expect(detail.body.comments[0].replies).toHaveLength(2);
    expect(detail.body.comments[0].replies[1].replyingTo).toBe('Replier');

    expect(await prisma.notification.count({ where: { userId: authorUser.id, type: 'community_comment' } })).toBe(2);
    expect(await prisma.notification.count({ where: { userId: c1User.id, type: 'community_comment' } })).toBe(1);

    const wrongPost = await author.post('/api/community/posts').send({ title: 'Other', body: 'Other' });
    const bad = await c1.post(`/api/community/posts/${wrongPost.body.post.id}/comments`).send({ body: 'x', parentId: top.body.comment.id });
    expect(bad.status).toBe(400);
  });

  it('only lets authors edit/delete their own content; soft-deletes comments with replies', async () => {
    const { agent: author } = await registerUser();
    const { agent: other } = await registerUser();
    const { body } = await author.post('/api/community/posts').send({ title: 'Mine', body: 'Body' });
    const postId = body.post.id;
    expect((await other.patch(`/api/community/posts/${postId}`).send({ title: 'Hacked' })).status).toBe(404);
    expect((await other.delete(`/api/community/posts/${postId}`)).status).toBe(404);
    const edited = await author.patch(`/api/community/posts/${postId}`).send({ title: 'Mine (edited)' });
    expect(edited.body.post.title).toBe('Mine (edited)');

    const c = await author.post(`/api/community/posts/${postId}/comments`).send({ body: 'parent' });
    await other.post(`/api/community/posts/${postId}/comments`).send({ body: 'child', parentId: c.body.comment.id });
    expect((await other.patch(`/api/community/comments/${c.body.comment.id}`).send({ body: 'x' })).status).toBe(404);
    expect((await other.delete(`/api/community/comments/${c.body.comment.id}`)).status).toBe(404);
    const del = await author.delete(`/api/community/comments/${c.body.comment.id}`);
    expect(del.body.softDeleted).toBe(true);
    const detail = await author.get(`/api/community/posts/${postId}`);
    expect(detail.body.comments[0].body).toBe('[deleted]');
    expect(detail.body.comments[0].author).toBeNull();
    expect(detail.body.comments[0].replies).toHaveLength(1);

    expect((await author.delete(`/api/community/posts/${postId}`)).status).toBe(200);
  });

  it('reports content and lets moderators pin, hide and delete', async () => {
    const { agent: author } = await registerUser();
    const { agent: reporter } = await registerUser();
    const { agent: admin } = await createAdmin();
    const { body } = await author.post('/api/community/posts').send({ title: 'Spammy', body: 'Buy now' });
    const postId = body.post.id;
    expect((await author.post(`/api/community/posts/${postId}/report`).send({ reason: 'spam' })).status).toBe(400);
    expect((await reporter.post(`/api/community/posts/${postId}/report`).send({ reason: 'spam' })).status).toBe(201);
    const c = await author.post(`/api/community/posts/${postId}/comments`).send({ body: 'more spam' });
    expect((await reporter.post(`/api/community/comments/${c.body.comment.id}/report`).send({ reason: 'spam' })).status).toBe(201);
    expect(await prisma.contentReport.count({ where: { postId } })).toBe(2);

    expect((await reporter.post(`/api/community/posts/${postId}/pin`).send({ pinned: true })).status).toBe(403);
    expect((await admin.post(`/api/community/posts/${postId}/pin`).send({ pinned: true })).body.pinned).toBe(true);
    const list = await (await agent()).get('/api/community/posts');
    expect(list.body.items[0].id).toBe(postId);

    await admin.post(`/api/community/posts/${postId}/moderate`).send({ status: 'hidden', reason: 'Spam' });
    expect((await (await agent()).get(`/api/community/posts/${postId}`)).status).toBe(404);
    expect((await author.get(`/api/community/posts/${postId}`)).status).toBe(200); // author still sees it
    expect((await admin.delete(`/api/community/posts/${postId}`)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { entityId: postId, action: 'community.post_deleted' } })).toBe(1);
  });

  it('serves public profiles without private fields', async () => {
    const { agent: a, user } = await registerUser({ name: 'Profile Person' });
    await a.patch('/api/profile').send({ bio: 'Flatbed dispatcher' });
    await a.post('/api/community/posts').send({ title: 'Hello', body: 'Hi all', category: 'general' });
    const res = await (await agent()).get(`/api/community/users/${user.id}`);
    expect(res.body.user).toMatchObject({ name: 'Profile Person', bio: 'Flatbed dispatcher', postCount: 1 });
    expect(res.body.user).not.toHaveProperty('email');
    expect(res.body.posts).toHaveLength(1);
  });
});
