import { describe, it, expect } from 'vitest';
import { renderIndex, robotsTxt, sitemapXml, webManifest, metaFor } from '../src/lib/seo.js';
import { config } from '../src/config.js';

const TEMPLATE = '<!doctype html><html><head><meta charset="UTF-8" />\n    <!--seo-->\n    <title>x</title>\n    <!--/seo-->\n</head><body><div id="root"></div></body></html>';

describe('SEO and link previews', () => {
  it('writes per-page title, description, canonical and Open Graph tags', () => {
    const { body, status } = renderIndex(TEMPLATE, '/pricing');
    expect(status).toBe(200);
    expect(body).toContain('<title>Pricing · DispatchDesk</title>');
    expect(body).toContain(`<link rel="canonical" href="${config.appUrl}/pricing" />`);
    expect(body).toContain(`<meta property="og:image" content="${config.appUrl}/og/og-default.png" />`);
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(body).not.toContain('<title>x</title>');
    expect(body.match(/<title>/g)).toHaveLength(1);
  });

  it('driver links get the trip preview image, noindex, and never echo the secret token', () => {
    const { body } = renderIndex(TEMPLATE, '/track/SECRET-TOKEN-123');
    expect(body).toContain('/og/og-track.png');
    expect(body).toContain('noindex');
    expect(body).toContain('Trip check-in link');
    expect(body).not.toContain('SECRET-TOKEN-123');
  });

  it('home page carries JSON-LD; app pages are noindex; unknown pages are 404', () => {
    expect(renderIndex(TEMPLATE, '/').body).toContain('application/ld+json');
    expect(renderIndex(TEMPLATE, '/app/carriers').body).toContain('noindex');
    expect(metaFor('/nope-not-a-page').status).toBe(404);
  });

  it('robots, sitemap and manifest', () => {
    expect(robotsTxt()).toContain('Disallow: /app');
    expect(robotsTxt()).toContain(`Sitemap: ${config.appUrl}/sitemap.xml`);
    const xml = sitemapXml(new Date('2026-11-10T00:00:00Z'));
    expect(xml).toContain(`<loc>${config.appUrl}/pricing</loc>`);
    expect(xml).not.toContain('/app');
    expect(webManifest().icons.length).toBe(3);
  });
});
