/**
 * Pure rules of the broker rate negotiation (no I/O, no clock). Every money value is integer cents.
 * The AI never decides a number: it writes the email text and reads the broker's reply; these functions decide what
 * to propose, and the limits [floor, target] are enforced here and nowhere else.
 */

export const STATUSES = ['draft', 'active', 'needs_review', 'agreed', 'walked_away', 'canceled'];
export const OPEN_STATUSES = ['draft', 'active', 'needs_review'];
export const CLOSED_STATUSES = ['agreed', 'walked_away', 'canceled'];
export const MODES = ['approve', 'auto'];
export const INTENTS = ['accept', 'counter', 'decline', 'question', 'other'];
export const MAX_ROUNDS_LIMIT = 10;
export const MAX_CENTS = 100_000_000; // $1,000,000: far above any truckload rate

const isCents = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_CENTS;

/** Round to the nearest $25 (2,500 cents). */
export const round25 = (cents) => Math.round(cents / 2500) * 2500;

/** Clamp a number of cents into [floor, target]. */
export const clamp = (cents, floor, target) => Math.min(target, Math.max(floor, cents));

/** True when cents is a whole number inside the limits (both ends included). */
export const insideLimits = (cents, floor, target) => isCents(cents) && cents >= floor && cents <= target;

/** "$2,150" (whole dollars) or "$2,150.50". */
export function usd(cents) {
  const n = Math.round(Number(cents)) / 100;
  const whole = Number.isInteger(n);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * Limits for a new negotiation.
 *   floor:  the dispatcher's walk-away, else the carrier's walk-away rate from its rules (fit.js negotiationNumbers).
 *   target: the dispatcher's target, else max(floor, offer x 1.10 rounded to $25, recent lane average when higher).
 * Returns { floorCents, targetCents, floorBasis, targetBasis } or { error } with a plain-language message.
 */
export function computeLimits({ offerCents = null, targetCents = null, floorCents = null, walkAwayCents = null, laneAvgCents = null } = {}) {
  for (const [k, v] of Object.entries({ offerCents, targetCents, floorCents })) {
    if (v != null && !isCents(v)) return { error: `${k} must be a whole number of cents` };
  }
  let floor = floorCents;
  let floorBasis = 'manual';
  if (floor == null && walkAwayCents != null && walkAwayCents > 0) {
    floor = Math.round(walkAwayCents);
    floorBasis = 'carrier_rules';
  }
  if (floor == null || floor <= 0) return { error: 'Enter a walk-away rate (the carrier has no rate rules to work it out from)' };

  let target = targetCents;
  let targetBasis = 'manual';
  if (target == null) {
    const candidates = [['floor', floor]];
    if (offerCents != null && offerCents > 0) candidates.push(['offer_plus_10', round25(offerCents * 1.1)]);
    if (laneAvgCents != null && laneAvgCents > 0) candidates.push(['lane_average', Math.round(laneAvgCents)]);
    [targetBasis, target] = candidates.reduce((best, c) => (c[1] > best[1] ? c : best));
  }
  if (target < floor) return { error: 'The target cannot be below the walk-away rate' };
  if (offerCents != null && offerCents > 0 && target <= offerCents) {
    return { error: `The broker already offers ${usd(offerCents)}, which meets your target. Book it at the offered rate instead.` };
  }
  return { floorCents: floor, targetCents: target, floorBasis, targetBasis };
}

/**
 * Our next counter after the broker countered below the floor: halfway between their number and our last counter,
 * rounded to $25, never below the floor and never above our last counter or the target.
 */
export function nextCounter({ theirCents, lastCounterCents, floorCents, targetCents }) {
  const top = Math.min(targetCents, lastCounterCents ?? targetCents);
  const mid = theirCents != null ? round25((theirCents + top) / 2) : top;
  return clamp(Math.min(mid, top), floorCents, Math.max(floorCents, top));
}

/**
 * What to propose after the broker's reply. Enforced in code, whatever the AI said:
 *   accept, or a counter at/above the floor  -> { kind: 'accept', cents }  (the dispatcher books it; never automatic)
 *   counter below the floor, rounds left     -> { kind: 'counter', cents } between their number and our last counter
 *   counter below the floor, no rounds left  -> { kind: 'walk_away', reason: 'rounds' }
 *   decline                                   -> { kind: 'walk_away', reason: 'declined' }
 *   question                                  -> { kind: 'answer' }
 *   anything else, or no number to work with  -> { kind: 'review' }  (nothing proposed; the dispatcher decides)
 */
export function decide({ intent, cents = null, floorCents, targetCents, lastCounterCents = null, offerCents = null, rounds = 0, maxRounds = 3 }) {
  const c = isCents(cents) && cents > 0 ? cents : null;
  if (intent === 'accept') {
    const agreed = c ?? lastCounterCents ?? offerCents;
    if (agreed == null) return { kind: 'review', reason: 'They seem to agree, but no rate was found in their reply' };
    if (agreed >= floorCents) return { kind: 'accept', cents: agreed, reason: 'The broker agreed to a rate at or above your walk-away' };
    return decide({ intent: 'counter', cents: agreed, floorCents, targetCents, lastCounterCents, offerCents, rounds, maxRounds });
  }
  if (intent === 'counter') {
    if (c == null) return { kind: 'review', reason: 'They countered, but no rate was found in their reply' };
    if (c >= floorCents) return { kind: 'accept', cents: c, reason: 'The broker offered a rate at or above your walk-away' };
    if (rounds >= maxRounds) return { kind: 'walk_away', reason: 'rounds', theirCents: c };
    return { kind: 'counter', cents: nextCounter({ theirCents: c, lastCounterCents, floorCents, targetCents }), theirCents: c, reason: 'Their offer is below your walk-away' };
  }
  if (intent === 'decline') return { kind: 'walk_away', reason: 'declined' };
  if (intent === 'question') return { kind: 'answer', reason: 'The broker asked a question' };
  return { kind: 'review', reason: 'The reply needs a look from you' };
}

/** Sanitize a classification from the AI into { intent, cents, summary }. */
export function cleanClassification(raw) {
  const intent = INTENTS.includes(raw?.intent) ? raw.intent : 'other';
  let cents = raw?.cents;
  if (typeof cents === 'string') cents = Number(cents.replace(/[^\d.]/g, ''));
  cents = Number.isFinite(cents) ? Math.round(cents) : null;
  // Anything under $50 is not a truckload rate (likely a per-mile figure or a misread): treat as no number.
  if (cents != null && (cents < 5000 || cents > MAX_CENTS)) cents = null;
  const summary = String(raw?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { intent, cents, summary };
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?k\b)?/gi;

/** Dollar amounts written in a text, in cents ("$2,150" -> 215000, "$2.5k" -> 250000). */
export function amountsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MONEY)) {
    const whole = Number(m[1].replace(/,/g, ''));
    const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
    let cents = whole * 100 + frac;
    if (m[3]) cents = Math.round((whole + frac / 100) * 1000) * 100;
    out.push(cents);
  }
  return out;
}

/** True when every dollar amount in the text is one of the allowed amounts (cents). */
export function onlyAllowedAmounts(text, allowed) {
  const ok = new Set(allowed.filter((v) => v != null));
  return amountsIn(text).every((c) => ok.has(c));
}

/** Short history entry list: keep the newest `max` entries. */
export function pushHistory(list, entry, { now = new Date(), max = 200 } = {}) {
  const next = [...(Array.isArray(list) ? list : []), { at: now.toISOString(), ...entry }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** When the dispatcher last heard from the broker, and when we last emailed (ISO strings or null). */
export function lastExchange(history = []) {
  let sentAt = null;
  let replyAt = null;
  for (const h of history) {
    if (h.kind === 'sent' && (!sentAt || h.at > sentAt)) sentAt = h.at;
    if (h.from === 'broker' && (!replyAt || h.at > replyAt)) replyAt = h.at;
  }
  return { sentAt, replyAt };
}
