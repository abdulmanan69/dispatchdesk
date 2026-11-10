import { config } from '../config.js';

/**
 * Server-side SEO for the single-page app: per-route <title>, description, canonical URL, Open Graph and
 * Twitter tags are written into index.html before it is sent, so link previews (WhatsApp, iMessage, SMS apps,
 * Facebook, Slack, LinkedIn) and search engines see them without running JavaScript.
 * Private areas (/app, driver links, invites, auth tokens) are marked noindex.
 */
const SITE = 'DispatchDesk';
const DEFAULT_DESC = 'The CRM and dispatch desk for truck dispatchers: generate carrier leads from the FMCSA census, call with Google Voice or your phone service, run sequences and follow-ups, and plan every truck’s next trip on a live map. Free plan, no card needed.';
const IMG = { default: '/og/og-default.png', track: '/og/og-track.png', invite: '/og/og-invite.png' };

const PAGES = [
  { match: /^\/$/, title: `${SITE} · CRM and dispatch desk for truck dispatchers`, description: DEFAULT_DESC, sitemap: { path: '/', priority: '1.0' }, home: true },
  { match: /^\/features\/?$/, title: `Features · ${SITE}`, description: 'Lead generator from FMCSA data, power dialer with Google Voice and 8x8, sequences with call, email and text steps, follow-ups, fleet map with live driver links, market data and a Chrome extension.', sitemap: { path: '/features', priority: '0.9' } },
  { match: /^\/pricing\/?$/, title: `Pricing · ${SITE}`, description: 'Start free and keep it as long as you like. Upgrade for more generated leads, scheduled lead runs, higher email limits, automations and team features.', sitemap: { path: '/pricing', priority: '0.9' } },
  { match: /^\/training\/?$/, title: `Dispatch training · ${SITE}`, description: 'Practical courses for new and growing truck dispatchers: finding carriers, booking loads, negotiating rates and running the desk.', sitemap: { path: '/training', priority: '0.7' } },
  { match: /^\/marketplace\/?$/, title: `Marketplace · ${SITE}`, description: 'Services, trucks and dispatch offers listed by the DispatchDesk community.', sitemap: { path: '/marketplace', priority: '0.6' } },
  { match: /^\/marketplace\/.+/, title: `Marketplace listing · ${SITE}`, description: 'A listing on the DispatchDesk marketplace.' },
  { match: /^\/community\/?$/, title: `Community · ${SITE}`, description: 'Questions, tips and wins from truck dispatchers using DispatchDesk.', sitemap: { path: '/community', priority: '0.6' } },
  { match: /^\/community\/.+/, title: `Community post · ${SITE}`, description: 'A discussion in the DispatchDesk dispatcher community.' },
  { match: /^\/u\/.+/, title: `Dispatcher profile · ${SITE}`, description: 'A dispatcher on DispatchDesk.', noindex: true },
  { match: /^\/login\/?$/, title: `Log in · ${SITE}`, description: 'Log in to your DispatchDesk account.' },
  { match: /^\/register\/?$/, title: `Create your free account · ${SITE}`, description: 'Create a free DispatchDesk account. No card needed.', sitemap: { path: '/register', priority: '0.8' } },
  { match: /^\/terms\/?$/, title: `Terms of service · ${SITE}`, description: 'The terms for using DispatchDesk.', sitemap: { path: '/terms', priority: '0.2' } },
  { match: /^\/privacy\/?$/, title: `Privacy policy · ${SITE}`, description: 'How DispatchDesk handles your data.', sitemap: { path: '/privacy', priority: '0.2' } },
  { match: /^\/track\/.+/, title: `Trip check-in link · ${SITE}`, description: 'From your dispatcher. Open this on the phone in your truck to share your location and check in at pickup and delivery. Works on one phone, and you can stop anytime.', image: IMG.track, noindex: true, alt: 'Trip check-in link: share your location from the phone in your truck' },
  { match: /^\/invite\/.+/, title: `You are invited to a dispatch team · ${SITE}`, description: 'Join your team on DispatchDesk: shared pipeline, call queue, team board and leaderboard.', image: IMG.invite, noindex: true, alt: 'Invitation to a DispatchDesk team' },
  { match: /^\/(forgot-password|reset-password|verify-email|unsubscribe)\/?/, title: SITE, description: DEFAULT_DESC, noindex: true },
  { match: /^\/app(\/|$)/, title: SITE, description: DEFAULT_DESC, noindex: true },
];

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function metaFor(pathname) {
  const page = PAGES.find((p) => p.match.test(pathname));
  if (!page) return { title: `Page not found · ${SITE}`, description: DEFAULT_DESC, image: IMG.default, noindex: true, status: 404 };
  return { image: IMG.default, ...page };
}

function jsonLd() {
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, Chrome',
      url: `${config.appUrl}/`,
      description: DEFAULT_DESC,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: 'Free plan' },
    },
    { '@context': 'https://schema.org', '@type': 'Organization', name: SITE, url: `${config.appUrl}/`, logo: `${config.appUrl}/icons/icon-512.png` },
  ];
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

/** The <head> block for one request path. */
export function headTags(pathname) {
  const m = metaFor(pathname);
  const url = `${config.appUrl}${pathname === '/' ? '/' : pathname.replace(/\/$/, '')}`;
  const img = `${config.appUrl}${m.image}`;
  const tags = [
    `<title>${escAttr(m.title)}</title>`,
    `<meta name="description" content="${escAttr(m.description)}" />`,
    m.noindex ? '<meta name="robots" content="noindex, nofollow" />' : `<link rel="canonical" href="${escAttr(url)}" />`,
    `<meta property="og:site_name" content="${SITE}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${escAttr(m.title)}" />`,
    `<meta property="og:description" content="${escAttr(m.description)}" />`,
    // Driver/invite links carry a secret token: never echo it into previews; point og:url at the site instead.
    `<meta property="og:url" content="${escAttr(m.noindex && /^\/(track|invite)\//.test(pathname) ? `${config.appUrl}/` : url)}" />`,
    `<meta property="og:image" content="${escAttr(img)}" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${escAttr(m.alt || 'DispatchDesk: find carriers, call them, keep trucks moving')}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escAttr(m.title)}" />`,
    `<meta name="twitter:description" content="${escAttr(m.description)}" />`,
    `<meta name="twitter:image" content="${escAttr(img)}" />`,
  ];
  if (m.home) tags.push(jsonLd());
  return { html: tags.join('\n    '), status: m.status || 200 };
}

const SEO_BLOCK = /<!--seo-->[\s\S]*?<!--\/seo-->/;

/** Render index.html for a path (cached per path pattern result; the HTML is small). */
const cache = new Map();
export function renderIndex(template, pathname) {
  const key = pathname.startsWith('/track/') ? '/track/*' : pathname.startsWith('/invite/') ? '/invite/*' : pathname.startsWith('/app') ? '/app/*' : pathname;
  const hit = cache.get(key);
  if (hit) return hit;
  const { html, status } = headTags(key.endsWith('/*') ? key.replace('*', 'x') : pathname);
  const out = { body: SEO_BLOCK.test(template) ? template.replace(SEO_BLOCK, html) : template.replace('</head>', `    ${html}\n  </head>`), status };
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

export function robotsTxt() {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /app',
    'Disallow: /api',
    'Disallow: /track',
    'Disallow: /invite',
    'Disallow: /reset-password',
    'Disallow: /verify-email',
    'Disallow: /unsubscribe',
    '',
    `Sitemap: ${config.appUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(lastmod = new Date()) {
  const day = lastmod.toISOString().slice(0, 10);
  const urls = PAGES.filter((p) => p.sitemap).map((p) => `  <url><loc>${config.appUrl}${p.sitemap.path}</loc><lastmod>${day}</lastmod><priority>${p.sitemap.priority}</priority></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function webManifest() {
  return {
    name: SITE,
    short_name: SITE,
    description: 'CRM and dispatch desk for truck dispatchers',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0f14',
    theme_color: '#0f766e',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
