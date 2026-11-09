import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { registerUser, prisma, agent } from './helpers.js';
import { buildLink, validateTemplate } from '../src/services/telephony/providers.js';
import { toE164 } from '../src/services/telephony/phone.js';
import { computeSignature, verifySignature } from '../src/services/telephony/twilio.js';
import { setNow } from '../src/services/telephony/clock.js';
import { config } from '../src/config.js';

const SID = `AC${'a'.repeat(32)}`;
const TOKEN = 'twilio-test-auth-token';

// Tuesday 2026-11-10 15:00 UTC = 9:00 Central — inside calling hours.
const BUSINESS_HOURS = new Date('2026-11-10T15:00:00Z');
// Tuesday 2026-11-10 08:00 UTC = 2:00 Central — outside calling hours.
const NIGHT = new Date('2026-11-10T08:00:00Z');

async function makeCarrier(a, extra = {}) {
  const res = await a.post('/api/carriers').send({ companyName: `Tel Carrier ${Math.random().toString(36).slice(2, 7)}`, phone: `214555${String(Math.floor(Math.random() * 9000) + 1000)}`, state: 'TX', ...extra });
  expect(res.status).toBe(201);
  return res.body.carrier;
}

afterEach(() => { vi.restoreAllMocks(); setNow(null); });

describe('telephony helpers', () => {
  it('normalizes numbers to E.164', () => {
    expect(toE164('(214) 555-0101')).toBe('+12145550101');
    expect(toE164('1-214-555-0101')).toBe('+12145550101');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('555')).toBeNull();
  });

  it('builds documented provider links', () => {
    const n = '+12145550101';
    expect(buildLink('google_voice', n)).toBe('https://voice.google.com/u/0/calls?a=nc,%2B12145550101');
    expect(buildLink('teams', n)).toBe('https://teams.microsoft.com/l/call/0/0?users=4:%2B12145550101');
    expect(buildLink('zoom_phone', n)).toBe('zoomphonecall://%2B12145550101');
    expect(buildLink('eight_by_eight', n)).toBe('tel:+12145550101');
    expect(buildLink('ringcentral', n)).toBe('tel:+12145550101');
    expect(buildLink('tel', n)).toBe('tel:+12145550101');
    expect(buildLink('callto', n)).toBe('callto:+12145550101');
    expect(buildLink('custom', n, { urlTemplate: 'https://dialer.example.com/call?to={number}&d={digits}' })).toBe('https://dialer.example.com/call?to=%2B12145550101&d=2145550101');
    expect(buildLink('sip', n, { urlTemplate: 'sip:{number}@pbx.example.com' })).toBe('sip:%2B12145550101@pbx.example.com');
  });

  it('rejects unsafe or incomplete templates', () => {
    expect(() => validateTemplate('javascript:alert({number})')).toThrow();
    expect(() => validateTemplate('http://insecure.example.com/{number}')).toThrow();
    expect(() => validateTemplate('https://example.com/call')).toThrow(/number/);
    expect(validateTemplate('https://example.com/{digits}')).toBe('https://example.com/{digits}');
  });

  it('computes and verifies Twilio signatures', () => {
    const url = 'https://app.example.com/api/telephony/twilio/status/abc';
    const params = { CallSid: 'CA1', CallStatus: 'ringing', From: '+1555' };
    const sig = computeSignature(TOKEN, url, params);
    expect(verifySignature(TOKEN, url, params, sig)).toBe(true);
    expect(verifySignature(TOKEN, url, { ...params, CallStatus: 'completed' }, sig)).toBe(false);
    expect(verifySignature('other-token', url, params, sig)).toBe(false);
    expect(verifySignature(TOKEN, url, params, undefined)).toBe(false);
  });
});

describe('calling settings', () => {
  it('stores provider settings and never returns the Twilio token', async () => {
    const { agent: a } = await registerUser();
    const def = await a.get('/api/telephony/settings');
    expect(def.body.settings.provider).toBe('tel');

    const bad = await a.put('/api/telephony/settings').send({ provider: 'custom', urlTemplate: 'javascript:x({number})' });
    expect(bad.status).toBe(400);
    const incomplete = await a.put('/api/telephony/settings').send({ provider: 'twilio', twilioAccountSid: SID });
    expect(incomplete.status).toBe(400);

    const ok = await a.put('/api/telephony/settings').send({ provider: 'twilio', twilioAccountSid: SID, twilioAuthToken: TOKEN, callerId: '214-555-0000', myNumber: '(972) 555-1111', enforceCallingHours: false });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ provider: 'twilio', callerId: '+12145550000', myNumber: '+19725551111', twilioAuthTokenSet: true, enforceCallingHours: false });
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN);
    const row = await prisma.callSettings.findFirst({ where: { twilioAccountSid: SID }, orderBy: { updatedAt: 'desc' } });
    expect(row.twilioAuthTokenEnc).not.toContain(TOKEN);

    // Empty token on a later save keeps the stored one.
    const keep = await a.put('/api/telephony/settings').send({ provider: 'twilio', twilioAccountSid: SID, twilioAuthToken: '', callerId: '+12145550000', myNumber: '+19725551111' });
    expect(keep.body.settings.twilioAuthTokenSet).toBe(true);
  });

  it('tests Twilio credentials against the real account endpoint (mocked)', async () => {
    const { agent: a } = await registerUser();
    await a.put('/api/telephony/settings').send({ provider: 'twilio', twilioAccountSid: SID, twilioAuthToken: TOKEN, callerId: '+12145550000', myNumber: '+19725551111' });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'active', friendly_name: 'Fleet Co' }), { status: 200 }));
    const res = await a.post('/api/telephony/settings/test');
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('Fleet Co');
    expect(spy.mock.calls[0][0]).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
    expect(spy.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
  });

  it('lists the provider catalog', async () => {
    const { agent: a } = await registerUser();
    const res = await a.get('/api/telephony/providers');
    const keys = res.body.items.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['tel', 'google_voice', 'eight_by_eight', 'teams', 'zoom_phone', 'custom', 'twilio']));
  });
});

describe('dialing (link providers)', () => {
  it('returns a provider link and records the attempt', async () => {
    setNow(() => BUSINESS_HOURS);
    const { agent: a } = await registerUser();
    await a.put('/api/telephony/settings').send({ provider: 'google_voice' });
    const c = await makeCarrier(a);
    const res = await a.post('/api/telephony/dial').send({ carrierId: c.id });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('link');
    expect(res.body.url).toMatch(/^https:\/\/voice\.google\.com\/u\/0\/calls\?a=nc,%2B1214555/);
    expect(res.body.openInNewTab).toBe(true);
    expect(res.body.attempt).toMatchObject({ status: 'dialed', provider: 'google_voice' });
    expect(res.body.attempt.carrier.id).toBe(c.id);
  });

  it('blocks do-not-call carriers even with force', async () => {
    setNow(() => BUSINESS_HOURS);
    const { agent: a } = await registerUser();
    const c = await makeCarrier(a);
    await a.patch(`/api/carriers/${c.id}`).send({ doNotCall: true });
    const res = await a.post('/api/telephony/dial').send({ carrierId: c.id, force: true });
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe('dnc');
  });

  it('enforces calling hours unless the user explicitly overrides', async () => {
    setNow(() => NIGHT);
    const { agent: a } = await registerUser();
    const c = await makeCarrier(a);
    const blocked = await a.post('/api/telephony/dial').send({ carrierId: c.id });
    expect(blocked.status).toBe(422);
    expect(blocked.body.details.code).toBe('outside_hours');
    const forced = await a.post('/api/telephony/dial').send({ carrierId: c.id, force: true });
    expect(forced.status).toBe(201);
    await a.put('/api/telephony/settings').send({ provider: 'tel', enforceCallingHours: false });
    expect((await a.post('/api/telephony/dial').send({ carrierId: c.id })).status).toBe(201);
  });

  it('matches a phone-only dial to the user’s own carrier', async () => {
    setNow(() => BUSINESS_HOURS);
    const { agent: a } = await registerUser();
    const c = await makeCarrier(a);
    const res = await a.post('/api/telephony/dial').send({ phone: `+1 ${c.phone}` });
    expect(res.status).toBe(201);
    expect(res.body.attempt.carrier.id).toBe(c.id);
    const unknown = await a.post('/api/telephony/dial').send({ phone: '+1 (999) 555-0000' });
    expect(unknown.status).toBe(201);
    expect(unknown.body.attempt.carrier).toBeNull();
    expect((await a.post('/api/telephony/dial').send({ phone: '12' })).status).toBe(422);
  });

  it('links a logged call to its attempt and fills provider', async () => {
    setNow(() => BUSINESS_HOURS);
    const { agent: a } = await registerUser();
    await a.put('/api/telephony/settings').send({ provider: 'teams' });
    const c = await makeCarrier(a);
    const d = await a.post('/api/telephony/dial').send({ carrierId: c.id });
    const log = await a.post('/api/calls').send({ carrierId: c.id, outcome: 'voicemail', attemptId: d.body.attempt.id, durationSec: 42 });
    expect(log.status).toBe(201);
    expect(log.body.call).toMatchObject({ provider: 'teams', durationSec: 42 });
    const att = await a.get(`/api/telephony/attempts/${d.body.attempt.id}`);
    expect(att.body.attempt.callId).toBe(log.body.call.id);
    const again = await a.post('/api/calls').send({ carrierId: c.id, outcome: 'voicemail', attemptId: d.body.attempt.id });
    expect(again.status).toBe(400);
  });

  it('keeps carriers and attempts isolated between users', async () => {
    setNow(() => BUSINESS_HOURS);
    const { agent: a } = await registerUser();
    const { agent: b } = await registerUser();
    const c = await makeCarrier(a);
    const d = await a.post('/api/telephony/dial').send({ carrierId: c.id });
    expect((await b.post('/api/telephony/dial').send({ carrierId: c.id })).status).toBe(404);
    expect((await b.get(`/api/telephony/attempts/${d.body.attempt.id}`)).status).toBe(404);
    expect((await b.post(`/api/telephony/attempts/${d.body.attempt.id}/cancel`)).status).toBe(404);
    // Phone-only dial by B must not match A's carrier.
    const other = await b.post('/api/telephony/dial').send({ phone: c.phone });
    expect(other.body.attempt.carrier).toBeNull();
    expect((await b.post('/api/calls').send({ carrierId: c.id, outcome: 'busy', attemptId: d.body.attempt.id })).status).toBe(404);
  });

  it('requires a session', async () => {
    const anon = await agent();
    expect((await anon.post('/api/telephony/dial').send({ phone: '+12145550101' })).status).toBe(401);
    expect((await anon.get('/api/telephony/settings')).status).toBe(401);
  });
});

describe('Twilio bridge', () => {
  let user;
  let carrier;
  beforeAll(async () => {
    user = await registerUser();
    await user.agent.put('/api/telephony/settings').send({ provider: 'twilio', twilioAccountSid: SID, twilioAuthToken: TOKEN, callerId: '+12145550000', myNumber: '+19725551111', enforceCallingHours: false });
    carrier = await makeCarrier(user.agent, { companyName: 'Bridge & Haul LLC' });
  });

  async function bridgeDial() {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sid: `CA${Math.random().toString(16).slice(2).padEnd(32, '0')}`, status: 'queued' }), { status: 201 }));
    const res = await user.agent.post('/api/telephony/dial').send({ carrierId: carrier.id });
    return { res, spy };
  }

  function signedPost(path, params, token = TOKEN) {
    const url = `${config.appUrl}${path}`;
    return user.agent.raw.post(path).type('form').set('X-Twilio-Signature', computeSignature(token, url, params)).send(params);
  }

  it('rings the dispatcher first, then dials the carrier via TwiML', async () => {
    const { res, spy } = await bridgeDial();
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('bridge');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    const form = new URLSearchParams(init.body);
    expect(form.get('To')).toBe('+19725551111');
    expect(form.get('From')).toBe('+12145550000');
    expect(form.get('Twiml')).toContain(`<Dial callerId="+12145550000" action="${config.appUrl}/api/telephony/twilio/dial-result/${res.body.attempt.id}"`);
    expect(form.get('Twiml')).toContain('Bridge &amp; Haul LLC');
    expect(form.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
  });

  it('rejects webhooks with a bad signature', async () => {
    const { res } = await bridgeDial();
    const path = `/api/telephony/twilio/status/${res.body.attempt.id}`;
    const bad = await user.agent.raw.post(path).type('form').set('X-Twilio-Signature', 'nope').send({ CallStatus: 'ringing' });
    expect(bad.status).toBe(403);
    const wrongToken = await signedPost(path, { CallStatus: 'ringing' }, 'not-the-token');
    expect(wrongToken.status).toBe(403);
  });

  it('tracks status, then records an answered call duration without auto-logging', async () => {
    const { res } = await bridgeDial();
    const id = res.body.attempt.id;
    const att = await prisma.callAttempt.findUnique({ where: { id } });
    expect((await signedPost(`/api/telephony/twilio/status/${id}`, { CallSid: att.providerCallId, CallStatus: 'ringing' })).status).toBe(200);
    expect((await user.agent.get(`/api/telephony/attempts/${id}`)).body.attempt.status).toBe('ringing');
    const done = await signedPost(`/api/telephony/twilio/dial-result/${id}`, { CallSid: att.providerCallId, DialCallStatus: 'completed', DialCallDuration: '95' });
    expect(done.status).toBe(200);
    expect(done.text).toBe('<Response/>');
    const after = (await user.agent.get(`/api/telephony/attempts/${id}`)).body.attempt;
    expect(after).toMatchObject({ status: 'completed', durationSec: 95, callId: null });
    // The user then logs the outcome; duration comes from the phone system.
    const log = await user.agent.post('/api/calls').send({ carrierId: carrier.id, outcome: 'interested', attemptId: id });
    expect(log.body.call).toMatchObject({ durationSec: 95, provider: 'twilio' });
  });

  it('auto-logs unanswered calls and schedules a follow-up', async () => {
    const { res } = await bridgeDial();
    const id = res.body.attempt.id;
    const att = await prisma.callAttempt.findUnique({ where: { id } });
    const before = await prisma.call.count({ where: { carrierId: carrier.id } });
    await signedPost(`/api/telephony/twilio/dial-result/${id}`, { CallSid: att.providerCallId, DialCallStatus: 'no-answer', DialCallDuration: '0' });
    const after = await prisma.callAttempt.findUnique({ where: { id } });
    expect(after.status).toBe('no_answer');
    expect(after.callId).toBeTruthy();
    const call = await prisma.call.findUnique({ where: { id: after.callId } });
    expect(call.outcome).toBe('no_answer');
    expect(await prisma.call.count({ where: { carrierId: carrier.id } })).toBe(before + 1);
    expect(await prisma.followUp.count({ where: { carrierId: carrier.id, status: 'pending' } })).toBeGreaterThan(0);
    // A replayed callback does not log twice.
    await signedPost(`/api/telephony/twilio/dial-result/${id}`, { CallSid: att.providerCallId, DialCallStatus: 'no-answer' });
    expect(await prisma.call.count({ where: { carrierId: carrier.id } })).toBe(before + 1);
  });

  it('marks the attempt failed when the dispatcher does not answer their own phone', async () => {
    const { res } = await bridgeDial();
    const id = res.body.attempt.id;
    const att = await prisma.callAttempt.findUnique({ where: { id } });
    await signedPost(`/api/telephony/twilio/status/${id}`, { CallSid: att.providerCallId, CallStatus: 'no-answer' });
    const after = (await user.agent.get(`/api/telephony/attempts/${id}`)).body.attempt;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/your phone/i);
  });

  it('reports Twilio API errors honestly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'The From phone number is not a valid, SMS- or voice-capable inbound phone number' }), { status: 400 }));
    const res = await user.agent.post('/api/telephony/dial').send({ carrierId: carrier.id });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/From phone number/);
    const last = await prisma.callAttempt.findFirst({ where: { userId: user.user.id }, orderBy: { createdAt: 'desc' } });
    expect(last.status).toBe('failed');
  });

  it('cancels a ringing bridge call through Twilio', async () => {
    const { res } = await bridgeDial();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'canceled' }), { status: 200 }));
    const c = await user.agent.post(`/api/telephony/attempts/${res.body.attempt.id}/cancel`);
    expect(c.body.attempt.status).toBe('canceled');
    const [url, init] = spy.mock.calls.at(-1);
    expect(url).toMatch(/\/Calls\/CA[0-9a-f]+\.json$/);
    expect(new URLSearchParams(init.body).get('Status')).toBe('canceled');
  });
});
