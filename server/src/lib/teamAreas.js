import { HttpError } from './errors.js';

/**
 * Team work areas: which tools a team member uses. The team manager turns them on per member; a new salesperson
 * starts with Leads & sales, a new dispatcher with Dispatch. Everyone keeps the shared parts (carrier list and
 * carrier pages, click-to-call, notes, files, follow-ups, email, pipeline and customers).
 *
 * Owners and managers use every area, and so does a member whose list was never set (null, members from before
 * work areas existed) and anyone not in a team.
 */
export const AREAS = ['sales', 'dispatch'];
export const AREA_LABEL = { sales: 'Leads & sales', dispatch: 'Dispatch' };
/** The areas a member starts with for each team role. */
export const ROLE_AREAS = { sales: ['sales'], dispatcher: ['dispatch'] };
export const TEAM_ROLES = ['owner', 'manager', 'sales', 'dispatcher'];

export const parseAreas = (s) => [...new Set(String(s || '').split(',').map((x) => x.trim()).filter((a) => AREAS.includes(a)))];
export const formatAreas = (list) => AREAS.filter((a) => list.includes(a)).join(',');

/** The work areas a team membership may use. */
export function memberAreas(m) {
  if (!m || m.role === 'owner' || m.role === 'manager' || m.areas == null) return [...AREAS];
  return parseAreas(m.areas);
}

export const hasArea = (user, area) => memberAreas(user?.teamMembership).includes(area);

/**
 * Route guard for an area's tools. `methods` limits it to some HTTP methods (e.g. writes only, so pickers on shared
 * pages can still list things).
 */
export function requireArea(area, { methods = null } = {}) {
  return (req, res, next) => {
    if (!req.user || (methods && !methods.includes(req.method)) || hasArea(req.user, area)) return next();
    next(new HttpError(403, `Your team manager has not turned on ${AREA_LABEL[area]} for you. Ask them to add it on the Team page.`, { code: 'AREA_OFF', area }));
  };
}
