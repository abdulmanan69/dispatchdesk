import { describe, it, expect, vi, afterAll } from 'vitest';

const { registerUser, createAdmin } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { adminMessage } = await import('../src/services/email/platformTemplate.js');

describe('admin emails selected users', () => {
  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const k of ['brevo.apiKey', 'smtp.from', 'app.supportEmail']) await setSetting(k, '');
  });

  it('sends each user a branded email from the platform address with replies to support', async () => {
    const admin = await createAdmin();
    const A = await registerUser();
    const B = await registerUser();
    await setSetting('brevo.apiKey', 'xkeysib-test');
    await setSetting('smtp.from', 'DispatchDesk <no-reply@dispatch.test>');
    await setSetting('app.supportEmail', 'team@dispatch.test');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => { calls.push({ url: String(url), body: JSON.parse(opts.body) }); return { ok: true, status: 201, json: async () => ({ messageId: `<m${calls.length}@brevo>` }) }; }));

    const r = await admin.agent.post('/api/admin/users/email').send({ userIds: [A.user.id, B.user.id], subject: 'Welcome, early bird', message: 'You are one of our first users.\n\nEnjoy a free month of Pro.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sent: 2, failed: [] });
    expect(calls).toHaveLength(2);
    const first = calls.find((c) => c.body.to[0].email === A.user.email).body;
    expect(first).toMatchObject({ sender: { name: 'DispatchDesk', email: 'no-reply@dispatch.test' }, replyTo: { email: 'team@dispatch.test' }, subject: 'Welcome, early bird' });
    expect(first.textContent).toContain('You are one of our first users.');
    expect(first.htmlContent).toContain('Enjoy a free month of Pro.');

    // Only admins, and the fields are required.
    expect((await A.agent.post('/api/admin/users/email').send({ userIds: [B.user.id], subject: 's', message: 'm' })).status).toBe(403);
    expect((await admin.agent.post('/api/admin/users/email').send({ userIds: [A.user.id], subject: '', message: 'm' })).status).toBe(400);
  });

  it('escapes the admin text in the HTML and keeps paragraphs', () => {
    const m = adminMessage({ name: 'Sam <b>', subject: 'Hi', message: 'One\nline\n\n<script>x</script>', appUrl: 'https://x.test', supportEmail: 's@x.test' });
    expect(m.html).not.toContain('<script>x</script>');
    expect(m.html).toContain('Sam &lt;b&gt;');
    expect(m.text).toContain('One line');
    expect(m.text).toContain('https://x.test/app');
  });
});
