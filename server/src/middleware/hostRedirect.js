import { config } from '../config.js';

/**
 * Old domains (REDIRECT_HOSTS, comma separated, e.g. "dispatchdesk.work.gd,www.dispatchdesk.work.gd") send every
 * request to the same path on APP_URL. 308 keeps the method and body, so links already sent in emails (portal,
 * tracking, unsubscribe, invites, calendar feeds) and API calls from installed browser extensions keep working.
 * Off when REDIRECT_HOSTS is empty. The app's own host is never redirected.
 */
export function hostRedirect({ hosts = process.env.REDIRECT_HOSTS, target = config.appUrl } = {}) {
  let own = '';
  try { own = new URL(target).hostname.toLowerCase(); } catch { /* no valid APP_URL: nothing to redirect to */ }
  const from = new Set(String(hosts || '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => h && h !== own));
  if (!own || !from.size) return (req, res, next) => next();
  return (req, res, next) => {
    if (!from.has(String(req.hostname || '').toLowerCase())) return next();
    res.set('Cache-Control', 'no-store');
    return res.redirect(308, `${target}${req.originalUrl}`);
  };
}
