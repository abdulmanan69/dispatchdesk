import { describe, it, expect } from 'vitest';
import { renderIndex, robotsTxt, sitemapXml, webManifest, metaFor, structuredData } from '../src/lib/seo.js';
import { FEATURE_PAGES } from '../src/content/featurePages.js';
import { featurePageHtml, featuresHtml } from '../src/content/featureHtml.js';
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

  it('broker tracking links get the load tracking image (not the driver one), noindex, and never echo the token', () => {
    const { body } = renderIndex(TEMPLATE, '/t/SECRET-LOAD-TOKEN-9');
    expect(body).toContain('/og/og-load.png');
    expect(body).not.toContain('/og/og-track.png');
    expect(body).toContain('noindex');
    expect(body).toContain('Load tracking');
    expect(body).not.toContain('SECRET-LOAD-TOKEN-9');
  });

  it('home page carries JSON-LD; app pages are noindex; unknown pages are 404', () => {
    expect(renderIndex(TEMPLATE, '/').body).toContain('application/ld+json');
    expect(renderIndex(TEMPLATE, '/app/carriers').body).toContain('noindex');
    expect(metaFor('/nope-not-a-page').status).toBe(404);
  });

  it('feature pages get their own title, canonical and a 3-level BreadcrumbList', () => {
    const { body, status } = renderIndex(TEMPLATE, '/features/power-dialer');
    expect(status).toBe(200);
    expect(body).toContain('<title>Power dialer for truck dispatchers · DispatchDesk</title>');
    expect(body).toContain(`<link rel="canonical" href="${config.appUrl}/features/power-dialer" />`);
    const ld = JSON.parse(body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
    expect(ld['@type']).toBe('BreadcrumbList');
    expect(ld.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${config.appUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Features', item: `${config.appUrl}/features` },
      { '@type': 'ListItem', position: 3, name: 'Power dialer', item: `${config.appUrl}/features/power-dialer` },
    ]);
    expect(metaFor('/features/not-a-feature').status).toBe(404);
  });

  it('top-level public pages get a 2-level trail; home gets WebSite; private pages get none', () => {
    const pricing = JSON.parse(renderIndex(TEMPLATE, '/pricing').body.match(/application\/ld\+json">(.*?)<\/script>/)[1]);
    expect(pricing.itemListElement.map((i) => i.name)).toEqual(['Home', 'Pricing']);
    expect(structuredData('/', metaFor('/')).map((d) => d['@type'])).toEqual(['WebSite', 'SoftwareApplication', 'Organization']);
    expect(structuredData('/app/carriers', metaFor('/app/carriers'))).toEqual([]);
    expect(structuredData('/track/x', metaFor('/track/x'))).toEqual([]);
    expect(structuredData('/login', metaFor('/login'))).toEqual([]);
  });

  it('every feature page is in the sitemap and has text in the HTML for crawlers', () => {
    const xml = sitemapXml(new Date('2026-11-10T00:00:00Z'));
    for (const f of FEATURE_PAGES) {
      expect(xml).toContain(`<loc>${config.appUrl}/features/${f.slug}</loc>`);
      const html = featurePageHtml(f.slug, { appUrl: config.appUrl });
      expect(html).toContain(`<h1>${f.title.replace(/&/g, '&amp;')}</h1>`);
      expect(html).toContain('aria-label="Breadcrumb"');
      for (const r of f.related) expect(FEATURE_PAGES.some((x) => x.slug === r)).toBe(true);
    }
    expect(featurePageHtml('nope')).toBeNull();
    expect(featuresHtml({ appUrl: config.appUrl })).toContain('/features/carrier-check');
  });

  it('titles fit in search results and descriptions say trial, not free plan', () => {
    for (const f of FEATURE_PAGES) {
      expect(`${f.seoTitle} · DispatchDesk`.length).toBeLessThanOrEqual(65);
      expect(f.description.length).toBeLessThanOrEqual(160);
    }
    expect(renderIndex(TEMPLATE, '/').body).not.toMatch(/free plan/i);
    expect(renderIndex(TEMPLATE, '/pricing').body).toContain('14 days');
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
