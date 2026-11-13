import { describe, it, expect } from 'vitest';
import { createAdmin, registerUser } from './helpers.js';
import { platformEmail, verifyEmailMessage, resetPasswordMessage, inviteMessage, carrierCodeMessage } from '../src/services/email/platformTemplate.js';

describe('platform email layout', () => {
  it('escapes every string and keeps a plain-text part with the link', () => {
    const m = platformEmail({
      heading: 'Hi <b>there</b>', paragraphs: ['Tom & "Jerry"'], button: { label: 'Open', url: 'https://x.test/a?b=1&c=<2>' },
      footer: 'Footer', footerLink: { label: 'Turn it off', url: 'https://x.test/off' },
    });
    expect(m.html).toContain('Hi &lt;b&gt;there&lt;/b&gt;');
    expect(m.html).toContain('Tom &amp; &quot;Jerry&quot;');
    expect(m.html).toContain('href="https://x.test/a?b=1&amp;c=&lt;2&gt;"');
    expect(m.html).not.toContain('<b>there</b>');
    expect(m.text).toContain('Open: https://x.test/a?b=1&c=<2>');
    expect(m.text).toContain('Turn it off: https://x.test/off');
  });

  it('builds each platform message with its link or code in both parts', () => {
    const v = verifyEmailMessage({ appName: 'DispatchDesk', name: 'Tina', email: 't@x.test', link: 'https://d.test/verify-email?token=abc' });
    expect(v.subject).toBe('Verify your DispatchDesk email');
    for (const part of [v.text, v.html]) expect(part).toContain('https://d.test/verify-email?token=abc');

    const r = resetPasswordMessage({ name: 'Tina', link: 'https://d.test/reset-password?token=xyz' });
    expect(r.subject).toBe('Reset your password');
    expect(r.html).toContain('Choose a new password');

    const i = inviteMessage({ appName: 'DispatchDesk', inviter: 'Tina', team: 'Blue Line', role: 'member', link: 'https://d.test/invite/t1' });
    expect(i.subject).toBe('Tina invited you to Blue Line on DispatchDesk');
    expect(i.text).toContain('Accept invitation: https://d.test/invite/t1');

    const c = carrierCodeMessage({ appName: 'DispatchDesk', code: '482913', name: "DEAN'S LOGISTICS LLC", dot: '3636864', signInUrl: 'https://d.test/carrier' });
    expect(c.subject).toBe('482913 is your DispatchDesk carrier sign-in code');
    expect(c.text).toContain('Your code: 482913');
    expect(c.html).toContain('>482913<');
    expect(c.html).toContain('DEAN&#39;S LOGISTICS LLC (USDOT 3636864)');
  });
});

describe('admin email previews', () => {
  it('shows every platform email to admins and sends nothing', async () => {
    const A = await createAdmin();
    const page = await A.agent.get('/api/admin/email-previews');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("frame-src 'self'");
    for (const kind of ['verify', 'reset', 'invite', 'carrier_code', 'digest']) {
      expect(page.text).toContain(`src="email-previews/${kind}"`);
      const one = await A.agent.get(`/api/admin/email-previews/${kind}`);
      expect(one.status).toBe(200);
      expect(one.headers['content-security-policy']).toContain("default-src 'none'");
      expect(one.text).toContain('the CRM for truck dispatchers');
    }
    expect((await A.agent.get('/api/admin/email-previews/nope')).status).toBe(404);
  });

  it('is admin only', async () => {
    const U = await registerUser();
    expect((await U.agent.get('/api/admin/email-previews')).status).toBe(403);
  });
});
