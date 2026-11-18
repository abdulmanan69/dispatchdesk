/**
 * Team work areas (server: lib/teamAreas.js). A team manager turns "Leads & sales" and "Dispatch" on per member;
 * the pages of an area leave the menu and show a notice for members without it. Anyone not in a team, owners,
 * managers and members whose areas were never set use everything.
 */
export const AREAS = ['sales', 'dispatch'];
export const AREA_LABEL = { sales: 'Leads & sales', dispatch: 'Dispatch' };
export const AREA_HELP = {
  sales: 'Lead generator, find carriers, new authority, CSV import, prospecting, power dialer, call scripts, sequences, opportunities and automations',
  dispatch: 'Today, loads, fleet map, brokers, invoices, reports, truck posts and dispatch tools',
};

/** App pages that belong to an area (a page and everything under it). */
export const AREA_PATHS = {
  sales: ['/app/lead-generator', '/app/discover', '/app/new-authority', '/app/import', '/app/prospecting', '/app/dialer', '/app/call-scripts', '/app/sequences', '/app/opportunities', '/app/automations'],
  dispatch: ['/app/today', '/app/brokers', '/app/fleet', '/app/loads', '/app/invoices', '/app/reports', '/app/truck-posts', '/app/tools'],
};

export const hasArea = (user, area) => {
  const areas = user?.team?.areas;
  return !Array.isArray(areas) || areas.includes(area);
};

/** The area an app path belongs to, or null for shared pages. */
export function areaOfPath(path) {
  for (const area of AREAS) {
    if (AREA_PATHS[area].some((p) => path === p || path.startsWith(`${p}/`))) return area;
  }
  return null;
}
