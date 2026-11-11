import { describe, it, expect, afterEach, vi } from 'vitest';
import { prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { sendSystemMail, systemMailConfigured, parseFrom } from '../src/services/email/system.js';

const realFetch = global.fetch;
afterEach(async () => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
  await setSetting('brevo.apiKey', '', null);
  await setSetting('smtp.from', '', null);
  await prisma.systemSetting.deleteMany({ where: { key: 'mail.platformBudget' } });
});

describe('platform mail through the Brevo API', () => {
  it('parses From addresses with and without a display name', () => {
    expect(parseFrom('DispatchDesk <no-reply@dispatchdesk.work.gd>')).toEqual({ name: 'DispatchDesk', email: 'no-reply@dispatchdesk.work.gd' });
    expect(parseFrom('"Dispatch Desk" <a@b.co>')).toEqual({ name: 'Dispatch Desk', email: 'a@b.co' });
    expect(parseFrom('plain@x.io')).toEqual({ email: 'plain@x.io' });
  });

  it('counts as configured with a Brevo key and a From address, no SMTP host needed', async () => {
    expect(await systemMailConfigured()).toBe(false);
    await setSetting('brevo.apiKey', 'xkeysib-test', null);
    expect(await systemMailConfigured()).toBe(false); // still needs From
    await setSetting('smtp.from', 'DispatchDesk <no-reply@example.com>', null);
    expect(await systemMailConfigured()).toBe(true);
  });

  it('sends through https://api.brevo.com/v3/smtp/email with the key in the api-key header', async () => {
    await setSetting('brevo.apiKey', 'xkeysib-test', null);
    await setSetting('smtp.from', 'DispatchDesk <no-reply@example.com>', null);
    const calls = [];
    global.fetch = vi.fn(async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ messageId: '<abc@smtp-relay.mailin.fr>' }), { status: 201, headers: { 'content-type': 'application/json' } }); });
    const r = await sendSystemMail({ to: 'user@example.com', subject: 'Verify your email', text: 'Hello', html: '<p>Hello</p>' });
    expect(r).toEqual({ sent: true, messageId: '<abc@smtp-relay.mailin.fr>' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(calls[0].init.headers['api-key']).toBe('xkeysib-test');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      sender: { name: 'DispatchDesk', email: 'no-reply@example.com' }, to: [{ email: 'user@example.com' }],
      subject: 'Verify your email', textContent: 'Hello', htmlContent: '<p>Hello</p>',
    });
    const budget = JSON.parse((await prisma.systemSetting.findUnique({ where: { key: 'mail.platformBudget' } })).value);
    expect(budget.sent).toBe(1);
  });

  it('reports Brevo errors without throwing and records them in the daily status', async () => {
    await setSetting('brevo.apiKey', 'xkeysib-test', null);
    await setSetting('smtp.from', 'no-reply@example.com', null);
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await sendSystemMail({ to: 'user@example.com', subject: 'x', text: 'y' });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/Brevo 401: Key not found/);
    const budget = JSON.parse((await prisma.systemSetting.findUnique({ where: { key: 'mail.platformBudget' } })).value);
    expect(budget.failed).toBe(1);
    expect(budget.lastError).toMatch(/Brevo 401/);
  });
});
