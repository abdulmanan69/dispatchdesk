import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

const { registerUser, prisma, app } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { weekOf } = await import('../src/services/invoices/statements.js');
const { sniffLogo } = await import('../src/routes/settings.js');
const { logoDataUri, brandLogo, invoiceHtml, statementHtml } = await import('../src/services/invoices/print.js');

const logoDir = path.join(config.uploadDir, 'logos');
const logoPath = (name) => path.join(logoDir, name);

// A real 1 x 1 PNG.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** PNG header with the given size (enough for the size check), padded to `total` bytes. */
function png(width, height, total = 64) {
  const b = Buffer.alloc(Math.max(total, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = 6;
  return b;
}

/** JPEG with a JFIF and an EXIF segment (and a fill byte) before the frame header, so the marker walk is exercised. */
function jpeg(width, height) {
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(200, 7)]);
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, (exifBody.length + 2) >> 8, (exifBody.length + 2) & 0xff]), exifBody]);
  const sof = Buffer.from([0xff, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9])]);
}

const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
const up = (U, buf, filename, contentType) => U.agent.post('/api/settings/invoice-logo').attach('file', buf, { filename, contentType });
const storedLogo = async (U) => (await prisma.user.findUnique({ where: { id: U.user.id }, select: { invoiceLogo: true } })).invoiceLogo;

let stage;
async function workspace(U, name) {
  stage ??= await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
  const broker = (await U.agent.post('/api/brokers').send({ companyName: `${name} Broker`, email: `ap@${name.toLowerCase()}.test` })).body.broker;
  const carrier = await prisma.carrier.create({ data: { ownerId: U.user.id, stageId: stage.id, companyName: `${name} Trucking`, email: `owner@${name.toLowerCase()}.test` } });
  const customer = (await U.agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 8 })).body.customer;
  const load = (await U.agent.post('/api/loads').send({
    brokerId: broker.id, carrierId: carrier.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA',
    loadedMiles: 800, rateCents: 200000, status: 'delivered', deliveryDate: new Date().toISOString(),
  })).body.load;
  const freight = (await U.agent.post('/api/invoices').send({ loadId: load.id, kind: 'freight' })).body.invoice;
  const fee = (await U.agent.post('/api/invoices').send({ loadId: load.id, kind: 'dispatch_fee' })).body.invoice;
  const portal = (await U.agent.post(`/api/customers/${customer.id}/portal`).send({ days: 30 })).body;
  return { customer, freight, fee, token: portal.url.split('/portal/')[1] };
}

describe('logo header parsing', () => {
  it('reads PNG and JPEG sizes from the bytes and refuses everything else', () => {
    expect(sniffLogo(PNG_1PX)).toEqual({ type: 'image/png', ext: '.png', width: 1, height: 1 });
    expect(sniffLogo(png(640, 200))).toMatchObject({ type: 'image/png', width: 640, height: 200 });
    expect(sniffLogo(jpeg(300, 120))).toEqual({ type: 'image/jpeg', ext: '.jpg', width: 300, height: 120 });
    expect(sniffLogo(SVG)).toBeNull();
    expect(sniffLogo(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toBeNull();
    expect(sniffLogo(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // JPEG without a frame header
    expect(sniffLogo(png(1, 1).subarray(0, 20))).toBeNull(); // truncated
    expect(sniffLogo('not a buffer')).toBeNull();
  });

  it('renders no image markup without a logo and only data: images with one', () => {
    const inv = { number: 7, kind: 'dispatch_fee', status: 'draft', billToName: 'X', amountCents: 100, items: [], meta: {} };
    expect(invoiceHtml(inv, {})).not.toMatch(/<img|class="brand"/);
    expect(invoiceHtml(inv, { logo: { src: 'https://evil.test/x.png', alt: 'x' } })).not.toMatch(/<img/);
    expect(invoiceHtml(inv, { logo: { src: 'data:image/svg+xml;base64,PHN2Zz4=', alt: 'x' } })).not.toMatch(/<img/);
    expect(invoiceHtml(inv, { logo: { src: 'data:image/png;base64,AAAA" onerror="x', alt: 'x' } })).not.toMatch(/<img/);
    const html = invoiceHtml(inv, { logo: { src: 'data:image/png;base64,AAAA', alt: 'A "B" <C>' } });
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="A &quot;B&quot; &lt;C&gt;">');
    const st = { weekStart: '2026-11-09', periodStart: new Date(), periodEnd: new Date(), carrier: { companyName: 'C' }, lines: [], totals: { loads: 0, loadedMiles: 0, grossCents: 0, feeCents: 0, netCents: 0 } };
    expect(statementHtml(st, {})).not.toMatch(/<img/);
    expect(statementHtml(st, { logo: { src: 'data:image/jpeg;base64,AAAA', alt: 'D' } })).toContain('<img src="data:image/jpeg;base64,AAAA" alt="D">');
  });
});

describe('invoice logo upload and printing', () => {
  let A;
  let B;
  let wa;
  let wb;
  const JPEG = jpeg(400, 150);
  const jpegUri = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
  const pngUri = `data:image/png;base64,${PNG_1PX.toString('base64')}`;

  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    expect((await A.agent.patch('/api/profile').send({ companyName: 'Acme <Dispatch> & Co' })).status).toBe(200);
    wa = await workspace(A, 'Alpha');
    wb = await workspace(B, 'Bravo');
  });

  it('refuses SVG, files whose bytes are not PNG or JPEG, files over 500 KB and images over 2000 pixels', async () => {
    const svg = await up(A, SVG, 'logo.svg', 'image/svg+xml');
    expect(svg.status).toBe(400);
    expect(svg.body.error).toMatch(/SVG/);
    const disguised = await up(A, SVG, 'logo.png', 'image/png');
    expect(disguised.status).toBe(400);
    expect(disguised.body.error).toMatch(/SVG/);
    expect((await up(A, Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1'), 'logo.png', 'image/png')).status).toBe(400);
    expect((await up(A, Buffer.from('%PDF-1.4 hello'), 'logo.jpg', 'image/jpeg')).status).toBe(400);
    expect((await up(A, PNG_1PX, 'logo.gif', 'image/gif')).status).toBe(400);
    expect((await up(A, PNG_1PX, 'logo.webp', 'image/webp')).status).toBe(400);
    const big = await up(A, png(100, 100, 500 * 1024 + 1), 'big.png', 'image/png');
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/500 KB/);
    const wide = await up(A, png(2001, 100), 'wide.png', 'image/png');
    expect(wide.status).toBe(400);
    expect(wide.body.error).toMatch(/2000 x 2000/);
    expect((await up(A, jpeg(100, 2500), 'tall.jpg', 'image/jpeg')).status).toBe(400);
    expect((await up(A, png(0, 10), 'empty.png', 'image/png')).status).toBe(400);
    expect((await A.agent.post('/api/settings/invoice-logo').send({})).status).toBe(400);
    // Exactly at the limits is fine (checked below with the real logo); nothing was stored by the refusals.
    expect(await storedLogo(A)).toBeNull();
    expect((await A.agent.get('/api/settings/invoice-logo')).status).toBe(404);
  });

  it('stores a PNG under a random name, serves it privately and replaces it with a JPEG, deleting the old file', async () => {
    const first = await up(A, PNG_1PX, 'My Logo.png', 'image/png');
    expect(first.status).toBe(200);
    expect(first.body.invoiceLogo).toEqual({ type: 'image/png', width: 1, height: 1, sizeBytes: PNG_1PX.length });
    const name1 = await storedLogo(A);
    expect(name1).toMatch(/^\d+-[A-Za-z0-9_-]{16}\.png$/);
    expect(fs.readFileSync(logoPath(name1)).equals(PNG_1PX)).toBe(true);

    const got = await A.agent.get('/api/settings/invoice-logo');
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/^image\/png/);
    expect(got.headers['cache-control']).toBe('private, no-cache');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(got.body).equals(PNG_1PX)).toBe(true);

    // A JPEG sent with a .jpeg name and a generic type is stored by what its bytes are.
    const second = await up(A, JPEG, 'logo.jpeg', 'application/octet-stream');
    expect(second.status).toBe(200);
    expect(second.body.invoiceLogo).toMatchObject({ type: 'image/jpeg', width: 400, height: 150 });
    const name2 = await storedLogo(A);
    expect(name2).toMatch(/\.jpg$/);
    expect(name2).not.toBe(name1);
    expect(fs.existsSync(logoPath(name1))).toBe(false);
    expect(fs.existsSync(logoPath(name2))).toBe(true);
    const got2 = await A.agent.get('/api/settings/invoice-logo');
    expect(got2.headers['content-type']).toMatch(/^image\/jpeg/);

    // At the limits: 2000 x 2000 is accepted (then replaced again by the JPEG used in the print checks).
    expect((await up(A, png(2000, 2000), 'max.png', 'image/png')).status).toBe(200);
    expect((await up(A, JPEG, 'logo.jpg', 'image/jpeg')).status).toBe(200);
    expect(fs.readdirSync(logoDir).filter((f) => f === name2)).toHaveLength(0);
  });

  it('prints the owner logo on that owner\'s invoices, statements and portal statements only', async () => {
    const feePage = await A.agent.get(`/api/invoices/${wa.fee.id}/print`);
    expect(feePage.status).toBe(200);
    expect(feePage.text).toContain(`<img src="${jpegUri}" alt="Acme &lt;Dispatch&gt; &amp; Co">`);
    expect(feePage.text).not.toMatch(/<script/i);
    expect(feePage.headers['content-security-policy']).toMatch(/img-src[^;]*data:/);
    // Freight invoices are issued in the carrier's name: no dispatcher logo.
    const freightPage = await A.agent.get(`/api/invoices/${wa.freight.id}/print`);
    expect(freightPage.status).toBe(200);
    expect(freightPage.text).not.toContain(jpegUri);
    const week = weekOf(A.user.timezone || 'America/Chicago').key;
    const st = await A.agent.get(`/api/customers/${wa.customer.id}/statements/${week}/print`);
    expect(st.status).toBe(200);
    expect(st.text).toContain(jpegUri);
    const portal = await request(app).get(`/api/public/portal/${wa.token}/statements/${week}/print`);
    expect(portal.status).toBe(200);
    expect(portal.text).toContain(`<img src="${jpegUri}"`);
    expect(portal.headers['content-security-policy']).toMatch(/img-src[^;]*data:/);

    // B has no logo: B's pages have no image at all, and never A's.
    const bPage = await B.agent.get(`/api/invoices/${wb.fee.id}/print`);
    expect(bPage.status).toBe(200);
    expect(bPage.text).not.toMatch(/<img|class="brand"/);
    const bWeek = weekOf(B.user.timezone || 'America/Chicago').key;
    const bPortal = await request(app).get(`/api/public/portal/${wb.token}/statements/${bWeek}/print`);
    expect(bPortal.text).not.toMatch(/<img/);
  });

  it('keeps other users away from the logo', async () => {
    const before = await storedLogo(A);
    expect((await B.agent.get('/api/settings/invoice-logo')).status).toBe(404);
    expect((await B.agent.delete('/api/settings/invoice-logo')).status).toBe(200);
    expect(await storedLogo(A)).toBe(before);
    expect(fs.existsSync(logoPath(before))).toBe(true);
    // B uploading a logo changes only B's pages.
    expect((await up(B, PNG_1PX, 'b.png', 'image/png')).status).toBe(200);
    expect(await storedLogo(A)).toBe(before);
    const bPage = await B.agent.get(`/api/invoices/${wb.fee.id}/print`);
    expect(bPage.text).toContain(pngUri);
    expect(bPage.text).not.toContain(jpegUri);
    const aPage = await A.agent.get(`/api/invoices/${wa.fee.id}/print`);
    expect(aPage.text).toContain(jpegUri);
    expect(aPage.text).not.toContain(pngUri);
    expect((await B.agent.get(`/api/invoices/${wa.fee.id}/print`)).status).toBe(404);
    // Without a session the route is closed.
    expect((await request(app).get('/api/settings/invoice-logo')).status).toBe(401);
  });

  it('removes the logo and its file', async () => {
    const name = await storedLogo(A);
    const del = await A.agent.delete('/api/settings/invoice-logo');
    expect(del.status).toBe(200);
    expect(await storedLogo(A)).toBeNull();
    expect(fs.existsSync(logoPath(name))).toBe(false);
    expect((await A.agent.get('/api/settings/invoice-logo')).status).toBe(404);
    const page = await A.agent.get(`/api/invoices/${wa.fee.id}/print`);
    expect(page.text).not.toMatch(/<img|class="brand"/);
    expect((await A.agent.delete('/api/settings/invoice-logo')).status).toBe(200);
    expect(await brandLogo(A.user.id)).toBeNull();
  });

  it('uses the team or company name as alt text and skips a missing file', async () => {
    const C = await registerUser({ name: 'Casey Lane' });
    expect((await up(C, PNG_1PX, 'c.png', 'image/png')).status).toBe(200);
    expect(await brandLogo(C.user.id)).toEqual({ src: pngUri, alt: 'Casey Lane' });
    const name = await storedLogo(C);
    expect(await logoDataUri(name)).toBe(pngUri); // cached
    // A logo row whose file is gone prints nothing instead of failing.
    expect(await logoDataUri('missing-file.png')).toBeNull();
    // Account deletion removes the file.
    const gone = await C.agent.delete('/api/settings/account').send({ password: C.password, confirm: 'DELETE' });
    expect(gone.status).toBe(200);
    expect(fs.existsSync(logoPath(name))).toBe(false);
  });
});
