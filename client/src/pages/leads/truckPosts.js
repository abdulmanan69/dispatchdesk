/** Most brokers one post may go to (server: MAX_BROKERS in routes/truckPosts.js). */
export const MAX_BROKERS = 30;

/** Merge fields offered as one-click inserts on the post form. */
export const POST_TOKENS = ['first_name', 'company', 'equipment', 'truck_location', 'available_date', 'preferred_lanes', 'target_rate', 'truck_details', 'carrier_company', 'carrier_mc', 'my_phone', 'signature'];

/**
 * Form fields that override what is stored about the truck (sent as `details`). The form starts empty and shows the
 * stored values as placeholders, so an untouched field keeps the stored value.
 */
export const EMPTY_FORM = { location: '', availableAt: '', equipment: '', lanes: '', rate: '', details: '' };

/** `details` for the API: only fields the user filled in (the server fills the rest from the truck). */
export function detailsPayload(form) {
  const out = {};
  for (const k of ['location', 'equipment', 'lanes', 'rate', 'details']) {
    const v = String(form[k] || '').trim();
    if (v) out[k] = v;
  }
  if (form.availableAt) {
    const d = new Date(form.availableAt);
    if (!Number.isNaN(d.getTime())) out.availableAt = d.toISOString();
  }
  return out;
}

/** Values the template picker fills truck fields with: the draft's stored values, overridden by the form. */
export function pickerExtra(values = {}, form = EMPTY_FORM, formatDate = (d) => d.toLocaleString()) {
  const extra = { ...values };
  const map = { location: 'truck_location', equipment: 'equipment', lanes: 'preferred_lanes', rate: 'target_rate', details: 'truck_details' };
  for (const [k, field] of Object.entries(map)) {
    const v = String(form[k] || '').trim();
    if (v) extra[field] = v;
  }
  if (form.availableAt) {
    const d = new Date(form.availableAt);
    if (!Number.isNaN(d.getTime())) extra.available_date = formatDate(d);
  }
  return extra;
}

/** Delivery status of one truck-post email, for the history list. */
export const POST_STATUS = {
  scheduled: ['blue', 'Queued'],
  draft: ['gray', 'Draft'],
  sending: ['amber', 'Sending'],
  sent: ['green', 'Sent'],
  replied: ['teal', 'Replied'],
  bounced: ['red', 'Bounced'],
  failed: ['red', 'Failed'],
  canceled: ['gray', 'Canceled'],
  removed: ['gray', 'Deleted'],
};
export const postStatus = (s) => POST_STATUS[s] || ['gray', s ? String(s) : 'Unknown'];

/** "TX to GA (3), GA to TX (1)" from a broker's lanes. */
export function lanesLabel(lanes = [], max = 3) {
  return lanes.slice(0, max).map((l) => `${l.from} to ${l.to} (${l.loads})`).join(', ');
}

/** Why the send button is disabled (null when ready). */
export function sendBlocker({ truck, brokerCount, subject, body }) {
  if (!truck) return 'Pick a truck';
  if (!brokerCount) return 'Pick at least one broker';
  if (brokerCount > MAX_BROKERS) return `Pick at most ${MAX_BROKERS} brokers per post`;
  if (!String(subject || '').trim() || !String(body || '').trim()) return 'Write a subject and a message';
  return null;
}
