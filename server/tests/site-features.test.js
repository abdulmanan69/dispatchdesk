import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';

const { app } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { sitemapXml } = await import('../src/lib/seo.js');

describe('optional parts of the site (marketplace, live training program)', () => {
  // Back to the environment default (on in tests) for the files that run after this one.
  afterAll(async () => { await setSetting('app.marketplace', ''); await setSetting('app.trainingProgram', ''); });

  it('hides the marketplace and the live program when switched off, and keeps the course library', async () => {
    await setSetting('app.marketplace', 'false');
    await setSetting('app.trainingProgram', 'false');
    const site = await request(app).get('/api/public/site');
    expect(site.body.features).toEqual({ marketplace: false, trainingProgram: false });
    expect((await request(app).get('/api/marketplace/listings')).status).toBe(404);
    expect((await request(app).get('/api/training/messages')).status).toBe(404); // trainer messaging is part of the live program
    expect((await request(app).get('/api/training/courses')).status).toBe(200);

    await setSetting('app.marketplace', 'true');
    await setSetting('app.trainingProgram', 'true');
    expect((await request(app).get('/api/public/site')).body.features).toEqual({ marketplace: true, trainingProgram: true });
    expect((await request(app).get('/api/marketplace/listings')).status).toBe(200);
    expect((await request(app).get('/api/training/messages')).status).toBe(401); // on again: sign-in required, not hidden
  });

  it('leaves switched-off pages out of the sitemap', () => {
    const off = sitemapXml(new Date('2026-11-18'), { marketplace: false, trainingProgram: false });
    expect(off).not.toContain('/marketplace');
    expect(off).not.toContain('/training');
    expect(off).toContain('/pricing');
    expect(sitemapXml(new Date('2026-11-18'), { marketplace: true, trainingProgram: true })).toContain('/marketplace');
  });
});
