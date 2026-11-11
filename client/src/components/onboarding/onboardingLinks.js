/** Shared labels for carrier onboarding links (dispatcher side). */

export const ONBOARDING_DOCS = [
  ['w9', 'W-9'],
  ['coi', 'Certificate of insurance'],
  ['mc_authority', 'MC authority letter'],
  ['voided_check', 'Voided check'],
  ['noa', 'Notice of assignment (factoring)'],
];
export const ONBOARDING_DOC_LABEL = Object.fromEntries(ONBOARDING_DOCS);
export const DEFAULT_DOCS = ['w9', 'coi', 'mc_authority'];

export const LINK_STATUS = {
  pending: { label: 'Sent', color: 'blue' },
  viewed: { label: 'Opened', color: 'amber' },
  signed: { label: 'Signed', color: 'green' },
  revoked: { label: 'Turned off', color: 'gray' },
  expired: { label: 'Expired', color: 'gray' },
};

export const LINK_DAYS = [3, 7, 14, 30];

export const recordUrl = (id) => `/api/onboarding-links/${encodeURIComponent(id)}/record`;

/** Insert `text` into a textarea's value at the cursor (or replace the selection). Returns { value, cursor }. */
export function insertAt(value, text, start, end = start) {
  const s = Math.max(0, Math.min(start ?? value.length, value.length));
  const e = Math.max(s, Math.min(end ?? s, value.length));
  return { value: value.slice(0, s) + text + value.slice(e), cursor: s + text.length };
}
