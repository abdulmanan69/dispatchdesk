import { getSettings } from './settings.js';

/**
 * Optional parts of the site, switched in Admin → System settings: the community marketplace and the live training
 * program (seat requests and trainer messaging). The self-paced course library is part of the software and always on.
 */
export async function siteFeatures() {
  const s = await getSettings(['app.marketplace', 'app.trainingProgram']);
  return { marketplace: s['app.marketplace'] === 'true', trainingProgram: s['app.trainingProgram'] === 'true' };
}

/** Express middleware: 404 unless the named feature is on (as if the route did not exist). */
export function requireFeature(name) {
  return (req, res, next) => {
    siteFeatures().then((f) => (f[name] ? next() : res.status(404).json({ error: 'Not found' })), next);
  };
}
