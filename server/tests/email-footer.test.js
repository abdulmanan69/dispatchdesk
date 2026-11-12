import { describe, it, expect } from 'vitest';

const { registerUser, prisma } = await import('./helpers.js');
const { toWire, footerAddress } = await import('../src/services/email/render.js');

describe('email footer (CAN-SPAM)', () => {
  it('prints the postal address above the unsubscribe link, in text and HTML', () => {
    const w = toWire({ ownerId: 'u1', to: 'a@b.test', subject: 'Hi', body: 'Hello', mailingAddress: '123 Main St, Suite 4\nDallas, TX 75201' });
    expect(w.text).toMatch(/--\n123 Main St, Suite 4, Dallas, TX 75201\nDon't want these emails\? Unsubscribe: /);
    expect(w.html).toContain('123 Main St, Suite 4, Dallas, TX 75201<br>Don&#39;t want'.replace('&#39;', "'"));
    expect(w.headers['List-Unsubscribe']).toMatch(/^<.*\/api\/public\/unsubscribe\?token=/);
  });

  it('escapes the address in HTML and leaves it out when blank', () => {
    const w = toWire({ ownerId: 'u1', to: 'a@b.test', subject: 'Hi', body: 'x', mailingAddress: '<b>1 Elm</b> & Co' });
    expect(w.html).toContain('&lt;b&gt;1 Elm&lt;/b&gt; &amp; Co<br>');
    const none = toWire({ ownerId: 'u1', to: 'a@b.test', subject: 'Hi', body: 'x' });
    expect(none.text).toMatch(/--\nDon't want these emails\?/);
    expect(footerAddress('  \n ')).toBeNull();
  });

  it('is saved on the profile and returned with the account', async () => {
    const A = await registerUser();
    const res = await A.agent.patch('/api/profile').send({ mailingAddress: '  PO Box 12\nAustin, TX 78701 ' });
    expect(res.status).toBe(200);
    expect(res.body.user.mailingAddress).toBe('PO Box 12\nAustin, TX 78701');
    expect((await prisma.user.findUnique({ where: { id: A.user.id } })).mailingAddress).toBe('PO Box 12\nAustin, TX 78701');
    expect((await A.agent.patch('/api/profile').send({ mailingAddress: 'x'.repeat(301) })).status).toBe(400);
    const cleared = await A.agent.patch('/api/profile').send({ mailingAddress: '' });
    expect(cleared.body.user.mailingAddress).toBeNull();
  });
});
