/**
 * Guess a document's type from its file name. Unclear names stay "other": a wrong guess (a W-9 filed as an
 * agreement) is worse than asking, so the upload row always shows the type for the user to confirm.
 */
const RULES = [
  ['lumper_receipt', /lumper/i],
  ['scale_ticket', /scale[-_ ]?ticket|weigh[-_ ]?ticket|cat[-_ ]?scale/i],
  ['fuel_receipt', /fuel[-_ ]?receipt/i],
  ['w9', /(^|[^a-z0-9])w[-_ ]?9([^0-9]|$)/i],
  ['coi', /(^|[^a-z])(coi|acord|insurance|certificate[-_ ]of[-_ ]insurance)([^a-z]|$)/i],
  ['rate_confirmation', /rate[-_ ]?con(firmation)?|(^|[^a-z])rc([^a-z]|$)|load[-_ ]?confirmation/i],
  ['pod', /(^|[^a-z])pod([^a-z]|$)|proof[-_ ]?of[-_ ]?delivery|delivery[-_ ]?receipt|signed[-_ ]?bol/i],
  ['bol', /(^|[^a-z])(bol|b[-_ ]?o[-_ ]?l)([^a-z]|$)|bill[-_ ]?of[-_ ]?lading/i],
  ['mc_authority', /(^|[^a-z])(mc|authority|operating[-_ ]?authority|fmcsa)([^a-z]|$)/i],
  ['agreement', /agreement|contract|dispatch[-_ ]?service/i],
  ['permit', /permit/i],
];

export function guessDocType(name, allowed) {
  const base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const hit = RULES.find(([, re]) => re.test(base))?.[0] || 'other';
  if (!allowed?.length) return hit;
  if (allowed.includes(hit)) return hit;
  return allowed.includes('other') ? 'other' : allowed[0];
}

/** Types that usually carry an expiry date. */
export const EXPIRING_TYPES = ['coi', 'mc_authority', 'permit', 'w9'];

/**
 * Paperwork that belongs to a load. Drivers also send lumper receipts, scale tickets and fuel receipts from the driver
 * link, so a load's document list must include them (the list is filtered by these types).
 */
export const LOAD_DOC_TYPES = ['rate_confirmation', 'bol', 'pod', 'lumper_receipt', 'scale_ticket', 'fuel_receipt', 'other'];

export const DOC_LABEL = {
  agreement: 'Dispatch agreement', mc_authority: 'MC authority', w9: 'W-9', coi: 'Certificate of insurance', permit: 'Permit',
  rate_confirmation: 'Rate confirmation', bol: 'BOL', pod: 'POD', lumper_receipt: 'Lumper receipt', scale_ticket: 'Scale ticket',
  fuel_receipt: 'Fuel receipt', voided_check: 'Voided check', noa: 'Notice of assignment', other: 'Other',
};
