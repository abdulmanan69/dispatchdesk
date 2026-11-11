import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { config } from '../src/config.js';
import { sha256, randomToken } from '../src/lib/crypto.js';
import { STORAGE_MB } from '../src/lib/plans.js';
import { DEFAULT_AGREEMENT, renderAgreement, unknownFields } from '../src/services/onboarding/agreement.js';
import { normalizeSignaturePath, normalizeTypedSignature, signatureSvg } from '../src/services/onboarding/signature.js';
import { MAX_FILES_PER_LINK } from '../src/services/onboarding/links.js';

const pub = () => request(app);
const tokenOf = (link) => link.split('/onboard/')[1];
const MB = 1024 * 1024;
const PDF = (size = 1000) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size, 32), Buffer.from('\n%%EOF')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc4cd0b0000000049454e44ae426082', 'hex');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const SIG = 'M 10 50 L 40 80 Q 60 100 80 60 C 100 20 120 20 140 60 L 200 150';

async function signBody(page, extra = {}) {
  return {
    signerName: 'Maria Lopez', signerTitle: 'Owner', signerEmail: 'maria@cedar.test',
    signatureType: 'typed', signatureData: 'Maria Lopez', agreementHash: page.agreement.hash, agree: true, ...extra,
  };
}

describe('agreement and signature helpers', () => {
  it('renders merge fields once and lists unknown fields', () => {
    const out = renderAgreement('{{carrier_company}} pays {{fee_percent}}% {{nope}}', { carrier_company: '{{fee_percent}} Inc', fee_percent: '8' });
    expect(out).toBe('{{fee_percent}} Inc pays 8% {{nope}}');
    expect(unknownFields('{{ carrier_company }} {{nope}} {{x y}}')).toEqual(['nope', 'x y']);
    expect(unknownFields(DEFAULT_AGREEMENT)).toEqual([]);
  });

  it('accepts only absolute M/L/Q/C/Z paths with numbers inside the box', () => {
    expect(normalizeSignaturePath('M10,20L30.25 40')).toBe('M 10 20 L 30.3 40');
    expect(normalizeSignaturePath(SIG)).toBe(SIG);
    expect(normalizeSignaturePath('M 1 1 L 2 2 Z')).toBe('M 1 1 L 2 2 Z');
    for (const bad of [
      '', 'L 1 1 L 2 2', 'M 1 1', 'M 1 1 L 2', 'M 1 1 A 1 1 0 0 1 2 2', 'M 1 1 l 2 2', 'M 1 1 L 2 2 Z 3 3',
      'M 1 1 L 700 2', 'M 1 1 L 2 300', 'M -1 1 L 2 2', 'M 1 1 L 2 2"/><script>alert(1)</script>', 'M 1e3 1 L 2 2', 'M 1 1 Q 1 1 1', `M 1 1 ${'L 2 2 '.repeat(4000)}`,
    ]) expect(normalizeSignaturePath(bad), bad.slice(0, 40)).toBeNull();
    expect(signatureSvg('M 1 1 L 2 2"><script>')).toBe('');
    expect(signatureSvg(SIG)).toContain(`d="${SIG}"`);
  });

  it('typed signatures are plain names', () => {
    expect(normalizeTypedSignature('  Maria   Lopez ')).toBe('Maria Lopez');
    expect(normalizeTypedSignature('<b>x</b>')).toBeNull();
    expect(normalizeTypedSignature('12')).toBeNull();
    expect(normalizeTypedSignature('a'.repeat(121))).toBeNull();
  });
});

describe('carrier onboarding links', () => {
  let A; let B; let carrier; let opp;
  beforeAll(async () => {
    A = await registerUser({ name: 'Lena Park' });
    B = await registerUser({ name: 'Other Dispatcher' });
    await prisma.user.update({ where: { id: A.user.id }, data: { companyName: 'Park Dispatch LLC' } });
    carrier = (await A.agent.post('/api/carriers').send({ companyName: 'Cedar Creek Carriers', mcNumber: '123456', dotNumber: '7654321', email: 'owner@cedar.test', phone: '2145550188', state: 'TX' })).body.carrier;
    opp = (await A.agent.post('/api/opportunities').send({ carrierId: carrier.id, dispatchFeePercent: 6 })).body.opportunity;
  });

  async function create(body = {}, who = A) {
    return who.agent.post('/api/onboarding-links').send({ carrierId: carrier.id, requestedDocs: ['w9', 'coi', 'noa'], ...body });
  }

  it('serves the default template with merge fields', async () => {
    const res = await A.agent.get('/api/onboarding-links/template');
    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.body).toBe(DEFAULT_AGREEMENT);
    expect(res.body.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['carrier_company', 'carrier_mc', 'carrier_dot', 'fee_percent', 'dispatcher_name', 'dispatcher_company', 'date']));
  });

  it('creates a link: renders the agreement, stores only the token hash, returns the message', async () => {
    const res = await create({ feePercent: 7.5 });
    expect(res.status).toBe(201);
    expect(res.body.link).toMatch(/^http:\/\/localhost:3999\/onboard\/[A-Za-z0-9_-]{43,}$/);
    const token = tokenOf(res.body.link);
    expect(res.body.message).toMatchObject({ subject: 'Dispatch agreement for Cedar Creek Carriers', toEmail: 'owner@cedar.test' });
    expect(res.body.message.text).toContain(res.body.link);
    expect(res.body.message.sms).toMatch(/^sms:\?&body=/);
    expect(res.body.onboardingLink).toMatchObject({ status: 'pending', feePercent: 7.5, requestedDocs: ['w9', 'coi', 'noa'] });
    expect(JSON.stringify(res.body.onboardingLink)).not.toContain('tokenHash');
    const row = await prisma.onboardingLink.findUnique({ where: { id: res.body.onboardingLink.id } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.agreementBody).toContain('Cedar Creek Carriers, MC 123456, USDOT 7654321');
    expect(row.agreementBody).toContain('7.5% of the gross line haul');
    expect(row.agreementBody).toContain('Park Dispatch LLC ("Dispatcher")');
    expect(row.agreementBody).toContain('Lena Park, for Park Dispatch LLC');
    expect(row.agreementBody).not.toMatch(/\{\{/);
    expect(row.agreementHash).toBe(sha256(row.agreementBody));
    expect(Math.round((new Date(row.expiresAt) - Date.now()) / 86400000)).toBe(14);
    // The default text was used unchanged, so nothing is saved as the user's template.
    expect((await prisma.user.findUnique({ where: { id: A.user.id } })).agreementTemplate).toBeNull();
  });

  it('uses the deal fee when none is entered, saves an edited template and refuses unknown fields', async () => {
    const custom = `${DEFAULT_AGREEMENT}\n\n12. Extra\nCarrier {{carrier_company}} agrees to weekly check-ins.`;
    const res = await create({ agreementBody: custom, agreementTitle: 'Our agreement', days: 30, requestedDocs: [] });
    expect(res.status).toBe(201);
    const row = await prisma.onboardingLink.findUnique({ where: { id: res.body.onboardingLink.id } });
    expect(row.feePercent).toBe(6);
    expect(row.agreementTitle).toBe('Our agreement');
    expect(row.agreementBody).toContain('Carrier Cedar Creek Carriers agrees to weekly check-ins.');
    expect((await prisma.user.findUnique({ where: { id: A.user.id } })).agreementTemplate).toBe(custom);
    expect((await A.agent.get('/api/onboarding-links/template')).body).toMatchObject({ isDefault: false, body: custom });

    const bad = await create({ agreementBody: `${DEFAULT_AGREEMENT} {{secret_field}}` });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('{{secret_field}}');
    expect((await create({ days: 31 })).status).toBe(400);
    expect((await create({ requestedDocs: ['passport'] })).status).toBe(400);
    expect((await create({ ownerId: B.user.id })).status).toBe(400);
  });

  it('requires a fee when the agreement uses {{fee_percent}} and none is known', async () => {
    const c2 = (await A.agent.post('/api/carriers').send({ companyName: 'No Fee Freight', state: 'OK' })).body.carrier;
    const res = await A.agent.post('/api/onboarding-links').send({ carrierId: c2.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fee/i);
  });

  it('keeps links private to the owner (404 for others)', async () => {
    const res = await create();
    const id = res.body.onboardingLink.id;
    expect((await create({}, B)).status).toBe(404);
    expect((await B.agent.get(`/api/onboarding-links?carrierId=${carrier.id}`)).status).toBe(404);
    expect((await B.agent.get(`/api/onboarding-links/${id}`)).status).toBe(404);
    expect((await B.agent.get(`/api/onboarding-links/${id}/record`)).status).toBe(404);
    expect((await B.agent.post(`/api/onboarding-links/${id}/revoke`)).status).toBe(404);
    const list = await A.agent.get(`/api/onboarding-links?carrierId=${carrier.id}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((l) => l.id)).toContain(id);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|agreementBody/);
  });

  it('allows at most 5 open links per carrier', async () => {
    const open = await prisma.onboardingLink.count({ where: { carrierId: carrier.id, status: 'pending' } });
    for (let i = open; i < 5; i += 1) expect((await create()).status).toBe(201);
    const res = await create();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 open onboarding links/);
    // Turn them all off so the next tests start clean.
    await prisma.onboardingLink.updateMany({ where: { carrierId: carrier.id, status: 'pending' }, data: { status: 'revoked', revokedAt: new Date() } });
  });

  describe('carrier page', () => {
    let token; let linkId; let page;
    beforeAll(async () => {
      const res = await create({ feePercent: 7 });
      token = tokenOf(res.body.link);
      linkId = res.body.onboardingLink.id;
    });

    it('shows only what the carrier needs and records the first view', async () => {
      const res = await pub().get(`/api/public/onboarding/${token}`);
      expect(res.status).toBe(200);
      page = res.body;
      expect(Object.keys(page).sort()).toEqual(['agreement', 'carrier', 'consentAt', 'dispatcher', 'expiresAt', 'feePercent', 'requestedDocs', 'signedAt', 'signerName', 'state', 'uploads'].sort());
      expect(page.state).toBe('pending');
      expect(page.carrier).toEqual({ companyName: 'Cedar Creek Carriers' });
      expect(page.dispatcher).toEqual({ name: 'Lena Park', company: 'Park Dispatch LLC' });
      expect(page.feePercent).toBe('7');
      expect(page.requestedDocs).toEqual([
        { kind: 'w9', label: 'W-9', uploaded: 0 }, { kind: 'coi', label: 'Certificate of insurance', uploaded: 0 }, { kind: 'noa', label: 'Notice of assignment (factoring)', uploaded: 0 },
      ]);
      const raw = JSON.stringify(page);
      for (const secret of [A.user.id, carrier.id, linkId, A.email, '2145550188', 'owner@cedar.test']) expect(raw).not.toContain(secret);
      const first = (await prisma.onboardingLink.findUnique({ where: { id: linkId } })).viewedAt;
      expect(first).toBeTruthy();
      await pub().get(`/api/public/onboarding/${token}`);
      expect((await prisma.onboardingLink.findUnique({ where: { id: linkId } })).viewedAt).toEqual(first);
      const list = await A.agent.get(`/api/onboarding-links?carrierId=${carrier.id}`);
      expect(list.body.items.find((l) => l.id === linkId).status).toBe('viewed');
    });

    it('unknown tokens are 404', async () => {
      expect((await pub().get(`/api/public/onboarding/${randomToken(32)}`)).status).toBe(404);
      expect((await pub().get('/api/public/onboarding/short')).status).toBe(404);
    });

    it('requires consent before signing', async () => {
      const res = await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONSENT_REQUIRED');
      expect((await pub().post(`/api/public/onboarding/${token}/consent`).send({})).status).toBe(400);
      const ok = await pub().post(`/api/public/onboarding/${token}/consent`).send({ agree: true });
      expect(ok.status).toBe(200);
      expect(ok.body.consentAt).toBeTruthy();
    });

    it('refuses a hash mismatch, bad signatures and missing agreement', async () => {
      const mismatch = await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { agreementHash: sha256('other text') }));
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.code).toBe('AGREEMENT_CHANGED');
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { agreementHash: 'abc' }))).status).toBe(400);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { agree: false }))).status).toBe(400);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { signatureType: 'drawn', signatureData: 'M 1 1 L 2 2"/><script>alert(1)</script>' }))).status).toBe(400);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { signatureType: 'drawn', signatureData: `M 1 1 ${'L 2 2 '.repeat(4000)}` }))).status).toBe(400);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { signatureType: 'typed', signatureData: '<img src=x>' }))).status).toBe(400);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { signerEmail: 'nope' }))).status).toBe(400);
      expect((await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page, { extra: 1 }))).status).toBe(400);
      expect((await prisma.onboardingLink.findUnique({ where: { id: linkId } })).status).toBe('pending');
    });

    it('signs once: stores the audit data, converts the carrier and notifies the dispatcher', async () => {
      const res = await pub().post(`/api/public/onboarding/${token}/sign`).set('User-Agent', UA)
        .send(await signBody(page, { signatureType: 'drawn', signatureData: SIG, signerName: 'Maria <b>Lopez</b>' }));
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('signed');
      expect(res.body.signerName).toBe('Maria <b>Lopez</b>');
      const row = await prisma.onboardingLink.findUnique({ where: { id: linkId } });
      expect(row).toMatchObject({ status: 'signed', signerTitle: 'Owner', signerEmail: 'maria@cedar.test', signatureData: `drawn:${SIG}`, signerUserAgent: UA });
      expect(row.signerIp).toBeTruthy();
      expect(row.signedAt).toBeTruthy();

      const again = await pub().post(`/api/public/onboarding/${token}/sign`).send(await signBody(page));
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ALREADY_SIGNED');

      const customer = await prisma.customer.findUnique({ where: { carrierId: carrier.id } });
      expect(customer).toMatchObject({ dispatchFeePercent: 7, status: 'active', ownerId: A.user.id });
      expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).isFleet).toBe(true);
      expect((await prisma.opportunity.findUnique({ where: { id: opp.id } })).status).toBe('won');
      expect(await prisma.notification.findFirst({ where: { userId: A.user.id, title: 'Cedar Creek Carriers signed the dispatch agreement' } })).toBeTruthy();
      expect(await prisma.activity.findFirst({ where: { carrierId: carrier.id, summary: { contains: 'signed the dispatch agreement' } } })).toBeTruthy();
      expect((await A.agent.post(`/api/onboarding-links/${linkId}/revoke`)).status).toBe(400);
    });

    it('takes requested documents: type, extension, contents, size and count are checked', async () => {
      const up = (type, buf, filename, contentType) => pub().post(`/api/public/onboarding/${token}/documents`).field('type', type).attach('file', buf, { filename, contentType });
      const w9 = await up('w9', PDF(), 'my w9.pdf', 'application/pdf');
      expect(w9.status).toBe(201);
      expect(w9.body.requestedDocs.find((d) => d.kind === 'w9').uploaded).toBe(1);
      const doc = await prisma.document.findUnique({ where: { id: w9.body.document.id } });
      expect(doc).toMatchObject({ ownerId: A.user.id, carrierId: carrier.id, type: 'w9', source: 'onboarding', mimeType: 'application/pdf', originalName: 'W-9 - Cedar Creek Carriers.pdf' });
      expect(doc.storedName.startsWith(`onb-${linkId}-w9-`)).toBe(true);
      expect(fs.existsSync(path.join(config.uploadDir, 'documents', doc.storedName))).toBe(true);
      // The dispatcher sees it like any carrier document.
      expect((await A.agent.get(`/api/documents/${doc.id}/download`)).status).toBe(200);

      const noa = await up('noa', PNG, 'noa.png', 'image/png');
      expect(noa.status).toBe(201);
      expect((await prisma.document.findUnique({ where: { id: noa.body.document.id } })).type).toBe('noa');
      expect((await up('coi', JPEG, 'coi.jpeg', 'image/jpeg')).status).toBe(201);

      expect((await up('mc_authority', PDF(), 'mc.pdf', 'application/pdf')).status).toBe(400); // not requested on this link
      expect((await up('passport', PDF(), 'p.pdf', 'application/pdf')).status).toBe(400);
      expect((await up('w9', Buffer.from('<html>not a pdf</html>'), 'w9.pdf', 'application/pdf')).status).toBe(400);
      expect((await up('w9', Buffer.from('RIFF0000WEBPVP8 '), 'w9.webp', 'image/webp')).status).toBe(400);
      expect((await up('w9', Buffer.from('MZ'), 'w9.exe', 'application/octet-stream')).status).toBe(400);
      const big = await up('w9', PDF(15 * MB + 10), 'big.pdf', 'application/pdf');
      expect(big.status).toBe(413);
      expect(await prisma.document.count({ where: { storedName: { startsWith: `onb-${linkId}-` } } })).toBe(3);

      // Per-link cap.
      const used = await prisma.document.count({ where: { storedName: { startsWith: `onb-${linkId}-` } } });
      await prisma.document.createMany({
        data: Array.from({ length: MAX_FILES_PER_LINK - used }, (_, i) => ({
          ownerId: A.user.id, uploadedById: A.user.id, carrierId: carrier.id, type: 'w9', originalName: `x${i}.pdf`, storedName: `onb-${linkId}-w9-cap-${Date.now()}-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, source: 'onboarding',
        })),
      });
      const capped = await up('w9', PDF(), 'w9.pdf', 'application/pdf');
      expect(capped.status).toBe(429);
      expect(capped.body.code).toBe('UPLOAD_CAP');
    });

    it('prints an escaped record with the signature, hash and audit trail', async () => {
      await prisma.carrier.update({ where: { id: carrier.id }, data: { companyName: 'Cedar <script>alert(1)</script> Carriers' } });
      const res = await A.agent.get(`/api/onboarding-links/${linkId}/record`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['content-disposition']).toMatch(/^inline; filename="dispatch-agreement-/);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      const html = res.text;
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<b>Lopez</b>');
      expect(html).toContain('Cedar &lt;script&gt;alert(1)&lt;/script&gt; Carriers');
      expect(html).toContain('Maria &lt;b&gt;Lopez&lt;/b&gt;');
      expect(html).toContain(`<path d="${SIG}"`);
      const row = await prisma.onboardingLink.findUnique({ where: { id: linkId } });
      expect(html).toContain(row.agreementHash);
      expect(html).toContain('Matches the hash the signer agreed to');
      expect(html).toContain(UA.replace(/&/g, '&amp;'));
      expect(html).toContain('W-9 - Cedar Creek Carriers.pdf');
      expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
      // A tampered signature column is not rendered as markup.
      await prisma.onboardingLink.update({ where: { id: linkId }, data: { signatureData: 'drawn:M 1 1"/><script>alert(2)</script>' } });
      const tampered = (await A.agent.get(`/api/onboarding-links/${linkId}/record`)).text;
      expect(tampered).not.toContain('alert(2)');
      await prisma.onboardingLink.update({ where: { id: linkId }, data: { signatureData: `drawn:${SIG}` } });
      await prisma.carrier.update({ where: { id: carrier.id }, data: { companyName: 'Cedar Creek Carriers' } });

      const detail = await A.agent.get(`/api/onboarding-links/${linkId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.item.signature).toEqual({ type: 'drawn', value: SIG });
      expect(detail.body.item.audit.map((e) => e.event)).toEqual(expect.arrayContaining(['created', 'viewed', 'consent', 'signed', 'document']));
    });

    it('closes the link 7 days after signing', async () => {
      await prisma.onboardingLink.update({ where: { id: linkId }, data: { signedAt: new Date(Date.now() - 8 * 86400000) } });
      const res = await pub().get(`/api/public/onboarding/${token}`);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('CLOSED');
      const up = await pub().post(`/api/public/onboarding/${token}/documents`).field('type', 'w9').attach('file', PDF(), { filename: 'w9.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(410);
    });
  });

  it('revoked and expired links answer 410 with a friendly message', async () => {
    const a = await create({ feePercent: 5 });
    const revokeRes = await A.agent.post(`/api/onboarding-links/${a.body.onboardingLink.id}/revoke`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.item.status).toBe('revoked');
    const r1 = await pub().get(`/api/public/onboarding/${tokenOf(a.body.link)}`);
    expect(r1.status).toBe(410);
    expect(r1.body.code).toBe('REVOKED');
    expect(r1.body.error).toMatch(/turned off/);
    expect((await pub().post(`/api/public/onboarding/${tokenOf(a.body.link)}/consent`).send({ agree: true })).status).toBe(410);

    const b = await create({ feePercent: 5 });
    await prisma.onboardingLink.update({ where: { id: b.body.onboardingLink.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r2 = await pub().get(`/api/public/onboarding/${tokenOf(b.body.link)}`);
    expect(r2.status).toBe(410);
    expect(r2.body.code).toBe('EXPIRED');
    expect(r2.body.error).toMatch(/expired/);
    const list = await A.agent.get(`/api/onboarding-links?carrierId=${carrier.id}`);
    expect(list.body.items.find((l) => l.id === b.body.onboardingLink.id).status).toBe('expired');
  });

  it('counts uploads against the dispatcher\'s storage', async () => {
    const res = await create({ feePercent: 5 });
    const token = tokenOf(res.body.link);
    const filler = await prisma.document.create({ data: { ownerId: A.user.id, uploadedById: A.user.id, type: 'other', originalName: 'filler.pdf', storedName: `filler-${randomToken(8)}.pdf`, mimeType: 'application/pdf', sizeBytes: STORAGE_MB.free * MB - 500 } });
    try {
      const up = await pub().post(`/api/public/onboarding/${token}/documents`).field('type', 'w9').attach('file', PDF(4096), { filename: 'w9.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(402);
      expect(up.body.code).toBe('STORAGE_FULL');
    } finally {
      await prisma.document.delete({ where: { id: filler.id } });
    }
  });

  it('"Email it" without a mailbox returns the message instead', async () => {
    const res = await create({ feePercent: 5, sendEmail: true });
    expect(res.status).toBe(201);
    expect(res.body.email.outcome).toBe('no_mailbox');
    expect(res.body.message.text).toContain('/onboard/');
  });
});
