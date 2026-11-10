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
import { loadSession, requireAuth } from './middleware/auth.js';
import { csrf, apiLimiter } from './middleware/security.js';
import { errorHandler, notFoundApi } from './middleware/error.js';

import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = process.env.CLIENT_DIST || path.resolve(__dirname, '../../client/dist');

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
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
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

  // gzip JSON and static assets (skips already-compressed types and server-sent streams).
  app.use(compression({ filter: (req, res) => !String(res.getHeader('Content-Type') || '').includes('text/event-stream') && compression.filter(req, res) }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());
  app.use(csrf);
  app.use('/api', apiLimiter);
  app.use(loadSession);

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

  app.use('/api', notFoundApi);

  // Built single-page client.
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    const indexTemplate = fs.readFileSync(path.join(CLIENT_DIST, 'index.html'), 'utf8');
    const builtAt = fs.statSync(path.join(CLIENT_DIST, 'index.html')).mtime;
    app.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robotsTxt()));
    app.get('/sitemap.xml', (req, res) => res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemapXml(builtAt)));
    app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').set('Cache-Control', 'public, max-age=86400').send(JSON.stringify(webManifest())));
    // Every other path gets index.html with that page's title, description and link-preview tags.
    app.get('*', (req, res) => {
      const { body, status } = renderIndex(indexTemplate, req.path);
      res.status(status).type('html').set('Cache-Control', 'no-cache').send(body);
    });
  } else {
    app.get('/', (req, res) => res.type('text').send('API is running. Build the client (cd client && npm run build) to serve the UI.'));
  }

  app.use(errorHandler);
  return app;
}
