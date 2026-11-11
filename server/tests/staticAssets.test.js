import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import request from 'supertest';

// This file builds its own app against a temporary client build, so it does not import helpers.js
// (app.js reads CLIENT_DIST when it is first imported).
let app;
let dir;
let precompress;
const JS = 'export const greeting = () => console.log("hello from a hashed bundle");\n'.repeat(200);
const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const decode = (buf, enc) => {
  try { return (enc === 'br' ? zlib.brotliDecompressSync(buf) : enc === 'gzip' ? zlib.gunzipSync(buf) : buf).toString(); } catch { return buf.toString(); }
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" />\n    <!--seo-->\n    <title>x</title>\n    <!--/seo-->\n</head><body><div id="root"></div></body></html>');
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), JS);
  fs.writeFileSync(path.join(dir, 'assets', 'tiny-9f.css'), 'a{color:red}');
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("push", () => {});\n');
  // In-browser OCR engine files: fixed names, so they must not get the immutable cache.
  fs.mkdirSync(path.join(dir, 'ocr'));
  fs.writeFileSync(path.join(dir, 'ocr', 'worker.min.js'), JS);
  // A file whose path looks like an API route: API requests must never be answered (or even looked up) as static files.
  fs.mkdirSync(path.join(dir, 'api'));
  fs.writeFileSync(path.join(dir, 'api', 'health'), 'static shadow');
  ({ precompressAssets: precompress } = await import('../src/middleware/static.js'));
  const report = await precompress(path.join(dir, 'assets'));
  expect(report.compressed).toBe(1); // the tiny CSS file is not worth compressing
  await precompress(path.join(dir, 'ocr'));
  process.env.CLIENT_DIST = dir;
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

afterAll(() => {
  delete process.env.CLIENT_DIST;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }
});

describe('static client files', () => {
  it('serves precompressed Brotli and gzip bundles with an immutable cache', async () => {
    for (const enc of ['br', 'gzip']) {
      const res = await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', enc).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe(enc);
      expect(res.headers['content-type']).toMatch(/^application\/javascript/);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers.vary).toMatch(/Accept-Encoding/i);
      expect(decode(res.body, enc)).toBe(JS);
    }
  });

  it('serves the OCR engine precompressed with a 1-day cache (fixed file names)', async () => {
    const res = await request(app).get('/ocr/worker.min.js').set('Accept-Encoding', 'br').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(decode(res.body, 'br')).toBe(JS);
  });

  it('falls back to the original file when the browser accepts no encoding', async () => {
    const res = await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', 'identity').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe(JS);
  });

  it('never sets cookies or looks up the session for static files', async () => {
    // A stale session cookie on an API call is checked (and cleared); on a static file it is ignored entirely.
    const asset = await request(app).get('/assets/index-abc123.js').set('Cookie', 'dd_session=stale-session-token');
    expect(asset.headers['set-cookie']).toBeUndefined();
    const icon = await request(app).get('/favicon.svg').set('Cookie', 'dd_session=stale-session-token');
    expect(icon.status).toBe(200);
    expect(icon.headers['set-cookie']).toBeUndefined();
    const api = await request(app).get('/api/auth/me').set('Cookie', 'dd_session=stale-session-token');
    expect((api.headers['set-cookie'] || []).join(';')).toMatch(/dd_session=;/);
  });

  it('revalidates the service worker script, while other public files keep a short cache', async () => {
    const sw = await request(app).get('/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers['content-type']).toMatch(/javascript/);
    expect(sw.headers['cache-control']).toBe('no-cache');
    const icon = await request(app).get('/favicon.svg');
    expect(icon.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('allows only self-hosted fonts and styles in the content security policy', async () => {
    const csp = (await request(app).get('/pricing')).headers['content-security-policy'];
    expect(csp).toMatch(/font-src 'self' data:/);
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline'/);
    expect(csp).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('answers a missing hashed file with a plain 404, not the HTML page', async () => {
    const res = await request(app).get('/assets/Fleet-oldhash.js');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('still renders pages with their own titles', async () => {
    const res = await request(app).get('/pricing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Pricing · DispatchDesk</title>');
  });

  it('API paths skip the static file handler', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.status).toBe('ok');
  });

  it('refuses upper-case /API prefixes outright', async () => {
    expect((await request(app).get('/API/auth/me')).status).toBe(404);
    expect((await request(app).post('/Api/carriers').send({})).status).toBe(404);
  });

  it('precompression is skipped for files that are already up to date', async () => {
    const again = await precompress(path.join(dir, 'assets'));
    expect(again).toMatchObject({ compressed: 0, skipped: 1 });
  });
});
