import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { sha256, randomToken } from '../src/lib/crypto.js';
import {
  consentText, consentParts, normalizePhone, formatPhone, activeConsent, recordConsent, revokeConsent, revokeForPhone, listForCarrier, consentSummary,
} from '../src/services/consent/index.js';
import { proofHtml } from '../src/services/consent/proof.js';

const pub = () => request(app);
const tokenOf = (link) => link.split('/onboard/')[1];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

describe('consent wording and helpers', () => {
  it('names the company, the phone, automated and AI voice, not-a-condition and STOP', () => {
    const text = consentText({ dispatcherName: 'Lena Park', dispatcherCompany: 'Park Dispatch LLC', phone: '214-555-0188' });
    expect(text).toMatch(/^I agree that Park Dispatch LLC may call and text me at \(214\) 555-0188, /);
    expect(text).toContain('automated technology');
    expect(text).toContain('artificial, AI-generated or prerecorded voice');
    expect(text).toContain('available loads, dispatch updates and my account');
    expect(text).toContain('not a condition of buying or using their services');
    expect(text).toContain('Message and data rates may apply');
    expect(text).toContain('replying STOP');
    expect(text).toContain('in any reasonable way');
    // Without a company the dispatcher's own name is used.
    expect(consentText({ dispatcherName: 'Lena Park', phone: '2145550188' })).toMatch(/^I agree that Lena Park may call and text me/);
    // Parts rebuild the same sentence around the formatted number.
    const { before, after } = consentParts({ dispatcherName: 'Lena Park', dispatcherCompany: 'Park Dispatch LLC' });
    expect(`${before}(214) 555-0188${after}`).toBe(text);
  });

  it('fits the wording to the channels', () => {
    const voice = consentText({ dispatcherCompany: 'Park Dispatch LLC', phone: '2145550188', channels: ['voice'] });
    expect(voice).toContain('may call me at');
    expect(voice).not.toContain('STOP');
    expect(voice).not.toContain('Message and data rates');
    expect(voice).toContain('not a condition');
    const sms = consentText({ dispatcherCompany: 'Park Dispatch LLC', phone: '2145550188', channels: ['sms'] });
    expect(sms).toContain('may text me at');
    expect(sms).toContain('STOP');
    expect(sms).not.toContain('prerecorded voice');
  });

  it('accepts only valid 10-digit US numbers', () => {
    expect(normalizePhone('(214) 555-0188')).toBe('2145550188');
    expect(normalizePhone('+1 214 555 0188')).toBe('2145550188');
    expect(normalizePhone('12145550188')).toBe('2145550188');
    for (const bad of ['', null, '555-0188', '0145550188', '2140550188', '22145550188', '214555018', 'abc', '+44 20 7946 0958']) expect(normalizePhone(bad), String(bad)).toBeNull();
    expect(formatPhone('2145550188')).toBe('(214) 555-0188');
  });

  it('escapes every value in the proof HTML', () => {
    const consent = {
      id: 'c1', phone: '2145550188', channels: 'sms,voice', consentText: 'I agree <script>alert(1)</script>', consentHash: sha256('I agree <script>alert(1)</script>'),
      source: 'manual', grantedAt: new Date(), grantedByName: '<img src=x onerror=alert(2)>', ip: '1.2.3.4"><b>', userAgent: '<svg onload=alert(3)>',
      note: 'Paper form <b>signed</b> & scanned', revokedAt: new Date(), revokeReason: '"><script>alert(4)</script>', createdAt: new Date(), proofDocumentId: null,
    };
    const html = proofHtml({ consent, carrier: { companyName: 'Cedar <i>Creek</i>' }, recordedBy: '<u>Lena</u>', revokedBy: 'O\'Brien <x>' });
    for (const raw of ['<script>', '<img', '<svg', '<b>', '<i>', '<u>', '<x>', '1.2.3.4"']) expect(html).not.toContain(raw);
    expect(html).toContain('I agree &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Paper form &lt;b&gt;signed&lt;/b&gt; &amp; scanned');
    expect(html).toContain('Matches the stored hash');
    expect(html).toContain('(214) 555-0188');
    expect(html).toContain('SMS + voice');
    const tampered = proofHtml({ consent: { ...consent, consentText: 'I agree to something else' }, carrier: { companyName: 'X' } });
    expect(tampered).toContain('Does not match the stored hash');
  });
});

describe('contact consents', () => {
  let A; let B; let carrier; let other; let bCarrier;
  beforeAll(async () => {
    A = await registerUser({ name: 'Lena Park' });
    B = await registerUser({ name: 'Other Dispatcher' });
    await prisma.user.update({ where: { id: A.user.id }, data: { companyName: 'Park Dispatch LLC' } });
    carrier = (await A.agent.post('/api/carriers').send({ companyName: 'Cedar Creek Carriers', mcNumber: '223456', dotNumber: '8654321', email: 'owner@cedar.test', phone: '(214) 555-0188', state: 'TX' })).body.carrier;
    other = (await A.agent.post('/api/carriers').send({ companyName: 'Other Lane Freight', state: 'OK' })).body.carrier;
    bCarrier = (await B.agent.post('/api/carriers').send({ companyName: 'B Freight', state: 'KS' })).body.carrier;
  });

  describe('onboarding link', () => {
    const createLink = (body = {}) => A.agent.post('/api/onboarding-links').send({ carrierId: carrier.id, feePercent: 7, requestedDocs: [], ...body });
    const signBody = (page, extra = {}) => ({
      signerName: 'Maria Lopez', signerTitle: 'Owner', signerEmail: 'maria@cedar.test', signatureType: 'typed', signatureData: 'Maria Lopez',
      agreementHash: page.agreement.hash, agree: true, ...extra,
    });
    async function openLink(body) {
      const res = await createLink(body);
      expect(res.status).toBe(201);
      const token = tokenOf(res.body.link);
      const page = (await pub().get(`/api/public/onboarding/${token}`)).body;
      expect((await pub().post(`/api/public/onboarding/${token}/consent`).send({ agree: true })).status).toBe(200);
      return { token, page, id: res.body.onboardingLink.id, created: res.body };
    }
    const consentFor = (page, phone = '2145550188') => ({ agree: true, phone, text: `${page.contactConsent.before}${formatPhone(normalizePhone(phone))}${page.contactConsent.after}` });

    it('the option is stored on the link and shows the wording with the carrier phone prefilled', async () => {
      const { page, id, created } = await openLink({ askContactConsent: true });
      expect(created.onboardingLink.askContactConsent).toBe(true);
      expect(created.onboardingLink.requestedDocs).toEqual([]);
      expect(page.requestedDocs).toEqual([]);
      expect(page.contactConsent).toMatchObject({ asked: true, phone: '2145550188' });
      expect(page.contactConsent.before).toBe('I agree that Park Dispatch LLC may call and text me at ');
      expect(page.contactConsent.after).toContain('not a condition');
      const row = await prisma.onboardingLink.findUnique({ where: { id } });
      expect(row.requestedDocs).toBe('contact_consent');
      // Without the option (or from an older client) the page has no consent block.
      const plain = await openLink({});
      expect(plain.page.contactConsent).toBeUndefined();
      expect(plain.created.onboardingLink.askContactConsent).toBe(false);
    });

    it('signing works without the box and records no consent; the record says declined', async () => {
      const { token, page, id } = await openLink({ askContactConsent: true, requestedDocs: ['w9'] });
      const res = await pub().post(`/api/public/onboarding/${token}/sign`).send(signBody(page));
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('signed');
      expect(res.body.contactConsent).toEqual({ asked: true, given: null });
      expect(await prisma.contactConsent.count({ where: { onboardingLinkId: id } })).toBe(0);
      const html = (await A.agent.get(`/api/onboarding-links/${id}/record`)).text;
      expect(html).toContain('Consent to calls and texts');
      expect(html).toContain('Declined.');
      // A link that did not ask has no consent section.
      const plain = await openLink({});
      await pub().post(`/api/public/onboarding/${plain.token}/sign`).send(signBody(plain.page));
      expect((await A.agent.get(`/api/onboarding-links/${plain.id}/record`)).text).not.toContain('Consent to calls and texts');
    });

    it('rejects an invalid phone, changed wording and consent on a link that did not ask, without signing', async () => {
      const { token, page, id } = await openLink({ askContactConsent: true });
      const bad = await pub().post(`/api/public/onboarding/${token}/sign`).send(signBody(page, { contactConsent: { ...consentFor(page), phone: '555-0188' } }));
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/10-digit US phone/);
      const changed = await pub().post(`/api/public/onboarding/${token}/sign`).send(signBody(page, { contactConsent: { ...consentFor(page), text: 'I agree to anything' } }));
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('CONSENT_TEXT_CHANGED');
      const wrongNumber = await pub().post(`/api/public/onboarding/${token}/sign`).send(signBody(page, { contactConsent: { ...consentFor(page, '2145550199'), phone: '2145550188' } }));
      expect(wrongNumber.status).toBe(409);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(signBody(page, { contactConsent: { ...consentFor(page), agree: false } }))).status).toBe(400);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(signBody(page, { contactConsent: { ...consentFor(page), extra: 1 } }))).status).toBe(400);
      expect((await prisma.onboardingLink.findUnique({ where: { id } })).status).toBe('pending');
      expect(await prisma.contactConsent.count({ where: { onboardingLinkId: id } })).toBe(0);

      const plain = await openLink({});
      const notAsked = await pub().post(`/api/public/onboarding/${plain.token}/sign`).send(signBody(plain.page, { contactConsent: consentFor(page) }));
      expect(notAsked.status).toBe(400);
      expect((await prisma.onboardingLink.findUnique({ where: { id: plain.id } })).status).toBe('pending');
    });

    it('stores the exact text, hash, phone, IP, browser and signer when the box is ticked', async () => {
      const { token, page, id } = await openLink({ askContactConsent: true });
      const consent = consentFor(page, '+1 (972) 555-0123');
      const res = await pub().post(`/api/public/onboarding/${token}/sign`).set('User-Agent', UA).send(signBody(page, { contactConsent: consent }));
      expect(res.status).toBe(200);
      expect(res.body.contactConsent).toMatchObject({ asked: true, given: { phone: '(972) 555-0123', revoked: false } });
      const rows = await prisma.contactConsent.findMany({ where: { onboardingLinkId: id } });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toMatchObject({
        ownerId: A.user.id, carrierId: carrier.id, phone: '9725550123', channels: 'sms,voice', source: 'onboarding', grantedByName: 'Maria Lopez',
        userAgent: UA, consentText: consent.text, revokedAt: null,
      });
      expect(row.consentText).toContain('(972) 555-0123');
      expect(row.consentHash).toBe(sha256(row.consentText));
      expect(row.ip).toBeTruthy();
      const link = await prisma.onboardingLink.findUnique({ where: { id } });
      expect(row.grantedAt).toEqual(link.signedAt);
      expect(await prisma.activity.findFirst({ where: { carrierId: carrier.id, type: 'consent', summary: { contains: 'Maria Lopez agreed to automated calls and texts' } } })).toBeTruthy();

      const html = (await A.agent.get(`/api/onboarding-links/${id}/record`)).text;
      expect(html).toContain('Given. The signer ticked the optional box');
      expect(html).toContain('(972) 555-0123');
      expect(html).toContain(row.consentHash);
      expect(html).toContain('Agreed to automated calls and texts at (972) 555-0123');

      // The dispatcher's consent history shows it, active.
      const list = await A.agent.get(`/api/contact-consents?carrierId=${carrier.id}`);
      expect(list.status).toBe(200);
      expect(list.body.items[0]).toMatchObject({ id: row.id, source: 'onboarding', active: true, channels: ['sms', 'voice'], phoneDisplay: '(972) 555-0123' });
      expect(list.body.summary).toMatchObject({ status: 'consented', channels: ['sms', 'voice'] });
      expect(await activeConsent(carrier.id, { phone: '972-555-0123', channel: 'voice' })).toMatchObject({ id: row.id });
    });
  });

  describe('dispatcher API', () => {
    let doc; let otherDoc;
    beforeAll(async () => {
      const mk = (carrierId, name) => prisma.document.create({ data: { ownerId: A.user.id, uploadedById: A.user.id, carrierId, type: 'other', originalName: name, storedName: `consent-${randomToken(8)}.pdf`, mimeType: 'application/pdf', sizeBytes: 10 } });
      doc = await mk(carrier.id, 'Signed consent form.pdf');
      otherDoc = await mk(other.id, 'Other carrier form.pdf');
    });
    const post = (body, who = A) => who.agent.post('/api/contact-consents').send({ carrierId: carrier.id, phone: '(469) 555-0142', channels: ['sms', 'voice'], note: 'Paper consent form signed at the truck stop', ...body });

    it('manual consent needs a note, a valid phone and a channel', async () => {
      expect((await post({ note: undefined })).status).toBe(400);
      const short = await post({ note: '  ' });
      expect(short.status).toBe(400);
      expect(short.body.error).toMatch(/how the person gave consent/);
      expect((await post({ phone: '12345' })).status).toBe(400);
      expect((await post({ channels: [] })).status).toBe(400);
      expect((await post({ channels: ['fax'] })).status).toBe(400);
      expect((await post({ grantedAt: new Date(Date.now() + 86400000).toISOString() })).status).toBe(400);
      expect((await post({ ownerId: B.user.id })).status).toBe(400);
    });

    it('the proof document must belong to the carrier', async () => {
      const wrong = await post({ proofDocumentId: otherDoc.id });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatch(/this carrier's documents/);
      expect((await post({ proofDocumentId: 'nope' })).status).toBe(400);
      const ok = await post({ proofDocumentId: doc.id, grantedByName: 'Maria Lopez', channels: ['voice', 'sms'] });
      expect(ok.status).toBe(201);
      expect(ok.body.item).toMatchObject({ source: 'manual', phone: '4695550142', channels: ['sms', 'voice'], note: 'Paper consent form signed at the truck stop', proofDocument: { id: doc.id, originalName: 'Signed consent form.pdf' }, active: true, ip: null });
      const row = await prisma.contactConsent.findUnique({ where: { id: ok.body.item.id } });
      expect(row.consentText).toContain('Park Dispatch LLC may call and text me at (469) 555-0142');
      expect(row.consentHash).toBe(sha256(row.consentText));
      expect(row.ownerId).toBe(A.user.id);
    });

    it('previews the wording a manual record stores', async () => {
      const res = await A.agent.get('/api/contact-consents/wording?phone=4695550142&channels=sms');
      expect(res.status).toBe(200);
      expect(res.body.text).toBe(consentText({ dispatcherName: 'Lena Park', dispatcherCompany: 'Park Dispatch LLC', phone: '4695550142', channels: ['sms'] }));
      expect((await A.agent.get('/api/contact-consents/wording?phone=1')).body.text).toContain('[phone number]');
    });

    it('revokes; activeConsent ignores revoked records, other numbers and other channels', async () => {
      const smsOnly = (await post({ phone: '8175550111', channels: ['sms'] })).body.item;
      expect(await activeConsent(carrier.id, { phone: '817-555-0111', channel: 'sms' })).toMatchObject({ id: smsOnly.id });
      expect(await activeConsent(carrier.id, { phone: '817-555-0111' })).toMatchObject({ id: smsOnly.id });
      expect(await activeConsent(carrier.id, { phone: '817-555-0111', channel: 'voice' })).toBeNull();
      expect(await activeConsent(carrier.id, { phone: '817-555-0112', channel: 'sms' })).toBeNull();
      expect(await activeConsent(carrier.id, { phone: 'not a phone' })).toBeNull();
      expect(await activeConsent(carrier.id, {})).toBeNull();
      expect(await activeConsent(other.id, { phone: '8175550111' })).toBeNull();
      expect(await activeConsent(carrier.id, { phone: '8175550111', channel: 'email' })).toBeNull();

      const res = await A.agent.post(`/api/contact-consents/${smsOnly.id}/revoke`).send({ reason: 'Said "stop texting me" on a call' });
      expect(res.status).toBe(200);
      expect(res.body.item).toMatchObject({ active: false, revokeReason: 'Said "stop texting me" on a call' });
      expect(res.body.item.revokedAt).toBeTruthy();
      expect(await activeConsent(carrier.id, { phone: '8175550111', channel: 'sms' })).toBeNull();
      // Revoking twice keeps the first revocation.
      const again = await A.agent.post(`/api/contact-consents/${smsOnly.id}/revoke`).send({ reason: 'later' });
      expect(again.status).toBe(200);
      expect(again.body.item.revokeReason).toBe('Said "stop texting me" on a call');
      expect(await prisma.activity.count({ where: { carrierId: carrier.id, type: 'consent', summary: { contains: 'revoked' } } })).toBe(1);

      const list = await A.agent.get(`/api/contact-consents?carrierId=${carrier.id}`);
      const order = list.body.items.map((x) => x.active);
      expect(order.indexOf(false)).toBeGreaterThan(order.lastIndexOf(true)); // active first
    });

    it('service helpers: revokeForPhone, list order and summary', async () => {
      const c3 = (await A.agent.post('/api/carriers').send({ companyName: 'Helper Freight', state: 'TX' })).body.carrier;
      expect(consentSummary(await listForCarrier(c3.id))).toMatchObject({ status: 'none' });
      const base = { ownerId: A.user.id, carrierId: c3.id, source: 'manual', note: 'test' };
      const a1 = await recordConsent({ ...base, phone: '2145550100', consentText: consentText({ dispatcherCompany: 'X', phone: '2145550100' }) });
      await expect(recordConsent({ ...base, phone: '123', consentText: 'x' })).rejects.toThrow(/10-digit/);
      expect(consentSummary(await listForCarrier(c3.id))).toMatchObject({ status: 'consented', channels: ['sms', 'voice'], phones: ['2145550100'] });
      expect(await revokeForPhone(c3.id, '(214) 555-0100', { reason: 'Replied STOP' })).toBe(1);
      expect((await prisma.contactConsent.findUnique({ where: { id: a1.id } })).revokeReason).toBe('Replied STOP');
      expect(consentSummary(await listForCarrier(c3.id))).toMatchObject({ status: 'revoked' });
      expect(await revokeConsent({ id: 'missing' })).toBeNull();
    });

    it('prints an escaped proof with who recorded it', async () => {
      const made = await post({ grantedByName: 'Maria <script>alert(1)</script>', note: 'Recorded call <b>#42</b>', proofDocumentId: doc.id });
      expect(made.status).toBe(201);
      await A.agent.post(`/api/contact-consents/${made.body.item.id}/revoke`).send({ reason: '<img src=x onerror=alert(2)>' });
      const res = await A.agent.get(`/api/contact-consents/${made.body.item.id}/proof`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-disposition']).toMatch(/^inline; filename="call-text-consent-cedar-creek-carriers\.html"/);
      const html = res.text;
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<b>#42</b>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('Maria &lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('Recorded call &lt;b&gt;#42&lt;/b&gt;');
      expect(html).toContain('Signed consent form.pdf');
      expect(html).toContain('Recorded by</th><td>Lena Park');
      expect(html).toContain('(469) 555-0142');
      expect(html).toContain('Matches the stored hash');
      expect(html).toMatch(/Revoked<\/th><td>\d{4}-\d{2}-\d{2}/);
    });

    it('keeps consents private to the owner (404 for others)', async () => {
      const mine = (await post({})).body.item;
      expect((await B.agent.get(`/api/contact-consents?carrierId=${carrier.id}`)).status).toBe(404);
      expect((await post({}, B)).status).toBe(404);
      expect((await B.agent.post(`/api/contact-consents/${mine.id}/revoke`).send({})).status).toBe(404);
      expect((await B.agent.get(`/api/contact-consents/${mine.id}/proof`)).status).toBe(404);
      expect((await prisma.contactConsent.findUnique({ where: { id: mine.id } })).revokedAt).toBeNull();
      // B's own carrier cannot take A's document as proof.
      const cross = await B.agent.post('/api/contact-consents').send({ carrierId: bCarrier.id, phone: '2145550188', channels: ['sms'], note: 'Paper form on file', proofDocumentId: doc.id });
      expect(cross.status).toBe(400);
      expect((await B.agent.get(`/api/contact-consents?carrierId=${bCarrier.id}`)).body.items).toEqual([]);
    });

    it('consents are removed with the account', async () => {
      const C = await registerUser({ name: 'Leaving Dispatcher' });
      const cc = (await C.agent.post('/api/carriers').send({ companyName: 'Leaving Freight', state: 'TX' })).body.carrier;
      const made = await C.agent.post('/api/contact-consents').send({ carrierId: cc.id, phone: '2145550177', channels: ['sms'], note: 'Paper form on file' });
      expect(made.status).toBe(201);
      const del = await C.agent.delete('/api/settings/account').send({ password: C.password, confirm: 'DELETE' });
      expect(del.status).toBe(200);
      expect(await prisma.contactConsent.count({ where: { OR: [{ ownerId: C.user.id }, { id: made.body.item.id }] } })).toBe(0);
    });

    it('API tokens can read but not record or revoke', async () => {
      const { body } = await A.agent.post('/api/tokens').send({ name: 'ext', expiresInDays: 30 });
      const bearer = { Authorization: `Bearer ${body.token}` };
      const mine = (await post({})).body.item;
      expect((await request(app).get(`/api/contact-consents?carrierId=${carrier.id}`).set(bearer)).status).toBe(200);
      expect((await request(app).post('/api/contact-consents').set(bearer).send({ carrierId: carrier.id, phone: '2145550188', channels: ['sms'], note: 'Paper form on file' })).status).toBe(403);
      expect((await request(app).post(`/api/contact-consents/${mine.id}/revoke`).set(bearer).send({})).status).toBe(403);
      expect((await prisma.contactConsent.findUnique({ where: { id: mine.id } })).revokedAt).toBeNull();
    });
  });
});
