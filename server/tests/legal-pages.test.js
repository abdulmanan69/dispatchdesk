import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { privacyHtml, termsHtml, homeHtml } from '../src/content/legal.js';

// Own app against a temporary client build (app.js reads CLIENT_DIST when first imported), like staticAssets.test.js.
let app;
let dir;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-legal-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" />\n    <!--seo-->\n    <title>x</title>\n    <!--/seo-->\n</head><body><div id="root"></div></body></html>');
  process.env.CLIENT_DIST = dir;
  const { createApp } = await import('../src/app.js');
  app = createApp();
});
afterAll(() => {
  delete process.env.CLIENT_DIST;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a handle */ }
});

describe('privacy policy, terms and home page for crawlers', () => {
  it('serves the full privacy policy inside the HTML (no JavaScript needed)', async () => {
    const res = await request(app).get('/privacy');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-legal="privacy"');
    for (const s of ['Information we collect', 'Google API Services User Data Policy', 'Limited Use', 'gmail.send', 'Retention', 'Your choices and rights', 'Children']) {
      expect(res.text).toContain(s);
    }
    expect(res.text).not.toMatch(/<script>(?!.*seo)/);
  });

  it('serves the terms and a home page summary with links to both', async () => {
    const terms = await request(app).get('/terms');
    expect(terms.text).toContain('data-legal="terms"');
    expect(terms.text).toContain('Acceptable use');
    const home = await request(app).get('/');
    expect(home.text).toContain('data-ssr="home"');
    expect(home.text).toMatch(/href="[^"]*\/privacy"/);
    expect(home.text).toMatch(/href="[^"]*\/terms"/);
  });

  it('leaves other pages as the plain app shell', async () => {
    const res = await request(app).get('/pricing');
    expect(res.text).toContain('<div id="root"></div>');
  });

  it('gives the React pages the same HTML and 404s unknown documents', async () => {
    const res = await request(app).get('/api/public/legal/privacy');
    expect(res.status).toBe(200);
    expect(res.body.html).toContain('Google API Services User Data Policy');
    expect((await request(app).get('/api/public/legal/nope')).status).toBe(404);
  });

  it('escapes the app name, address and support email', () => {
    const html = privacyHtml({ appName: '<b>X</b>', appUrl: 'https://x.test"><script>', supportEmail: 'a"><img src=x>@b.co' });
    expect(html).not.toContain('<b>X</b>');
    expect(html).not.toContain('"><script>');
    expect(html).not.toContain('<img src=x>');
    expect(termsHtml({ appName: '&' })).toContain('&amp;');
    expect(homeHtml({ appUrl: 'https://x.test' })).toContain('https://x.test/privacy');
  });
});
