import { facilityTimezone } from './facilityTz.js';

/**
 * Deterministic parser for load details pasted from a load board, rate confirmation or broker email, or extracted
 * from a rate-con PDF in the browser (the PDF itself never reaches the server for parsing).
 * No network calls. Returns the fields it could identify plus notes on what it could not.
 * Users paste text they are entitled to view; nothing is scraped.
 *
 * Besides the lane, rate, miles, weight and equipment it reads, when present:
 *   pickup/delivery facility, street address, appointment window ("11/12 08:00-14:00", "FCFS 7:00 AM to 3:00 PM"),
 *   PO/PU/BOL numbers, detention free time and $/hr, TONU, layover, lumper, payment terms, trailer length,
 *   hazmat/TWIC/team requirements and the broker contact block.
 * Appointment times are facility-local wall times ('YYYY-MM-DDTHH:mm') with the facility's IANA zone (pickupTz,
 * deliveryTz) resolved offline from city and state.
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
const pad = (n) => String(n).padStart(2, '0');

function dateMatches(text) {
  const found = [];
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  let m;
  while ((m = numeric.exec(text))) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    let year = m[3] ? Number(m[3]) : null;
    if (year != null && year < 100) year += 2000;
    found.push({ index: m.index, end: m.index + m[0].length, month, day, year });
  }
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) {
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    found.push({ index: m.index, end: m.index + m[0].length, month, day, year: Number(m[1]) });
  }
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
  while ((m = named.exec(text))) {
    found.push({ index: m.index, end: m.index + m[0].length, month: MONTHS[m[1].toLowerCase()], day: Number(m[2]), year: m[3] ? Number(m[3]) : null });
  }
  return found.sort((a, b) => a.index - b.index);
}

function toYmd(d, now) {
  const year = d.year ?? now.getFullYear();
  let date = new Date(Date.UTC(year, d.month, d.day, 12));
  // A year-less date more than 60 days in the past most likely refers to next year.
  if (d.year == null && date.getTime() < now.getTime() - 60 * 86400000) date = new Date(Date.UTC(year + 1, d.month, d.day, 12));
  return date.toISOString().slice(0, 10);
}

function parseDates(text, now) {
  return dateMatches(text).map((d) => toYmd(d, now));
}

const LABELS = /^.*\b(origin|pickup|pick up|pu|shipper|from|out of|destination|delivery|drop|dest|consignee|to|going to)\b\s*:?\s*/i;
// Only applied in the comma-less fallback, where the city boundary is ambiguous.
const NOISE = /^(?:(?:flatbed|reefer|dry|van|step|deck|power|only|hotshot|load|loads|the|a|an|full|partial|ftl|ltl)\s+)+/i;

function parseLocations(text) {
  const out = [];
  const re = /([A-Za-z][A-Za-z.' ]{1,28}?)\s*,\s*([A-Za-z]{2})\b(?:\s+(\d{5}))?/g;
  let m;
  while ((m = re.exec(text))) {
    const st = m[2].toUpperCase();
    if (!STATES.has(st)) continue;
    // Drop leading labels like "Origin:" / "Pickup" captured into the city.
    const city = m[1].replace(LABELS, '').trim();
    if (!city || city.length < 2) continue;
    out.push({ city: titleCase(city), state: st, zip: m[3] || null, index: m.index, end: m.index + m[0].length });
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

// ---------------------------------------------------------------------------
// Stops (rate confirmation layout)
// ---------------------------------------------------------------------------

const STOP_PREFIX = String.raw`^\s*(?:stop\s*#?\s*\d{1,2}\s*[:\-–]?\s*)?`;
const STOP_SUFFIX = String.raw`(?:\s*#?\s*\d{1,2}(?:\s*of\s*\d{1,2})?)?(?:\s+(?:information|info|location|details|address|facility|stop))?\s*(?::|-|–|\t|\s{2,}|$)`;
const PICK_HEADER = new RegExp(`${STOP_PREFIX}(?:pick\\s*-?\\s*up|pickup|p\\/u|pu|shipper|origin|ship\\s*from|loading|load\\s+at)${STOP_SUFFIX}`, 'i');
const DROP_HEADER = new RegExp(`${STOP_PREFIX}(?:delivery|deliver\\s+to|consignee|receiver|drop(?:\\s*-?\\s*off)?|destination|ship\\s*to|unloading|unload\\s+at|stop\\s*off)${STOP_SUFFIX}`, 'i');
const ANY_STOP = /^\s*stop\s*#?\s*\d{1,2}\s*(?::|-|–|\t|\s{2,}|$)/i;
const SECTION_END = /^\s*(?:rate|rates|charges|carrier\s+pay|total|line\s*haul|linehaul|payment|pay\s+terms|terms|notes?|special\s+instructions|instructions|broker|carrier|driver|equipment|commodity|accessorials?|fuel|signature|agreed)\b/i;
const STREET = /\b\d{1,6}[A-Za-z]?\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.'# -]{1,50}?\b(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|hwy|highway|pkwy|parkway|ln|lane|way|ct|court|pl|place|cir|circle|trl|trail|pike|loop|row|sq|square|ter|terrace|expy|expressway|fwy|freeway|industrial|commerce|park)\b\.?(?:\s*(?:#|ste\.?|suite|unit|bldg|dock)\s*[\w-]+)?/i;
const LABEL_LINE = /^\s*([A-Za-z][A-Za-z ./#]{1,30}?)\s*[:=]\s*(.*)$/;
const NAME_LABELS = /^(?:name|facility|location|company|shipper|consignee|receiver|pick\s*up\s+at|deliver\s+to|ship\s+(?:from|to))$/i;
const REF_RE = /\b(PO|P\.O\.|PU|pick\s*up|pickup|BOL|B\/L|SO|delivery|del|appt|appointment|confirmation|conf|ref|reference|order|release)\s*(?:#|no\.?|number|num)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,24})\b/gi;
const PHONE_G = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/**
 * Times in a line of text: "08:00", "8:00 AM", "8am", "0800-1400". Bare 4-digit times count only in a time context
 * (a range, a label such as "appt", or right after a date like "11/21 1300"), so zip codes and street numbers do not.
 */
function timesIn(s) {
  const out = [];
  const re = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|a|p)?\b|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)|\b([01]\d|2[0-3])([0-5]\d)\b(?=\s*(?:-|–|to|hrs?\b|h\b))|(?<=(?:-|–|to)\s*)\b([01]\d|2[0-3])([0-5]\d)\b|(?<=\b(?:time|appt|appointment|at|@|open|from|hours)\s*:?\s*)\b([01]\d|2[0-3])([0-5]\d)\b|(?<=\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s+)([01]\d|2[0-3])([0-5]\d)\b/gi;
  let m;
  while ((m = re.exec(s))) {
    let h; let min; let ap = '';
    if (m[1] != null) { h = Number(m[1]); min = Number(m[2]); ap = m[3] || ''; }
    else if (m[4] != null) { h = Number(m[4]); min = 0; ap = m[5] || ''; }
    else if (m[6] != null) { h = Number(m[6]); min = Number(m[7]); }
    else if (m[8] != null) { h = Number(m[8]); min = Number(m[9]); }
    else if (m[10] != null) { h = Number(m[10]); min = Number(m[11]); }
    else { h = Number(m[12]); min = Number(m[13]); }
    ap = ap.toLowerCase().replace(/\./g, '');
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    if (h > 23 || min > 59) continue;
    out.push({ index: m.index, value: `${pad(h)}:${pad(min)}` });
  }
  return out;
}

const pickupType = (line) => (PICK_HEADER.test(line) ? 'pickup' : DROP_HEADER.test(line) ? 'delivery' : ANY_STOP.test(line) ? 'stop' : null);
const headerRest = (line) => {
  const m = line.match(PICK_HEADER) || line.match(DROP_HEADER) || line.match(ANY_STOP);
  return m ? line.slice(m[0].length).trim() : line;
};

/** Split the text into stop sections: [{ type: 'pickup'|'delivery'|'stop', lines: [...] }]. Side-by-side columns are split on tabs. */
function stopSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  let columns = null; // [pickupSection, deliverySection] while a two-column block lasts
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const cells = line.split(/\t+/).map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2 && pickupType(cells[0]) && pickupType(cells[1])) {
      const a = { type: pickupType(cells[0]), lines: [headerRest(cells[0])].filter(Boolean) };
      const b = { type: pickupType(cells[1]), lines: [headerRest(cells[1])].filter(Boolean) };
      sections.push(a, b);
      columns = [a, b];
      current = null;
      continue;
    }
    if (columns) {
      if (cells.length >= 2 && !SECTION_END.test(cells[0])) {
        columns[0].lines.push(cells[0]);
        columns[1].lines.push(cells.slice(1).join(' '));
        continue;
      }
      columns = null;
    }
    const type = pickupType(line);
    if (type) {
      current = { type, lines: [] };
      const rest = headerRest(line);
      if (rest) current.lines.push(rest);
      sections.push(current);
      continue;
    }
    if (current) {
      if (SECTION_END.test(line) || current.lines.length >= 14) { current = null; continue; }
      current.lines.push(line.trim());
    }
  }
  return sections.filter((s) => s.lines.length);
}

function parseStop(section, now) {
  const text = section.lines.join('\n');
  const stop = { type: section.type, city: null, state: null, zip: null, facility: null, address: null, date: null, start: null, end: null, fcfs: false, refs: [] };
  const loc = parseLocations(text)[0];
  if (loc) { stop.city = loc.city; stop.state = loc.state; stop.zip = loc.zip || null; }

  let street = null;
  for (const line of section.lines) {
    const label = line.match(LABEL_LINE);
    if (label && NAME_LABELS.test(label[1].trim()) && label[2].trim() && !stop.facility && !parseLocations(label[2])[0]) stop.facility = label[2].trim().slice(0, 120);
    if (!street) {
      const sm = line.match(STREET);
      if (sm) street = sm[0].trim().replace(/[,\s]+$/, '');
    }
  }
  if (!stop.facility) {
    // First plain line that is not an address, a city line, a date/time or a labelled value.
    const candidate = section.lines.find((line) => /[A-Za-z]{3}/.test(line) && !STREET.test(line) && !parseLocations(line)[0]
      && !LABEL_LINE.test(line) && !dateMatches(line).length && !timesIn(line).length && !/\b(fcfs|appt|appointment|first come|hours|open)\b/i.test(line) && line.length <= 80);
    if (candidate) stop.facility = candidate.replace(/[,\s]+$/, '').slice(0, 120);
  }
  if (street) stop.address = [street, stop.city && stop.state ? `${stop.city}, ${stop.state}${stop.zip ? ` ${stop.zip}` : ''}` : null].filter(Boolean).join(', ').slice(0, 200);

  const dates = dateMatches(text);
  if (dates[0]) stop.date = toYmd(dates[0], now);
  // Times after the first date (or anywhere in the section when there is no date); zip codes and street numbers are not times.
  const times = section.lines.flatMap((line) => (STREET.test(line) && !/\b(appt|appointment|time|hours|fcfs)\b/i.test(line) ? [] : timesIn(line.replace(PHONE_G, ' '))));
  if (times[0]) stop.start = times[0].value;
  if (times[1]) stop.end = times[1].value;
  if (/\b(fcfs|first\s+come)\b/i.test(text)) stop.fcfs = true;
  for (const m of text.matchAll(REF_RE)) {
    const kind = m[1].toUpperCase().replace(/\s+/g, ' ').replace('P.O.', 'PO').replace('PICK UP', 'PU').replace('PICKUP', 'PU');
    if (!stop.refs.some((r) => r.value === m[2])) stop.refs.push({ kind, value: m[2] });
  }
  return stop;
}

/** Pickup = first pickup section (or first stop), delivery = last delivery section (or last stop). */
export function parseStops(text, now = new Date()) {
  const stops = stopSections(text).map((s) => parseStop(s, now)).filter((s) => s.city || s.facility || s.address || s.date);
  if (!stops.length) return { pickup: null, delivery: null, extra: [] };
  const pickup = stops.find((s) => s.type === 'pickup') || (stops[0].type !== 'delivery' ? stops[0] : null);
  const deliveries = stops.filter((s) => s.type === 'delivery');
  const delivery = deliveries[deliveries.length - 1] || (stops.length > 1 && stops[stops.length - 1] !== pickup ? stops[stops.length - 1] : null);
  const extra = stops.filter((s) => s !== pickup && s !== delivery);
  return { pickup, delivery, extra };
}

const local = (date, time) => (date && time ? `${date}T${time}` : null);

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

function parseTerms(text) {
  const terms = {};
  const det = text.match(/detention[^\n$]{0,60}?\$\s?(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/|per\s*)\s*(?:hr|hour)/i) || text.match(/\$\s?(\d{1,3}(?:\.\d{1,2})?)\s*(?:\/|per\s*)\s*(?:hr|hour)[^\n]{0,40}detention/i);
  if (det) terms.detentionRateCents = Math.round(Number(det[1]) * 100);
  const free = text.match(/(\d{1,2}(?:\.\d)?)\s*(?:hrs?|hours?)\s*(?:of\s+)?free(?:\s+time)?/i)
    || text.match(/free\s*time[^\d\n]{0,20}(\d{1,2}(?:\.\d)?)\s*(?:hrs?|hours?)/i)
    || text.match(/detention[^\n]{0,60}?after\s*(?:the\s+(?:first\s+)?)?(\d{1,2}(?:\.\d)?)\s*(?:hrs?|hours?)/i);
  if (free) {
    const h = Number(free[1]);
    if (h >= 0 && h <= 24) terms.freeTimeHours = h;
  }
  const tonu = text.match(/\b(?:TONU|truck\s+ordered\s+not\s+used)\b[^\n$]{0,40}\$\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (tonu) terms.tonuCents = Math.round(num(tonu[1]) * 100);
  const layover = text.match(/\blayover\b[^\n$]{0,40}\$\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (layover) terms.layoverCents = Math.round(num(layover[1]) * 100);
  const lumper = text.match(/\blumper\b[^\n]{0,100}/i);
  if (lumper) terms.lumper = lumper[0].trim().slice(0, 140);
  const pay = text.match(/\b(quick\s*pay[^\n]{0,40}|\d{1,2}(?:\.\d)?\s*%\s*quick\s*pay|net\s*-?\s*\d{1,3}(?:\s*days)?)\b/i);
  if (pay) terms.paymentTerms = pay[1].replace(/\s+/g, ' ').trim().slice(0, 80);
  const trailer = text.match(/\b(53|48|45|40|28)\s*(?:'|’|ft\b|foot\b|feet\b)/i);
  if (trailer) terms.trailerLengthFt = Number(trailer[1]);
  const requirements = [];
  if (/\b(haz\s?mat|hazardous\s+materials?|placard(?:ed|s)?)\b/i.test(text) && !/\bnon[- ]?haz/i.test(text)) requirements.push('hazmat');
  if (/\bTWIC\b/.test(text)) requirements.push('TWIC');
  if (/\bteam\s+(?:drivers?|only|required|load|service)\b/i.test(text)) requirements.push('team drivers');
  if (requirements.length) terms.requirements = requirements;
  return terms;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function parseLoadText(raw, { now = new Date() } = {}) {
  const text = String(raw || '').replace(/\r/g, '').slice(0, 20000);
  const fields = {};
  const notes = [];

  const stops = parseStops(text, now);
  const locs = parseLocations(text);
  const p = stops.pickup;
  const d = stops.delivery;
  if (p?.city && d?.city) {
    Object.assign(fields, { originCity: p.city, originState: p.state, destCity: d.city, destState: d.state });
  } else {
    if (locs[0]) { fields.originCity = locs[0].city; fields.originState = locs[0].state; }
    if (locs[1]) { fields.destCity = locs[1].city; fields.destState = locs[1].state; }
    if (p?.city) { fields.originCity = p.city; fields.originState = p.state; }
    if (d?.city) { fields.destCity = d.city; fields.destState = d.state; }
  }
  if (!fields.originCity || !fields.destCity) notes.push('Could not find both origin and destination as "City, ST".');

  // Deadhead first so its number isn't mistaken for loaded miles.
  const dh = text.match(/\b(?:dh|deadhead)(?:[-\s]?(?:o|origin))?\s*[:=]?\s*\(?\s*(\d{1,4})\s*\)?\s*(?:mi|miles)?/i);
  if (dh) fields.deadheadMiles = num(dh[1]);

  const milesLabeled = text.match(/\b(?:loaded\s+miles|trip(?:\s+miles)?|miles|distance|mileage)\s*[:=]?\s*([\d,]{2,6})\b/i);
  const milesSuffix = [...text.matchAll(/\b([\d,]{2,6})\s*(?:mi|miles)\b/gi)].filter((m) => !(dh && m.index >= (dh.index ?? -1) && m.index <= (dh.index ?? -1) + dh[0].length));
  if (milesLabeled) fields.loadedMiles = num(milesLabeled[1]);
  else if (milesSuffix.length) fields.loadedMiles = num(milesSuffix[0][1]);
  if (fields.loadedMiles != null && fields.loadedMiles <= 0) delete fields.loadedMiles;

  // Total rate: the labelled carrier total first, then a "Rate:" style label, then the largest plain dollar amount.
  const dollars = [...text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)(?!\s*(?:\/\s*mi|per\s*mile|\/\s*mile|\s*rpm|\/\s*h(?:ou)?r|per\s*h(?:ou)?r))/gi)].map((m) => num(m[1]));
  const totalLabeled = text.match(/\b(?:total\s+(?:carrier\s+)?(?:pay|rate|amount|charges|cost)|carrier\s+(?:pay|total|rate)|agreed\s+(?:rate|amount)|total\s+due|total\s+usd)\s*[:=]?\s*(?:USD\s*)?\$?\s?([\d,]{2,7}(?:\.\d{1,2})?)\b(?!\s*(?:\/\s*mi|per\s*mile))/i);
  const rateLabeled = text.match(/\b(?:rate|pay|total|linehaul|line\s+haul|all[- ]in|flat\s+rate)\s*[:=]?\s*(?:USD\s*)?\$?\s?([\d,]{3,7}(?:\.\d{1,2})?)\b(?!\s*(?:\/\s*mi|per\s*mile))/i);
  const rate = totalLabeled ? num(totalLabeled[1]) : rateLabeled ? num(rateLabeled[1]) : dollars.filter((x) => x >= 100).sort((a, b) => b - a)[0];
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

  const commodity = text.match(/\b(?:commodity|product|freight|cargo|description)\s*[:=]\s*([^\n\t]{2,80})/i);
  if (commodity) fields.commodity = commodity[1].trim();

  const ref = text.match(/\b(?:ref(?:erence)?|load\s*(?:#|no\.?|number|id)|pro|order|confirmation\s*(?:#|no\.?|number))(?![a-z])\s*(?:#|no\.?|number)?\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{2,24})\b/i);
  if (ref && !/^(rate|miles?|con|confirmation)$/i.test(ref[1])) fields.referenceNumber = ref[1];

  const mc = text.match(/\bMC\s*#?\s*:?\s*-?\s*(\d{4,8})\b/i);
  if (mc) fields.brokerMc = mc[1];
  const dot = text.match(/\b(?:US\s*)?DOT\s*#?\s*:?\s*(\d{5,8})\b/i);
  if (dot) fields.brokerDot = dot[1];
  const broker = text.match(/\b(?:broker(?:\s+name)?|brokered\s+by|company|posted by|contact)\s*[:=]\s*([^\n\t]{2,80})/i);
  if (broker) fields.brokerName = broker[1].replace(/\s*\bMC\s*#?\s*\d+.*/i, '').trim();
  else {
    // Rate cons usually open with the broker's letterhead: a company name in the first few lines.
    const head = text.split('\n').slice(0, 4).map((l) => l.split('\t')[0].trim()).find((l) => /\b(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Logistics|Brokerage|Freight|Transportation|Solutions)\b/i.test(l) && !/rate\s+con|carrier\b/i.test(l));
    if (head) fields.brokerName = head.replace(/\s*\b(?:MC|DOT)\s*#?\s*:?\s*\d+.*/i, '').trim().slice(0, 120);
  }
  const phone = text.match(/\b(?:phone|ph|tel|telephone|office|call|cell|mobile|dispatch|contact)\b[^\d\n(]{0,14}(\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4})(?!\d)/i)
    || text.match(/(?<!\d)(\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4})(?!\d)/);
  if (phone) fields.brokerPhone = phone[1];
  // Bounded parts (RFC 5321 sizes): an unbounded `[\w.+-]+@` backtracks quadratically on a long run of word
  // characters with no "@", which costs over half a second of CPU on a 20,000-character paste.
  const email = text.match(/(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/);
  if (email) fields.brokerEmail = email[0].toLowerCase().replace(/[.]+$/, '');

  // Stops: facility, address, appointment window (facility-local), reference numbers.
  for (const [key, stop] of [['pickup', p], ['delivery', d]]) {
    if (!stop) continue;
    if (stop.facility) fields[`${key}Facility`] = stop.facility;
    if (stop.address) fields[`${key}Address`] = stop.address;
    const cityKey = key === 'pickup' ? 'origin' : 'dest';
    const tz = facilityTimezone(fields[`${cityKey}City`], fields[`${cityKey}State`]);
    if (tz) fields[`${key}Tz`] = tz;
    if (stop.date) {
      fields[`${key}Date`] = stop.date;
      if (stop.start) fields[`${key}WindowStart`] = local(stop.date, stop.start);
      if (stop.end) fields[`${key}WindowEnd`] = local(stop.date, stop.end);
    }
    if (stop.fcfs) fields[`${key}Fcfs`] = true;
    if (stop.refs.length) fields[`${key}Refs`] = stop.refs;
  }
  if (stops.extra.length) notes.push(`${stops.extra.length} more stop${stops.extra.length === 1 ? '' : 's'} on the rate con: add them to the load notes.`);

  if (!fields.pickupDate || !fields.deliveryDate) {
    const dates = parseDates(text, now);
    if (!fields.pickupDate && dates[0]) fields.pickupDate = dates[0];
    if (!fields.deliveryDate) {
      const next = dates.find((x) => x > fields.pickupDate) || (dates[1] && dates[1] !== fields.pickupDate ? dates[1] : null);
      if (next) fields.deliveryDate = next;
    }
  }

  const terms = parseTerms(text);
  Object.assign(fields, terms);
  if (!fields.referenceNumber) {
    const firstRef = (p?.refs || [])[0] || (d?.refs || [])[0];
    if (firstRef) fields.referenceNumber = firstRef.value;
  }

  const expected = ['originCity', 'destCity', 'rateCents', 'loadedMiles', 'pickupDate', 'equipment', 'weightLbs'];
  const found = expected.filter((k) => fields[k] != null);
  const missing = expected.filter((k) => fields[k] == null);
  if (missing.includes('rateCents')) notes.push('No total rate found — enter the agreed rate manually.');
  if (missing.includes('loadedMiles')) notes.push('No mileage found — enter loaded miles to compute rate per mile.');

  return { fields, found, missing, confidence: Math.round((found.length / expected.length) * 100) / 100, notes };
}

/**
 * Plain text for the load's notes from the parsed terms and stop details the Load columns do not hold
 * (reference numbers, FCFS hours, layover, lumper, payment terms, requirements).
 */
export function termsNote(fields = {}) {
  const lines = [];
  for (const key of ['pickup', 'delivery']) {
    const label = key === 'pickup' ? 'Pickup' : 'Delivery';
    const refs = (fields[`${key}Refs`] || []).map((r) => `${r.kind} ${r.value}`).join(', ');
    if (refs) lines.push(`${label} refs: ${refs}`);
    if (fields[`${key}Fcfs`]) lines.push(`${label}: FCFS${fields[`${key}WindowStart`] ? ` from ${String(fields[`${key}WindowStart`]).slice(11)}` : ''}${fields[`${key}WindowEnd`] ? ` to ${String(fields[`${key}WindowEnd`]).slice(11)}` : ''}`);
  }
  if (fields.requirements?.length) lines.push(`Requirements: ${fields.requirements.join(', ')}`);
  if (fields.paymentTerms) lines.push(`Payment terms: ${fields.paymentTerms}`);
  if (fields.layoverCents != null) lines.push(`Layover: $${(fields.layoverCents / 100).toFixed(2)}`);
  if (fields.lumper) lines.push(fields.lumper);
  return lines.join('\n');
}
