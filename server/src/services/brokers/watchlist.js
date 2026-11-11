import { prisma } from '../../db.js';
import { notify } from '../../lib/activity.js';
import { normDot, normMc } from '../carriers/normalize.js';
import { bestCensusRow, censusRows, licensingRows, pickLicensing, qcCarrier, qcConfigured, snapshotFrom } from './fmcsa.js';
import { computeFlags } from './flags.js';
import { parseJson, teamFlagOf, knownContacts } from './vetting.js';

/**
 * FMCSA watchlist (nightly): re-check customer carriers (active customers) and brokers marked "watch", compare
 * with the stored snapshot and notify the owner about authority, insurance, bond, out-of-service and contact
 * changes. Work is batched: rows are walked in primary-key order from a cursor kept in SystemSetting, at most
 * `batch` lookups per run, rows checked in the last 20 hours are skipped, census lookups go out in one request per
 * 200 numbers and QCMobile (only when an admin configured the webKey) one at a time with a small delay.
 */
const CURSOR_KEY = 'watchlist.cursor';
const RECHECK_MS = 20 * 60 * 60_000;
const WINDOW = 2000;
// Numbers per census request (censusRows takes at most 200 of each kind).
const CENSUS_CHUNK = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCursor() {
  const row = await prisma.systemSetting.findUnique({ where: { key: CURSOR_KEY } });
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function writeCursor(value) {
  const v = JSON.stringify(value);
  await prisma.systemSetting.upsert({ where: { key: CURSOR_KEY }, create: { key: CURSOR_KEY, value: v, secret: false }, update: { value: v } });
}

const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
const phoneText = (list) => (list || []).map((d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d)).join(', ') || 'none';
const addressText = (a) => [a?.street, a?.city, a?.state, a?.zip].filter(Boolean).join(', ') || 'none';

/** Differences worth an alert between two snapshots ([] for the first snapshot). */
export function snapshotChanges(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  const add = (field, label, from, to) => out.push({ field, label, from, to });
  if (prev.found && next.found === false) add('found', 'FMCSA census record', 'found', 'not found');
  if (!next.found || !prev.found) return out;
  if (prev.usdotStatus && next.usdotStatus && prev.usdotStatus !== next.usdotStatus) add('usdotStatus', 'USDOT status', prev.usdotStatus, next.usdotStatus);
  if (prev.qc && next.qc) {
    if (prev.carrierAuthority !== next.carrierAuthority) add('carrierAuthority', 'Operating authority', prev.carrierAuthority || 'unknown', next.carrierAuthority || 'unknown');
    if (prev.brokerAuthority !== next.brokerAuthority) add('brokerAuthority', 'Broker authority', prev.brokerAuthority || 'unknown', next.brokerAuthority || 'unknown');
    if (prev.insuranceOnFile !== next.insuranceOnFile) add('insuranceOnFile', 'Liability insurance on file', yesNo(prev.insuranceOnFile), yesNo(next.insuranceOnFile));
    if (prev.bondOnFile !== next.bondOnFile) add('bondOnFile', 'Broker bond on file', yesNo(prev.bondOnFile), yesNo(next.bondOnFile));
    if (prev.allowedToOperate !== next.allowedToOperate) add('allowedToOperate', 'Allowed to operate', yesNo(prev.allowedToOperate), yesNo(next.allowedToOperate));
    if ((prev.oosDate || null) !== (next.oosDate || null)) add('oosDate', 'Out-of-service order', prev.oosDate ? prev.oosDate.slice(0, 10) : 'none', next.oosDate ? next.oosDate.slice(0, 10) : 'none');
  }
  if ((prev.phones || []).join(',') !== (next.phones || []).join(',')) add('phones', 'Phone', phoneText(prev.phones), phoneText(next.phones));
  if ((prev.email || null) !== (next.email || null)) add('email', 'Email', prev.email || 'none', next.email || 'none');
  if (addressText(prev.address).toUpperCase() !== addressText(next.address).toUpperCase()) add('address', 'Address', addressText(prev.address), addressText(next.address));
  return out;
}

const changeText = (changes) => changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ').slice(0, 900);

const QC_FIELDS = ['brokerAuthority', 'carrierAuthority', 'bondOnFile', 'bondRequired', 'insuranceOnFile', 'insuranceRequired', 'allowedToOperate', 'oosDate'];
/** When QCMobile was skipped this run, keep the last QCMobile facts (with their own date) instead of dropping them. */
export function carryQc(prev, next) {
  if (!next?.found || next.qc || !prev?.qc) return next;
  const asOf = prev.qcAsOf || prev.checkedAt;
  const out = { ...next, qc: true, qcAsOf: asOf };
  for (const k of QC_FIELDS) out[k] = prev[k];
  out.sources = [...(next.sources || []).filter((s) => s.name !== 'FMCSA QCMobile'), { name: 'FMCSA QCMobile', asOf }];
  return out;
}

/** Pick up to `batch` stale rows from the cursor window. Returns { picked, next } (next = '' when the end was reached). */
function pick(rows, { batch, now, cursor }) {
  const picked = [];
  let next = cursor;
  for (const row of rows) {
    if (picked.length >= batch) break;
    next = row.id;
    if (!row.fmcsaCheckedAt || now.getTime() - new Date(row.fmcsaCheckedAt).getTime() >= RECHECK_MS) picked.push(row);
  }
  const reachedEnd = rows.length < WINDOW && picked.length < batch;
  return { picked, next: reachedEnd ? '' : next };
}

// QCMobile is called one record at a time: cap the calls and the time per run so a slow service never holds the
// scheduler. Records past the cap keep their census-only snapshot this run (QC fields compare only when both have them).
const QC_CALLS_PER_RUN = 60;
const QC_BUDGET_MS = 45_000;

/**
 * Snapshots for many rows. Each USDOT / MC number is looked up once per run, however many owners have it (census in
 * requests of CENSUS_CHUNK numbers, QCMobile once per USDOT within the per-run cap), and the result fans out to
 * every row with that number.
 */
async function snapshotsFor(items, { useQc, delayMs, now }) {
  const dots = [...new Set(items.filter((i) => i.dot).map((i) => i.dot))];
  const mcs = [...new Set(items.filter((i) => !i.dot && i.mc).map((i) => i.mc))];
  const rows = [];
  for (let i = 0; i < Math.max(dots.length, mcs.length); i += CENSUS_CHUNK) {
    rows.push(...await censusRows({ dots: dots.slice(i, i + CENSUS_CHUNK), mcs: mcs.slice(i, i + CENSUS_CHUNK) }));
  }
  const byDot = new Map(rows.map((r) => [normDot(r.dot_number), r]));
  // Several census rows can carry the same MC docket (old inactive USDOT + current one): keep the best per docket.
  const mcGroups = new Map();
  for (const r of rows.filter((x) => x.docket1prefix === 'MC')) {
    const k = normMc(r.docket1);
    mcGroups.set(k, [...(mcGroups.get(k) || []), r]);
  }
  const byMc = new Map([...mcGroups].map(([k, list]) => [k, bestCensusRow(list)]));
  // Authority and bond status from the licensing dataset, in the same chunk sizes (no key, works from any country).
  const licDots = [...new Set(rows.map((r) => normDot(r.dot_number)).filter(Boolean))];
  const lic = [];
  for (let i = 0; i < licDots.length; i += CENSUS_CHUNK) lic.push(...((await licensingRows({ dots: licDots.slice(i, i + CENSUS_CHUNK) })) || []));
  const out = new Map();
  const qcByDot = new Map();
  let qcCalls = 0;
  const started = Date.now();
  for (const item of items) {
    const row = (item.dot && byDot.get(item.dot)) || (item.mc && byMc.get(item.mc)) || null;
    let qc = null;
    const dot = row ? normDot(row.dot_number) : null;
    if (dot && qcByDot.has(dot)) qc = qcByDot.get(dot);
    else if (row && useQc && qcCalls < QC_CALLS_PER_RUN && Date.now() - started < QC_BUDGET_MS) {
      qcCalls += 1;
      qc = await qcCarrier(row.dot_number);
      if (dot) qcByDot.set(dot, qc);
      if (delayMs) await sleep(delayMs);
    }
    const licRow = row ? pickLicensing(lic, { dot: row.dot_number, mc: row.docket1prefix === 'MC' ? row.docket1 : item.mc }) : null;
    out.set(item.key, snapshotFrom(row, { qc, lic: licRow, query: { dot: item.dot, mc: item.mc }, checkedAt: now }));
  }
  return out;
}

async function checkCarriers({ cursor, batch, now, useQc, delayMs }) {
  const window = await prisma.customer.findMany({
    where: { status: 'active', ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' }, take: WINDOW,
    select: { id: true, ownerId: true, carrier: { select: { id: true, companyName: true, dotNumber: true, mcNumber: true, fmcsaCheckedAt: true } } },
  });
  // Rows without a USDOT or MC number cannot be checked: they count as fresh so the cursor walks past them.
  const rows = window.map((c) => {
    const checkable = !!(c.carrier && (normDot(c.carrier.dotNumber) || normMc(c.carrier.mcNumber)));
    return { ...c, skip: !checkable, fmcsaCheckedAt: checkable ? c.carrier.fmcsaCheckedAt : now };
  });
  const { picked, next } = pick(rows, { batch, now, cursor });
  const todo = picked.filter((p) => !p.skip);
  if (!todo.length) return { checked: 0, changed: 0, next };
  const prevRows = await prisma.carrier.findMany({ where: { id: { in: todo.map((c) => c.carrier.id) } }, select: { id: true, fmcsaSnapshot: true } });
  const prevById = new Map(prevRows.map((p) => [p.id, parseJson(p.fmcsaSnapshot, null)]));
  const snaps = await snapshotsFor(todo.map((c) => ({ key: c.carrier.id, dot: normDot(c.carrier.dotNumber), mc: normMc(c.carrier.mcNumber) })), { useQc, delayMs, now });
  let changed = 0;
  for (const c of todo) {
    const prev = prevById.get(c.carrier.id);
    const next2 = carryQc(prev, snaps.get(c.carrier.id));
    const changes = snapshotChanges(prev, next2);
    const stored = { ...next2, lastChange: changes.length ? { at: now.toISOString(), items: changes } : prev?.lastChange ?? null };
    await prisma.carrier.update({ where: { id: c.carrier.id }, data: { fmcsaSnapshot: JSON.stringify(stored), fmcsaCheckedAt: now } });
    if (changes.length) {
      changed += 1;
      await notify(c.ownerId, { type: 'fmcsa_change', title: `FMCSA change for ${c.carrier.companyName}`.slice(0, 200), body: changeText(changes), link: `/app/customers/${c.id}` });
    }
  }
  return { checked: todo.length, changed, next };
}

async function checkBrokers({ cursor, batch, now, useQc, delayMs }) {
  const window = await prisma.broker.findMany({
    where: { watch: true, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' }, take: WINDOW,
    select: { id: true, ownerId: true, companyName: true, dotNumber: true, mcNumber: true, fmcsaCheckedAt: true },
  });
  const rows = window.map((b) => (normDot(b.dotNumber) || normMc(b.mcNumber) ? b : { ...b, skip: true, fmcsaCheckedAt: now }));
  const { picked, next } = pick(rows, { batch, now, cursor });
  const todo = picked.filter((p) => !p.skip);
  if (!todo.length) return { checked: 0, changed: 0, next };
  const full = await prisma.broker.findMany({ where: { id: { in: todo.map((b) => b.id) } } });
  const byId = new Map(full.map((b) => [b.id, b]));
  const snaps = await snapshotsFor(todo.map((b) => ({ key: b.id, dot: normDot(b.dotNumber), mc: normMc(b.mcNumber) })), { useQc, delayMs, now });
  let changed = 0;
  for (const b of todo) {
    const broker = byId.get(b.id);
    if (!broker) continue;
    const prev = parseJson(broker.fmcsaSnapshot, null);
    const snap = carryQc(prev, snaps.get(b.id));
    const changes = snapshotChanges(prev, snap);
    const team = teamFlagOf(parseJson(broker.flags, []) || []);
    const flags = [...computeFlags(snap, { previous: prev, known: knownContacts(broker), now }), ...(team ? [team] : [])];
    const stored = { ...snap, lastChange: changes.length ? { at: now.toISOString(), items: changes } : prev?.lastChange ?? null };
    await prisma.broker.update({ where: { id: b.id }, data: { fmcsaSnapshot: JSON.stringify(stored), flags: JSON.stringify(flags), fmcsaCheckedAt: now } });
    if (changes.length) {
      changed += 1;
      await notify(b.ownerId, { type: 'fmcsa_change', title: `FMCSA change for broker ${b.companyName}`.slice(0, 200), body: changeText(changes), link: `/app/brokers/${b.id}` });
    }
  }
  return { checked: todo.length, changed, next };
}

/**
 * One step of the cursor walk over one list ('customers' or 'brokers'). A walk that started at the top of the list
 * on this UTC day and reached its end finishes that list for the night: later runs would only re-read rows checked
 * minutes earlier, and Broker.watch has no index, so every walk over brokers reads the Broker table once.
 * Cursor state per list: [kind] = last id, [kind]Since = day the current walk started at the top, [kind]Done = day
 * a full walk finished.
 */
async function walkList(kind, cursor, { day, force }, check) {
  const at = cursor[kind] || '';
  const since = at ? cursor[`${kind}Since`] || null : day;
  if (!force && cursor[`${kind}Done`] === day) {
    return { checked: 0, changed: 0, state: { [kind]: at, [`${kind}Since`]: cursor[`${kind}Since`] ?? null, [`${kind}Done`]: day } };
  }
  const result = await check(at);
  const finished = result.next === '';
  return {
    ...result,
    state: { [kind]: result.next, [`${kind}Since`]: finished ? null : since, [`${kind}Done`]: finished && since === day ? day : cursor[`${kind}Done`] ?? null },
  };
}

/**
 * One watchlist pass. Runs inside the nightly window (05:00-12:00 UTC, i.e. late night in US time zones) unless
 * `force`. Each pass handles at most `batch` carriers and `batch` brokers (census lookups are cheap and batched;
 * QCMobile has its own per-run cap); once both lists were walked end to end tonight, the remaining runs return
 * without reading them.
 */
export async function runWatchlist(now = new Date(), { batch = 1000, delayMs = 300, force = false } = {}) {
  const hour = now.getUTCHours();
  if (!force && (hour < 5 || hour >= 12)) return { skipped: 'outside the nightly window (05:00-12:00 UTC)' };
  const cursor = await readCursor();
  const day = now.toISOString().slice(0, 10);
  const useQc = await qcConfigured();
  const carriers = await walkList('customers', cursor, { day, force }, (from) => checkCarriers({ cursor: from, batch, now, useQc, delayMs }));
  const brokers = await walkList('brokers', cursor, { day, force }, (from) => checkBrokers({ cursor: from, batch, now, useQc, delayMs }));
  await writeCursor({ ...carriers.state, ...brokers.state });
  return { carriersChecked: carriers.checked, carriersChanged: carriers.changed, brokersChecked: brokers.checked, brokersChanged: brokers.changed, qc: useQc };
}
