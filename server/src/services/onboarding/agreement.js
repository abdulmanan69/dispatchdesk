import { sha256 } from '../../lib/crypto.js';

/**
 * Dispatch agreement template for carrier onboarding links: the built-in default text, merge fields and rendering.
 * The rendered text is stored on the link exactly as the carrier sees it, with its sha256 hash, so the signature is
 * bound to that text (the carrier sends the hash back when signing).
 */

export const DEFAULT_AGREEMENT_TITLE = 'Dispatch service agreement';

/** Merge fields an agreement template may use, with a short description for the editor. */
export const MERGE_FIELDS = [
  { key: 'carrier_company', label: 'Carrier company name' },
  { key: 'carrier_mc', label: 'Carrier MC number' },
  { key: 'carrier_dot', label: 'Carrier USDOT number' },
  { key: 'fee_percent', label: 'Dispatch fee %' },
  { key: 'dispatcher_name', label: 'Your name' },
  { key: 'dispatcher_company', label: 'Your team or company name' },
  { key: 'date', label: 'Today\'s date' },
];
const FIELD_KEYS = new Set(MERGE_FIELDS.map((f) => f.key));

export const MAX_TEMPLATE_CHARS = 30_000;
export const MAX_TITLE_CHARS = 150;

/**
 * Built-in template. Original, plain-language and deliberately generic: it is a starting point, not legal advice,
 * and the editor says so next to it.
 */
export const DEFAULT_AGREEMENT = `This dispatch service agreement is made on {{date}} between {{dispatcher_company}} ("Dispatcher") and {{carrier_company}}, MC {{carrier_mc}}, USDOT {{carrier_dot}} ("Carrier").

1. Services
Dispatcher will help Carrier find and book freight, negotiate rates with brokers and shippers, complete carrier setup packets, and handle related paperwork that Carrier asks for. Carrier decides which loads to haul. Dispatcher will not book a load without Carrier's approval.

2. Dispatch fee
Carrier will pay Dispatcher {{fee_percent}}% of the gross line haul rate of each load Dispatcher books for Carrier. Line haul is the rate paid for moving the load. It does not include amounts paid back to Carrier for costs it covered, such as lumper fees or tolls. Detention, layover and truck order not used (TONU) pay are included only when both parties agree in writing.

3. Invoicing and payment
Dispatcher will send Carrier a statement or invoice of dispatch fees each week for loads delivered the week before. Carrier will pay each invoice within 7 days of receiving it. A fee is earned when the load is delivered. If a load is canceled and Carrier is not paid for it, no fee is due for that load.

4. Carrier responsibilities
Carrier will:
- keep active operating authority and a valid USDOT number;
- carry the insurance required by law and by the brokers and shippers it hauls for, including auto liability and cargo coverage, and send current certificates when asked;
- follow all safety rules, including hours of service, drug and alcohol testing, vehicle maintenance and driver qualification;
- choose, employ, pay and control its own drivers and equipment;
- tell Dispatcher promptly about any change in its authority, insurance, equipment or availability.

5. Dispatcher is not a broker or carrier
Dispatcher acts only as Carrier's agent for finding and booking freight. Dispatcher is not a freight broker, freight forwarder or motor carrier. Dispatcher does not take possession of, or responsibility for, any freight and is not a party to the rate confirmations between Carrier and brokers or shippers. Carrier is responsible for the safe pickup, transport and delivery of every load it accepts, and for any claims that arise from them.

6. Independent businesses
Dispatcher and Carrier are independent contractors. This agreement does not make either party an employee, partner or joint venturer of the other. Each party pays its own taxes, expenses and insurance.

7. Acting for Carrier
Carrier allows Dispatcher to contact brokers and shippers and to send Carrier's setup paperwork on its behalf. Carrier signs its own rate confirmations unless it gives Dispatcher written permission for a specific load.

8. Confidentiality
Each party will keep the other's business information, including rates, customer contacts and documents, private and use it only for this agreement.

9. Term and termination
This agreement starts when it is signed and continues until either party ends it. Either party may end it for any reason with 7 days' written notice; email is enough. Fees for loads booked before the end date are still owed.

10. Whole agreement
This is the full agreement between the parties about dispatch services. Changes must be in writing and accepted by both parties. If a part of this agreement cannot be enforced, the rest still applies.

11. Electronic signatures
The parties agree that this agreement may be signed electronically and that an electronic signature has the same effect as a handwritten one.

Signatures
Dispatcher: {{dispatcher_name}}, for {{dispatcher_company}}
Carrier: signed electronically by the person named in the signature record of this agreement.`;

const FIELD_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Merge field names in the template that are not supported (they would reach the carrier as raw {{...}}). */
export function unknownFields(template) {
  const out = new Set();
  for (const m of String(template || '').matchAll(FIELD_RE)) if (!FIELD_KEYS.has(m[1])) out.add(m[1]);
  return [...out];
}

export const usesField = (template, key) => [...String(template || '').matchAll(FIELD_RE)].some((m) => m[1] === key);

/** "8" for 8, "7.5" for 7.5 (no trailing zeros). */
export const percentText = (n) => (n == null ? '' : String(Math.round(Number(n) * 100) / 100));

function dateText(tz, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', year: 'numeric', month: 'long', day: 'numeric' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(now);
  }
}

/** The dispatcher's business name: team name, else the profile company name, else their own name. */
export function dispatcherCompany(user) {
  return user?.teamMembership?.team?.name?.trim() || user?.companyName?.trim() || user?.name || '';
}

/** Values for the merge fields. Missing carrier numbers read "N/A" rather than leaving a gap in the contract. */
export function mergeValues({ user, carrier, feePercent, now = new Date() }) {
  return {
    carrier_company: carrier.companyName,
    carrier_mc: carrier.mcNumber || 'N/A',
    carrier_dot: carrier.dotNumber || 'N/A',
    fee_percent: percentText(feePercent),
    dispatcher_name: user.name,
    dispatcher_company: dispatcherCompany(user),
    date: dateText(user.timezone, now),
  };
}

/** Single pass: values are never re-scanned, so a carrier name containing "{{" cannot inject another field. */
export function renderAgreement(template, values) {
  return String(template).replace(FIELD_RE, (m, key) => (Object.hasOwn(values, key) ? String(values[key] ?? '') : m));
}

/** Line endings normalized so the hash does not depend on the browser that sent the template. */
export const normalizeText = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();

export const agreementHash = (text) => sha256(text);
