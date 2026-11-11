/** Registration windows (server: MILESTONES in services/carriers/readiness.js). */
export const WINDOWS = [
  { key: 'new7', label: 'Last 7 days', long: 'Registered in the last 7 days' },
  { key: 'new30', label: 'Last 30 days', long: 'Registered in the last 30 days' },
  { key: 'new90', label: 'Last 90 days', long: 'Registered in the last 90 days' },
  { key: 'new180', label: 'Last 180 days', long: 'Registered in the last 180 days' },
  { key: 'turning90', label: 'Reaching 90 days', long: 'Reaching 90 days in the next 7 days' },
  { key: 'turning180', label: 'Reaching 180 days', long: 'Reaching 180 days in the next 7 days' },
];

/** Equipment the census implies through cargo classes (server: EQUIPMENT_FROM_CARGO in fmcsaCensus.js). */
export const EQUIPMENT_FROM_CARGO = ['reefer', 'flatbed', 'tanker', 'car_hauler'];

/** "Registered today", "1 day ago", "23 days ago". */
export function ageLabel(days) {
  if (days == null) return 'Date unknown';
  if (days === 0) return 'Today';
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** mine: in the user's CRM; team: a teammate has it; new: nobody on the team has it. */
export function rowStatus(r) {
  if (r.existsInCrm && r.existingId) return 'mine';
  if (r.teamClaims?.length) return 'team';
  return 'new';
}

/** Toast text for a claim result. */
export function claimSummary(d) {
  const parts = [`Added ${d.created} to your list`];
  if (d.skipped) parts.push(`${d.skipped} already there`);
  if (d.limited) parts.push(`${d.limited} over your plan limit`);
  if (d.notFound) parts.push(`${d.notFound} not found in the census`);
  if (d.sequence) parts.push(`${d.enrolled} added to ${d.sequence.name}`);
  return parts.join(' · ');
}
