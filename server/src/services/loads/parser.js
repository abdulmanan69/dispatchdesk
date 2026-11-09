/**
 * Deterministic parser for load details pasted from a load board, rate confirmation or broker email.
 * No network calls. Returns the fields it could identify plus notes on what it could not.
 * Users paste text they are entitled to view; nothing is scraped.
 */

const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ON QC BC AB MB SK NS NB'.split(' '));

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

const EQUIPMENT_WORDS = [
  [/\b(reefer|refrigerated|temp[- ]?controlled)\b/i, 'reefer'],
  [/\b(step\s*deck|stepdeck)\b/i, 'step_deck'],
  [/\b(flat\s*bed|flatbed)\b/i, 'flatbed'],
  [/\b(power\s*only)\b/i, 'power_only'],
  [/\b(hot\s*shot|hotshot)\b/i, 'hotshot'],
  [/\b(conestoga)\b/i, 'conestoga'],
  [/\b(low\s*boy|lowboy|rgn)\b/i, 'lowboy'],
  [/\b(tanker)\b/i, 'tanker'],
  [/\b(box\s*truck|straight\s*truck)\b/i, 'box_truck'],
  [/\b(car\s*hauler|auto\s*carrier)\b/i, 'car_hauler'],
  [/\b(dry\s*van|van)\b/i, 'dry_van'],
];
// Load-board single-letter / short codes, only trusted as standalone tokens.
const EQUIPMENT_CODES = { V: 'dry_van', VR: 'dry_van', R: 'reefer', F: 'flatbed', FD: 'flatbed', SD: 'step_deck', PO: 'power_only', HS: 'hotshot', LB: 'lowboy', DD: 'lowboy' };

const num = (s) => Number(String(s).replace(/[,\s]/g, ''));
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function parseDates(text, now) {
  const found = [];
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  let m;
  while ((m = numeric.exec(text))) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    let year = m[3] ? Number(m[3]) : null;
    if (year != null && year < 100) year += 2000;
    found.push({ index: m.index, month, day, year });
  }
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
  while ((m = named.exec(text))) {
    found.push({ index: m.index, month: MONTHS[m[1].toLowerCase()], day: Number(m[2]), year: m[3] ? Number(m[3]) : null });
  }
  found.sort((a, b) => a.index - b.index);
  return found.map((d) => {
    let year = d.year ?? now.getFullYear();
    let date = new Date(Date.UTC(year, d.month, d.day, 12));
    // A year-less date more than 60 days in the past most likely refers to next year.
    if (d.year == null && date.getTime() < now.getTime() - 60 * 86400000) date = new Date(Date.UTC(year + 1, d.month, d.day, 12));
    return date.toISOString().slice(0, 10);
  });
}

const LABELS = /^.*\b(origin|pickup|pick up|pu|shipper|from|out of|destination|delivery|drop|dest|consignee|to|going to)\b\s*:?\s*/i;
// Only applied in the comma-less fallback, where the city boundary is ambiguous.
const NOISE = /^(?:(?:flatbed|reefer|dry|van|step|deck|power|only|hotshot|load|loads|the|a|an|full|partial|ftl|ltl)\s+)+/i;

function parseLocations(text) {
  const out = [];
  const re = /([A-Za-z][A-Za-z.' ]{1,28}?)\s*,\s*([A-Za-z]{2})\b(?:\s+\d{5})?/g;
  let m;
  while ((m = re.exec(text))) {
    const st = m[2].toUpperCase();
    if (!STATES.has(st)) continue;
    // Drop leading labels like "Origin:" / "Pickup" captured into the city.
    const city = m[1].replace(LABELS, '').trim();
    if (!city || city.length < 2) continue;
    out.push({ city: titleCase(city), state: st, index: m.index });
  }
  if (out.length >= 2) return out;
  // Fallback: "Dallas TX -> Atlanta GA" without commas.
  const arrow = /([A-Za-z][A-Za-z.' ]{1,28}?)\s+([A-Z]{2})\s*(?:->|→|=>|–|—| to )\s*([A-Za-z][A-Za-z.' ]{1,28}?)\s+([A-Z]{2})\b/;
  const a = text.match(arrow);
  if (a && STATES.has(a[2]) && STATES.has(a[4])) {
    const clean = (s) => s.replace(LABELS, '').replace(NOISE, '').trim();
    return [{ city: titleCase(clean(a[1])), state: a[2], index: 0 }, { city: titleCase(clean(a[3])), state: a[4], index: 1 }];
  }
  return out;
}

export function parseLoadText(raw, { now = new Date() } = {}) {
  const text = String(raw || '').replace(/\r/g, '').slice(0, 20000);
  const fields = {};
  const notes = [];

  const locs = parseLocations(text);
  if (locs[0]) { fields.originCity = locs[0].city; fields.originState = locs[0].state; }
  if (locs[1]) { fields.destCity = locs[1].city; fields.destState = locs[1].state; }
  if (locs.length < 2) notes.push('Could not find both origin and destination as "City, ST".');

  // Deadhead first so its number isn't mistaken for loaded miles.
  const dh = text.match(/\b(?:dh|deadhead)(?:[-\s]?(?:o|origin))?\s*[:=]?\s*\(?\s*(\d{1,4})\s*\)?\s*(?:mi|miles)?/i);
  if (dh) fields.deadheadMiles = num(dh[1]);

  const milesLabeled = text.match(/\b(?:loaded\s+miles|trip(?:\s+miles)?|miles|distance|mileage)\s*[:=]?\s*([\d,]{2,6})\b/i);
  const milesSuffix = [...text.matchAll(/\b([\d,]{2,6})\s*(?:mi|miles)\b/gi)].filter((m) => !(dh && m.index >= (dh.index ?? -1) && m.index <= (dh.index ?? -1) + dh[0].length));
  if (milesLabeled) fields.loadedMiles = num(milesLabeled[1]);
  else if (milesSuffix.length) fields.loadedMiles = num(milesSuffix[0][1]);
  if (fields.loadedMiles != null && fields.loadedMiles <= 0) delete fields.loadedMiles;

  // Total rate: a dollar amount not followed by "/mi" or "per mile".
  const dollars = [...text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)(?!\s*(?:\/\s*mi|per\s*mile|\/\s*mile|\s*rpm))/gi)].map((m) => num(m[1]));
  const rateLabeled = text.match(/\b(?:rate|pay|total|linehaul|all[- ]in)\s*[:=]?\s*\$?\s?([\d,]{3,7}(?:\.\d{1,2})?)\b(?!\s*(?:\/\s*mi|per\s*mile))/i);
  const rate = rateLabeled ? num(rateLabeled[1]) : dollars.filter((d) => d >= 100).sort((a, b) => b - a)[0];
  if (rate != null && rate > 0) fields.rateCents = Math.round(rate * 100);
  const rpm = text.match(/\$?\s?(\d{1,2}\.\d{1,2})\s*(?:\/\s*mi(?:le)?|per\s*mile|rpm)/i);
  if (rpm) fields.postedRatePerMile = Number(rpm[1]);
  if (fields.rateCents == null && fields.postedRatePerMile && fields.loadedMiles) {
    fields.rateCents = Math.round(fields.postedRatePerMile * fields.loadedMiles * 100);
    notes.push('Total rate computed from posted rate per mile × loaded miles.');
  }

  const weight = text.match(/\b([\d,.]+)\s*(k)?\s*(?:lbs?|pounds|#)(?![\w])/i) || text.match(/\bweight\s*[:=]?\s*([\d,.]+)\s*(k)?/i);
  if (weight) {
    let w = num(weight[1]);
    if (weight[2]) w *= 1000;
    if (w > 0 && w < 200000) fields.weightLbs = Math.round(w);
  }

  for (const [re, key] of EQUIPMENT_WORDS) {
    if (re.test(text)) { fields.equipment = key; break; }
  }
  if (!fields.equipment) {
    const codeLine = text.match(/\b(?:equip(?:ment)?|trailer|type)\s*[:=]?\s*([A-Z]{1,2})\b/);
    const token = codeLine?.[1] ?? text.split(/\s+/).find((t) => EQUIPMENT_CODES[t]);
    if (token && EQUIPMENT_CODES[token]) { fields.equipment = EQUIPMENT_CODES[token]; notes.push(`Equipment inferred from load-board code "${token}".`); }
  }

  const commodity = text.match(/\b(?:commodity|product|freight|cargo)\s*[:=]\s*([^\n]{2,80})/i);
  if (commodity) fields.commodity = commodity[1].trim();

  const ref = text.match(/\b(?:ref(?:erence)?|load\s*(?:#|no\.?|number|id)|pro|order)(?![a-z])\s*(?:#|no\.?|number)?\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{2,24})\b/i);
  if (ref && !/^(rate|miles?)$/i.test(ref[1])) fields.referenceNumber = ref[1];

  const mc = text.match(/\bMC\s*#?\s*:?\s*(\d{4,8})\b/i);
  if (mc) fields.brokerMc = mc[1];
  const broker = text.match(/\b(?:broker|company|posted by|contact)\s*[:=]\s*([^\n]{2,80})/i);
  if (broker) fields.brokerName = broker[1].replace(/\s*\bMC\s*#?\s*\d+.*/i, '').trim();
  const phone = text.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?:\s*(?:x|ext\.?)\s*\d+)?/);
  if (phone) fields.brokerPhone = phone[1];
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (email) fields.brokerEmail = email[0].toLowerCase();

  const dates = parseDates(text, now);
  if (dates[0]) fields.pickupDate = dates[0];
  if (dates[1]) fields.deliveryDate = dates[1];

  const expected = ['originCity', 'destCity', 'rateCents', 'loadedMiles', 'pickupDate', 'equipment', 'weightLbs'];
  const found = expected.filter((k) => fields[k] != null);
  const missing = expected.filter((k) => fields[k] == null);
  if (missing.includes('rateCents')) notes.push('No total rate found — enter the agreed rate manually.');
  if (missing.includes('loadedMiles')) notes.push('No mileage found — enter loaded miles to compute rate per mile.');

  return { fields, found, missing, confidence: Math.round((found.length / expected.length) * 100) / 100, notes };
}
