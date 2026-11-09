import { describe, it, expect } from 'vitest';
import { agent, registerUser, createAdmin, prisma } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc4cd0b0000000049454e44ae426082', 'hex');

describe('marketplace', () => {
  it('creates, browses, edits and deletes own listings', async () => {
    const { agent: seller } = await registerUser({ name: 'Seller One' });
    const bad = await seller.post('/api/marketplace/listings').send({ title: 'x', category: 'services', description: 'd', priceType: 'fixed' });
    expect(bad.status).toBe(400); // fixed price needs an amount
    const created = await seller.post('/api/marketplace/listings').send({
      title: 'Flatbed dispatch service', category: 'services', description: 'We dispatch **flatbeds** in TX.', priceType: 'monthly', priceCents: 29900, contactEmail: 'Seller@Example.test',
    });
    expect(created.status).toBe(201);
    const id = created.body.listing.id;
    expect(created.body.listing.contactEmail).toBe('seller@example.test');

    const anon = await agent();
    const list = await anon.get('/api/marketplace/listings?category=services&q=flatbed');
    expect(list.body.items.some((l) => l.id === id)).toBe(true);
    const detail = await anon.get(`/api/marketplace/listings/${id}`);
    expect(detail.body.listing.contactEmail).toBeNull(); // hidden from anonymous visitors
    expect(detail.body.listing.seller.name).toBe('Seller One');

    const img = await seller.post(`/api/marketplace/listings/${id}/image`).attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(img.status).toBe(200);
    expect((await anon.get(img.body.listing.imageUrl)).status).toBe(200);

    const hidden = await seller.patch(`/api/marketplace/listings/${id}`).send({ status: 'hidden' });
    expect(hidden.body.listing.status).toBe('hidden');
    expect((await anon.get(`/api/marketplace/listings/${id}`)).status).toBe(404);
    const mine = await seller.get('/api/marketplace/mine');
    expect(mine.body.items[0].id).toBe(id);

    expect((await seller.delete(`/api/marketplace/listings/${id}`)).status).toBe(200);
    expect(await prisma.marketplaceListing.count({ where: { id } })).toBe(0);
  });

  it('prevents editing or deleting another user\'s listing', async () => {
    const { agent: seller } = await registerUser();
    const { agent: other } = await registerUser();
    const { body } = await seller.post('/api/marketplace/listings').send({ title: 'Load board course', category: 'training', description: 'Course', priceType: 'free' });
    const id = body.listing.id;
    expect((await other.patch(`/api/marketplace/listings/${id}`).send({ title: 'Hijacked' })).status).toBe(404);
    expect((await other.delete(`/api/marketplace/listings/${id}`)).status).toBe(404);
    expect((await other.post(`/api/marketplace/listings/${id}/moderate`).send({ status: 'removed' })).status).toBe(403);
    const anon = await agent();
    expect((await anon.post('/api/marketplace/listings').send({ title: 'x', category: 'training', description: 'y', priceType: 'free' })).status).toBe(401);
  });

  it('supports contacting sellers and threaded inbox replies', async () => {
    const { agent: seller, user: sellerUser } = await registerUser();
    const { agent: buyer, user: buyerUser } = await registerUser();
    const { agent: stranger } = await registerUser();
    const { body } = await seller.post('/api/marketplace/listings').send({ title: 'Hiring dispatchers', category: 'hiring', description: 'Remote role', priceType: 'contact' });
    const id = body.listing.id;

    expect((await seller.post(`/api/marketplace/listings/${id}/contact`).send({ body: 'self' })).status).toBe(400);
    const c = await buyer.post(`/api/marketplace/listings/${id}/contact`).send({ body: 'Is this still open?' });
    expect(c.status).toBe(201);

    const inbox = await seller.get('/api/marketplace/inbox');
    expect(inbox.body.unread).toBe(1);
    const t = inbox.body.items.find((x) => x.listingId === id);
    expect(t.user.id).toBe(buyerUser.id);

    const thread = await seller.get(`/api/marketplace/inbox/${id}/${buyerUser.id}`);
    expect(thread.body.items).toHaveLength(1);
    expect((await seller.get('/api/marketplace/inbox')).body.unread).toBe(0);
    expect((await seller.post(`/api/marketplace/inbox/${id}/${buyerUser.id}`).send({ body: 'Yes, apply here.' })).status).toBe(201);
    // seller cannot cold-message someone who never contacted them
    const strangerUser = (await stranger.get('/api/auth/me')).body.user;
    expect((await seller.post(`/api/marketplace/inbox/${id}/${strangerUser.id}`).send({ body: 'hi' })).status).toBe(403);
    // a third party cannot read the conversation
    expect((await stranger.get(`/api/marketplace/inbox/${id}/${buyerUser.id}`)).status).toBe(404);

    const buyerThread = await buyer.get(`/api/marketplace/inbox/${id}/${sellerUser.id}`);
    expect(buyerThread.body.items.map((m) => m.mine)).toEqual([true, false]);
  });

  it('records reports and lets moderators remove listings', async () => {
    const { agent: seller, user: sellerUser } = await registerUser();
    const { agent: reporter } = await registerUser();
    const { agent: admin } = await createAdmin();
    const { body } = await seller.post('/api/marketplace/listings').send({ title: 'Guaranteed $10k/week', category: 'consulting', description: 'Too good', priceType: 'contact' });
    const id = body.listing.id;
    const rep = await reporter.post(`/api/marketplace/listings/${id}/report`).send({ reason: 'scam', details: 'Unrealistic promises' });
    expect(rep.status).toBe(201);
    const dup = await reporter.post(`/api/marketplace/listings/${id}/report`).send({ reason: 'scam' });
    expect(dup.body.duplicate).toBe(true);
    expect(await prisma.contentReport.count({ where: { listingId: id } })).toBe(1);

    const mod = await admin.post(`/api/marketplace/listings/${id}/moderate`).send({ status: 'removed', reason: 'Misleading' });
    expect(mod.body.listing.status).toBe('removed');
    expect((await seller.patch(`/api/marketplace/listings/${id}`).send({ status: 'active' })).status).toBe(403);
    expect(await prisma.notification.count({ where: { userId: sellerUser.id, type: 'moderation' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'marketplace.listing_moderated', entityId: id } })).toBe(1);
  });
});
