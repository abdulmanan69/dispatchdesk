import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { renderIndex, robotsTxt, sitemapXml, webManifest } from './lib/seo.js';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from './db.js';
import { config } from './config.js';
import { loadSession, requireAuth, requireVerifiedEmail } from './middleware/auth.js';
import { csrf, apiLimiter, ipFloodLimiter, publicLinkLimiter, linkMissLimiter } from './middleware/security.js';
import { errorHandler, notFoundApi } from './middleware/error.js';
import { precompressAssets, precompressedAssets } from './middleware/static.js';
import { withLock, LockBusyError } from './lib/locks.js';
import { broadcast, onBroadcast } from './lib/broadcast.js';

import authRoutes from './routes/auth.js';
import profileRoutes, { serveAvatar } from './routes/profile.js';
import dashboardRoutes from './routes/dashboard.js';
import carrierRoutes from './routes/carriers.js';
import tagRoutes from './routes/tags.js';
import discoveryRoutes from './routes/discovery.js';
import leadGeneratorRoutes from './routes/leadGenerators.js';
import marketRoutes from './routes/market.js';
import fleetRoutes from './routes/fleet.js';
import pipelineRoutes from './routes/pipeline.js';
import prospectingRoutes from './routes/prospecting.js';
import callRoutes from './routes/calls.js';
import sequenceRoutes from './routes/sequences.js';
import followUpRoutes from './routes/followups.js';
import opportunityRoutes from './routes/opportunities.js';
import customerRoutes from './routes/customers.js';
import documentRoutes from './routes/documents.js';
import brokerRoutes from './routes/brokers.js';
import loadRoutes from './routes/loads.js';
import emailRoutes from './routes/email.js';
import automationRoutes from './routes/automations.js';
import aiRoutes from './routes/ai.js';
import trainingRoutes from './routes/training.js';
import marketplaceRoutes from './routes/marketplace.js';
import communityRoutes from './routes/community.js';
import teamRoutes from './routes/teams.js';
import billingRoutes, { webhookHandler } from './routes/billing.js';
import adminRoutes from './routes/admin.js';
import adminSetupRoutes from './routes/adminSetup.js';
import settingsRoutes from './routes/settings.js';
import notificationRoutes from './routes/notifications.js';
import publicRoutes from './routes/public.js';
import telephonyRoutes from './routes/telephony.js';
import trackRoutes from './routes/track.js';
import callScriptRoutes from './routes/callScripts.js';
import tokenRoutes from './routes/tokens.js';
import tourRoutes from './routes/tours.js';
import extensionRoutes from './routes/extension.js';
import templateRoutes from './routes/templates.js';
import invoiceRoutes from './routes/invoices.js';
import portalRoutes from './routes/portal.js';
import loadTrackRoutes from './routes/loadTrack.js';
import pushRoutes from './routes/push.js';
import calendarRoutes from './routes/calendar.js';
import calendarFeedRoutes from './routes/calendarFeed.js';
import todayRoutes from './routes/today.js';
import authorityKitRoutes from './routes/authorityKit.js';
import truckPostRoutes from './routes/truckPosts.js';
import onboardingLinkRoutes from './routes/onboardingLinks.js';
import publicOnboardingRoutes from './routes/publicOnboarding.js';
import planEtaRoutes from './routes/planEta.js';
import onboardingRoutes from './routes/onboarding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = process.env.CLIENT_DIST || path.resolve(__dirname, '../../client/dist');

/** Paths handled by the API (any letter case, so security middleware also sees /API/... tricks). */
const isApiPath = (p) => /^\/api(\/|$)/i.test(p);
/** Run a middleware for API paths only: pages and static files need no session lookup. */
const forApi = (mw) => (req, res, next) => (isApiPath(req.path) ? mw(req, res, next) : next());

/**
 * Once per deploy, write Brotli/gzip copies of the hashed client bundles in the background (one worker does it,
 * guarded by a DB lock keyed on the build), then tell every worker to start serving them.
 */
function precompressInBackground(assetsDir, buildId, assets) {
  if (config.isTest || process.env.DISABLE_PRECOMPRESS === 'true') return;
  onBroadcast('assets-precompressed', () => assets.refresh());
  const run = () => withLock(`precompress.${buildId}`, 30 * 60_000, () => precompressAssets(assetsDir))
    .then((r) => {
      if (r.compressed) console.log(`[assets] precompressed ${r.compressed} files (${Math.round(r.bytesIn / 1024)} KB -> ${Math.round(r.bytesBr / 1024)} KB brotli)`);
      broadcast('assets-precompressed');
    })
    .catch((err) => {
      if (err instanceof LockBusyError) return; // another worker is doing it and will broadcast
      console.error(`[assets] precompression skipped: ${err.message}`);
    });
  setTimeout(run, 5000).unref();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Security: Express matches routes case-insensitively by default, so "/API/ADMIN" would reach "/api/admin" while
  // path-based checks (CSRF exemptions, API-token blocklist) compared the raw path. Make mounts case-sensitive.
  app.set('case sensitive routing', true);
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        // 'wasm-unsafe-eval' lets WebAssembly compile (in-browser OCR of scanned rate cons, pdf.js image decoders);
        // it does not allow eval() or inline scripts. Scripts still come only from this origin.
        'script-src': ["'self'", "'wasm-unsafe-eval'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'font-src': ["'self'", 'data:'], // fonts are self-hosted under /assets
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'blob:'],
        // Map tiles, glyphs and sprites for the fleet map (OpenFreeMap, free and keyless).
        'connect-src': ["'self'", 'https://tiles.openfreemap.org'],
        'worker-src': ["'self'", 'blob:'],
        'frame-src': ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://checkout.stripe.com'],
        'form-action': ["'self'", 'https://checkout.stripe.com'],
        'upgrade-insecure-requests': config.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // Stripe needs the raw body to verify webhook signatures: mount before the JSON parser.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), webhookHandler);

  // Only the lower-case /api prefix is the API. /API/... and /Api/... are refused outright, so no path-based check
  // (CSRF, API-token blocklist, verification) can be skipped by changing letter case.
  app.use((req, res, next) => (isApiPath(req.path) && !req.path.startsWith('/api') ? res.status(404).json({ error: 'Not found' }) : next()));

  const hasClient = fs.existsSync(CLIENT_DIST);
  // Built client files come first: JS, CSS, fonts and images need no cookies, CSRF token or session lookup.
  // Hashed bundles are served from precompressed .br/.gz copies when they exist.
  if (hasClient) {
    const assetsDir = path.join(CLIENT_DIST, 'assets');
    const assets = precompressedAssets(assetsDir);
    app.use('/assets', assets);
    let buildId = 'dev';
    try { buildId = String(Math.round(fs.statSync(path.join(CLIENT_DIST, 'index.html')).mtimeMs)); } catch { /* no index.html */ }
    precompressInBackground(assetsDir, buildId, assets);
    // The in-browser OCR engine (client/public/ocr, ~8 MB of JS) has fixed file names, so it gets a 1-day cache
    // instead of the immutable one, and is served from .br/.gz copies instead of being gzipped on every download.
    const ocrDir = path.join(CLIENT_DIST, 'ocr');
    if (fs.existsSync(ocrDir)) {
      const ocr = precompressedAssets(ocrDir, { cacheControl: 'public, max-age=86400' });
      app.use('/ocr', ocr);
      precompressInBackground(ocrDir, `${buildId}-ocr`, ocr);
    }
  }

  // gzip JSON and static assets (skips already-compressed types and server-sent streams).
  app.use(compression({ filter: (req, res) => !String(res.getHeader('Content-Type') || '').includes('text/event-stream') && compression.filter(req, res) }));
  if (hasClient) {
    const serviceWorkerFile = path.resolve(CLIENT_DIST, 'sw.js');
    const clientFiles = express.static(CLIENT_DIST, {
      index: false, maxAge: '1h',
      setHeaders: (res, p) => {
        if (p.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        // The service worker script is revalidated on every update check, so a fixed worker reaches every device.
        else if (path.resolve(p) === serviceWorkerFile) res.set('Cache-Control', 'no-cache');
      },
    });
    // API requests skip the file lookup (otherwise every GET /api/... would stat a file under client/dist first).
    app.use((req, res, next) => (isApiPath(req.path) ? next() : clientFiles(req, res, next)));
    // A missing hashed file (an old tab after a deploy) is a plain 404, not the HTML page, so the client can reload.
    app.use('/assets', (req, res) => res.status(404).type('text/plain').set('Cache-Control', 'no-store').send('Not found'));
  }

  // Flood ceiling per network address, before any database work.
  app.use('/api', ipFloodLimiter);
  // Public avatar images: cacheable for a year with versioned URLs, no session lookup, no per-user API budget.
  app.get('/api/profile/avatar/:userId', serveAvatar);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());
  app.use(csrf);
  app.use(forApi(loadSession));
  // After the session is known, so each signed-in user (or API token) has its own budget even behind one office NAT.
  // Secret-link endpoints are budgeted per link instead (the driver link has its own limiter in routes/track.js).
  app.use('/api', apiLimiter);
  app.use(/^\/api\/public\/(load-track|portal|calendar|onboarding)(?=\/)/, publicLinkLimiter);
  // Per address, counting only unknown or expired links: guessing tokens cannot get a fresh bucket per guess.
  app.use(/^\/api\/public\/(track|load-track|portal|calendar|onboarding)(?=\/)/, linkMissLimiter);
  app.use(forApi(requireVerifiedEmail));

  app.get('/api/health', async (req, res) => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      res.json({ status: 'ok', db: 'ok', time: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()) });
    } catch (err) {
      res.status(503).json({ status: 'error', db: 'unreachable' });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/public/track', trackRoutes); // driver live-location links (token in URL, no session)
  app.use('/api/public/load-track', loadTrackRoutes); // broker/shipper tracking links (token in URL, no session)
  app.use('/api/public/portal', portalRoutes); // carrier portal links (token in URL, no session)
  app.use('/api/public/calendar', calendarFeedRoutes); // private iCalendar feeds (token in URL, no session)
  app.use('/api/public/onboarding', publicOnboardingRoutes); // carrier onboarding + e-signature links (token in URL, no session)
  app.use('/api/public', publicRoutes);
  app.use('/api/billing', billingRoutes); // /plans is public, the rest checks auth itself
  app.use('/api/training', trainingRoutes); // catalogue + request form are public
  app.use('/api/marketplace', marketplaceRoutes); // browsing is public
  app.use('/api/community', communityRoutes); // reading is public

  // Everything below requires a session.
  app.use('/api/dashboard', requireAuth, dashboardRoutes);
  app.use('/api/carriers', requireAuth, carrierRoutes);
  app.use('/api/tags', requireAuth, tagRoutes);
  app.use('/api/discovery', requireAuth, discoveryRoutes);
  app.use('/api/lead-generators', requireAuth, leadGeneratorRoutes);
  app.use('/api/market', requireAuth, marketRoutes);
  app.use('/api/fleet', requireAuth, fleetRoutes);
  app.use('/api/pipeline', requireAuth, pipelineRoutes);
  app.use('/api/prospecting', requireAuth, prospectingRoutes);
  app.use('/api/calls', requireAuth, callRoutes);
  app.use('/api/sequences', requireAuth, sequenceRoutes);
  app.use('/api/follow-ups', requireAuth, followUpRoutes);
  app.use('/api/opportunities', requireAuth, opportunityRoutes);
  app.use('/api/customers', requireAuth, customerRoutes);
  app.use('/api/documents', requireAuth, documentRoutes);
  app.use('/api/brokers', requireAuth, brokerRoutes);
  app.use('/api/loads', requireAuth, loadRoutes);
  app.use('/api/email', emailRoutes); // OAuth callback is reached by redirect; routes check auth themselves
  app.use('/api/automations', requireAuth, automationRoutes);
  app.use('/api/ai', requireAuth, aiRoutes);
  app.use('/api/teams', teamRoutes); // invitation preview is public
  app.use('/api/admin/setup', requireAuth, adminSetupRoutes);
  app.use('/api/admin', requireAuth, adminRoutes);
  app.use('/api/settings', requireAuth, settingsRoutes);
  app.use('/api/notifications', requireAuth, notificationRoutes);
  app.use('/api/telephony', telephonyRoutes); // Twilio callbacks are signature-verified; other routes require auth themselves
  app.use('/api/call-scripts', requireAuth, callScriptRoutes);
  app.use('/api/tokens', requireAuth, tokenRoutes);
  app.use('/api/tours', requireAuth, tourRoutes);
  app.use('/api/extension', requireAuth, extensionRoutes);
  app.use('/api/templates', requireAuth, templateRoutes);
  app.use('/api/invoices', requireAuth, invoiceRoutes);
  app.use('/api/push', requireAuth, pushRoutes);
  app.use('/api/calendar', requireAuth, calendarRoutes);
  app.use('/api/today', requireAuth, todayRoutes);
  app.use('/api/authority-kit', requireAuth, authorityKitRoutes);
  app.use('/api/truck-posts', requireAuth, truckPostRoutes);
  app.use('/api/onboarding', requireAuth, onboardingRoutes);
  app.use('/api/onboarding-links', requireAuth, onboardingLinkRoutes);
  app.use('/api/plan-eta', requireAuth, planEtaRoutes);

  app.use('/api', notFoundApi);

  // Built single-page client (static files were served above).
  if (hasClient) {
    // Read lazily: a client build that is being rewritten (vite empties dist first) must not crash startup.
    const indexFile = path.join(CLIENT_DIST, 'index.html');
    let indexTemplate = null;
    let builtAt = new Date();
    const loadIndex = () => {
      if (indexTemplate) return indexTemplate;
      try {
        indexTemplate = fs.readFileSync(indexFile, 'utf8');
        builtAt = fs.statSync(indexFile).mtime;
      } catch { indexTemplate = null; }
      return indexTemplate;
    };
    loadIndex();
    app.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robotsTxt()));
    app.get('/sitemap.xml', (req, res) => { loadIndex(); res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemapXml(builtAt)); });
    app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').set('Cache-Control', 'public, max-age=86400').send(JSON.stringify(webManifest())));
    // Every other path gets index.html with that page's title, description and link-preview tags.
    app.get('*', (req, res) => {
      const template = loadIndex();
      if (!template) return res.status(503).type('text/plain').set('Cache-Control', 'no-store').set('Retry-After', '5').send('The app is being updated. Reload in a moment.');
      const { body, status } = renderIndex(template, req.path);
      res.status(status).type('html').set('Cache-Control', 'no-cache').send(body);
    });
  } else {
    app.get('/', (req, res) => res.type('text').send('API is running. Build the client (cd client && npm run build) to serve the UI.'));
  }

  app.use(errorHandler);
  return app;
}
