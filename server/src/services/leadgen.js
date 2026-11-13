import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { effectivePlan, remainingMany } from '../lib/plans.js';
import { logActivity, notify } from '../lib/activity.js';
import { stageByKey } from './pipeline.js';
import { runAutomations } from './automation.js';
import { enrollCarriers } from './sequenceEngine.js';
import { normMc, normPhone } from './carriers/normalize.js';
import * as census from './carriers/fmcsaCensus.js';
import { AUTHORITY_UNAVAILABLE, annotateAuthority } from './carriers/authority.js';
import { teamClaims, matchFor } from './carriers/collisions.js';
import { normalizeLeadFilters, censusLeadFilters, postFilter, weightsFor } from './carriers/leadFilters.js';
import {
  scoreLead as scoreLeadV2, sharedContactStep, mcAgeStep, insurerStep, qcSafety, qcBlocks, withQc, tierPriority, scoreText, signalsJson,
  QC_MAX_PER_RUN, leadView,
} from './carriers/leadSignals.js';

export { leadView };
import { withLock, LockBusyError } from '../lib/locks.js';

/**
 * Lead generator: turns saved FMCSA Census criteria into fresh, de-duplicated, scored carrier leads.
 * Every lead comes from the live public census at run time; nothing is invented.
 * With "active only" (the default) every candidate's operating authority is checked against the FMCSA licensing
 * dataset before it is picked: only active authority (with insurance on file) is saved, and when the dataset does not
 * answer the run saves nothing (fail closed).
 * Each page goes through the cheapest checks first (see collect()): de-duplication (own CRM, teammates, do-not-call
 * and email suppression lists), the shared filters (services/carriers/leadFilters.js), the best score the carrier
 * could reach, then the batched lookups of services/carriers/leadSignals.js (shared contacts, operating authority,
 * MC age, insurer), the lead score v2, and QCMobile live safety for the picks only.
 * Usage counts against the plan's monthlyLeadGenLimit (and maxCarriers).
 */

const PAGE = 200;
// At most 5 census pages (1,000 rows) per state per run: first the head of the list (carriers added since an earlier
// run), then the deep scan from where the last run stopped (see the crawl cursor below).
const PAGES_PER_STATE = 5;
// Census requests in flight at once for one crawl (the public API throttles per IP; each request has a 20 s timeout).
const STATE_CONCURRENCY = 3;
// Wall-clock budget per crawl: a run stops starting new census requests after this and saves what it found.
const RUN_BUDGET_MS = 2 * 60_000;
const PREVIEW_BUDGET_MS = 25_000;
// Candidates per licensing check (one request each); checks run one after another, only until enough are picked.
const VERIFY_BATCH = 200;

/** Thrown when the licensing dataset did not answer for candidates that must be verified. Nothing is saved. */
export class AuthorityUnavailableError extends HttpError {
  constructor(stats = null) {
    super(503, AUTHORITY_UNAVAILABLE);
    this.code = 'AUTHORITY_UNAVAILABLE';
    this.stats = stats;
  }
}

/** The "N skipped: authority not active" sentence a run message carries (LeadGenRun has no column for the count). */
export const inactiveAuthorityText = (n) => `${n} skipped: authority not active.`;
/**
 * Count of candidates skipped for inactive authority, read back from a stored run message: the sentence above, or
 * "N authority not active" in the list of an "all carriers were checked" message.
 */
export function inactiveAuthorityFrom(message) {
  const m = /(\d[\d,]*) (?:skipped: )?authority not active/.exec(message || '');
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

const LEGACY_EXHAUSTED = /no more matches in the first \d+ census records per state\. Widen the criteria for more\./;
/**
 * Stored run messages from before the crawl cursor said "no more matches in the first 600 census records per state",
 * which was wrong when the census simply had fewer matches. Shown without the number.
 */
export const runMessageText = (message) => (message ? message.replace(LEGACY_EXHAUSTED, 'no more matches this run. Widen the filters to find more.') : message);

const num = (n) => Number(n).toLocaleString('en-US');
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const WIDEN = 'Widen the filters (more states, a longer authority age range, fewer contact requirements) to find more.';

/** Why candidates were left out, in the order a run checks them (stats keys of collect() and their wording). */
export const EXCLUSION_REASONS = Object.freeze([
  ['skipped', 'already in your CRM'],
  ['teamClaimed', 'with a teammate'],
  ['suppressed', 'on your do-not-contact lists'],
  ['unsafe', 'unsafe safety rating'],
  ['filtered', 'outside your filters'],
  ['sharedContact', 'share a phone or email with other carriers (likely have a dispatcher)'],
  ['inactiveAuthority', 'authority not active'],
  ['outOfService', 'out of service'],
  ['belowScore', 'below your minimum score'],
]);
/** Counts LeadGenRun stores in its `exclusions` JSON (the ones without a column of their own). */
export const EXCLUSION_KEYS = Object.freeze(['teamClaimed', 'suppressed', 'unsafe', 'filtered', 'sharedContact', 'inactiveAuthority', 'outOfService']);

/**
 * Message for a run whose crawl reached the end of the census list in every state.
 * `fromTop`: this run read every state from the first row, so `scanned` is every matching carrier. Otherwise earlier
 * runs read the first part and `matching` (the length of each state's list) is the total.
 */
export function exhaustedMessage({ created = 0, scanned = 0, matching = 0, fromTop = true, ...counts }) {
  // This run read every row of every list (scanned counts distinct rows): the counts below cover all of them.
  if (scanned && scanned === matching) fromTop = true;
  const total = fromTop ? scanned : matching;
  if (!total) return `No carriers match these filters right now. ${WIDEN}`;
  const parts = EXCLUSION_REASONS.map(([k, text]) => [counts[k] || 0, text])
    .filter(([n]) => n > 0).map(([n, text]) => `${num(n)} ${text}`);
  const added = created ? `Added ${plural(created, 'new lead')}. ` : '';
  const all = `All ${plural(total, 'carrier')} matching these filters ${total === 1 ? 'was' : 'were'} checked`;
  if (fromTop) return `${added}${all}${parts.length ? `: ${parts.join(', ')}` : ''}. ${WIDEN}`;
  return `${added}${all}; this run read ${num(scanned)}${parts.length ? `: ${parts.join(', ')}` : ''}. ${WIDEN}`;
}

/** Message for a run that stopped at the per-run page cap or time limit with more census rows left. */
export const continuesMessage = ({ created = 0, scanned = 0 }) =>
  `Added ${plural(created, 'new lead')}. Read ${plural(scanned, 'carrier')} this run; the next run continues where this one stopped.`;


export function parseCriteria(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch { return {}; }
}

/*
 * Crawl cursor (LeadGenerator.cursor, JSON): { v: 1, criteriaHash, states: { TX: { deepOffset, headSeenAt, exhaustedAt } } }
 * The census lists a state's matches newest first (add_date DESC, dot_number). Each run, per state:
 *   1. Head scan: read from offset 0 down to the first row older than headSeenAt (the newest add_date an earlier run
 *      read from the top of the list), so carriers added since then are found first. The headSeenAt day itself is read
 *      again on purpose: a carrier added later that day sorts by dot number, possibly below rows already read.
 *   2. Deep scan: continue from deepOffset. Carriers added at the top push rows down, so a saved offset can only
 *      drift toward reading rows again (de-duplication skips them); no row is skipped.
 * When the deep scan reaches the end of the list (a page shorter than PAGE) the state is exhausted for this run:
 * exhaustedAt is stamped and the next run starts the deep scan again from the top (no head scan then; the deep scan
 * covers the top, and de-duplication keeps it cheap).
 * A row counts as read only once it was fully handled (saved, already in the CRM, below the score, inactive authority).
 * When a run stops inside a page (enough leads, time limit), the cursor stops at the first row not handled, and
 * headSeenAt only moves when the head scan finished, so the next run reads the rest.
 * criteriaHash covers the filters and the minimum score, not the state list (positions are per state): a cursor saved
 * for other filters is ignored, and changing the filters resets it. Previews never use or write it, and only runs that
 * finished their save phase write it.
 */
const CURSOR_VERSION = 1;

/**
 * Stable hash of the filters a crawl position depends on (everything but the state list), the playbook (its weights
 * change scores) and the minimum score. Every shared lead filter is in it with its default filled in, so criteria
 * stored before a filter existed hash like criteria that spell the default out.
 */
export function criteriaHash(criteria, minScore = 0) {
  const c = parseCriteria(criteria);
  const n = (v) => (v == null || v === '' ? null : Number(v));
  const norm = {
    cargo: [...(c.cargo || [])].map(String).sort(),
    minPowerUnits: n(c.minPowerUnits), maxPowerUnits: n(c.maxPowerUnits),
    authorityAgeMinMonths: n(c.authorityAgeMinMonths), authorityAgeMaxMonths: n(c.authorityAgeMaxMonths),
    requirePhone: !!c.requirePhone, requireEmail: !!c.requireEmail, requireMc: !!c.requireMc, activeOnly: c.activeOnly !== false,
    minScore: Number(minScore) || 0,
    leadFilters: normalizeLeadFilters(c),
    playbook: c.playbook || null,
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

/** The stored cursor when it was saved for these filters (same criteriaHash), otherwise null (start from the top). */
export function readCursor(raw, hash) {
  try {
    const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (c?.v === CURSOR_VERSION && c.criteriaHash === hash && c.states && typeof c.states === 'object') return c;
  } catch { /* unreadable: start from the top */ }
  return null;
}

/** Census add date of a mapped record as YYYY-MM-DD (the list's sort key), or null. */
const addDay = (rec) => (rec.authorityDate instanceof Date && !Number.isNaN(rec.authorityDate.getTime()) ? rec.authorityDate.toISOString().slice(0, 10) : null);
const newestDay = (items) => items.map(addDay).filter(Boolean).sort().pop() || null;

/**
 * Lead score v2 (services/carriers/leadSignals.js): { score, tier, signals, reasons, groups }. The second argument is
 * the scoring context ({ now, timezone, weights }) or, as before, just `now`.
 */
export const scoreLead = (rec, ctx = {}) => scoreLeadV2(rec, ctx instanceof Date ? { now: ctx } : ctx);

function censusFilters(c, state, now = new Date()) {
  return {
    ...censusLeadFilters(c, now),
    state,
    activeOnly: c.activeOnly !== false,
    hasMc: !!c.requireMc,
    hasEmail: !!c.requireEmail,
    hasPhone: !!c.requirePhone,
    cargo: c.cargo || [],
    minPowerUnits: c.minPowerUnits ?? undefined,
    maxPowerUnits: c.maxPowerUnits ?? undefined,
    // addedBefore / addedAfter (authority age months, MC age days) come from censusLeadFilters.
    order: 'newest',
    limit: PAGE,
  };
}

const lower = (e) => String(e || '').trim().toLowerCase();

/**
 * What de-duplication needs for one page: the user's own carriers (USDOT / MC), teammates' carriers (collision guard),
 * phones on the user's do-not-call carriers and addresses on the user's email suppression list.
 */
async function dedupeKeys(user, recs) {
  const dots = [...new Set(recs.map((r) => r.dotNumber).filter(Boolean))];
  const mcs = [...new Set(recs.map((r) => r.mcNumber).filter(Boolean))];
  const phones = [...new Set(recs.map((r) => normPhone(r.phone)).filter(Boolean))];
  const emails = [...new Set(recs.map((r) => lower(r.email)).filter(Boolean))];
  const [rows, dnc, suppressed] = await Promise.all([
    prisma.carrier.findMany({ where: { ownerId: user.id, OR: [{ dotNumber: { in: dots } }, { mcNumber: { in: mcs } }] }, select: { dotNumber: true, mcNumber: true } }),
    phones.length ? prisma.carrier.findMany({ where: { ownerId: user.id, doNotCall: true, phone: { in: phones } }, select: { phone: true } }) : [],
    emails.length ? prisma.emailSuppression.findMany({ where: { ownerId: user.id, email: { in: emails } }, select: { email: true } }) : [],
  ]);
  // teamClaims takes 500 numbers per call.
  const team = new Map();
  if (user.teamMembership) {
    for (let i = 0; i < recs.length; i += 250) {
      const part = recs.slice(i, i + 250);
      const claims = await teamClaims(user, { dots: part.map((r) => r.dotNumber), mcs: part.map((r) => r.mcNumber) });
      for (const r of part) if (matchFor(claims, r)) team.set(r.dotNumber, true);
    }
  }
  return {
    dots: new Set(rows.map((r) => r.dotNumber).filter(Boolean)),
    mcs: new Set(rows.map((r) => r.mcNumber).filter(Boolean)),
    team,
    dncPhones: new Set(dnc.map((r) => normPhone(r.phone)).filter(Boolean)),
    suppressedEmails: new Set(suppressed.map((r) => lower(r.email))),
  };
}

/**
 * Check the operating authority of one batch of candidates (one licensing request) and keep the ones that may be
 * picked, with authorityStatus/operatingStatus from FMCSA licensing.
 * activeOnly (the default): only active authority is kept; inactive and pending count in stats.inactiveAuthority.
 * A candidate without an MC number is kept only when the criteria do not require one (authorityStatus 'none').
 * When the dataset did not answer for a candidate that must be verified, throws AuthorityUnavailableError (fail
 * closed: no unverified carrier is ever saved). Without activeOnly, unanswered checks leave the authority 'unknown'.
 */
async function verifyBatch(batch, criteria, stats, { cacheMs = 0 } = {}) {
  const activeOnly = criteria.activeOnly !== false;
  const { items } = await annotateAuthority(batch, { cacheMs });
  const kept = [];
  for (const rec of items) {
    const status = rec.authorityStatus;
    if (status === 'none') {
      if (criteria.requireMc) { stats.inactiveAuthority++; continue; }
    } else if (status === 'unknown') {
      if (activeOnly) throw new AuthorityUnavailableError(stats);
    } else if (status !== 'active' && activeOnly) {
      stats.inactiveAuthority++;
      continue;
    }
    kept.push(rec);
  }
  return kept;
}

/** Where one state's crawl starts this run, from its saved cursor entry (none: the deep scan starts at the top). */
function startCrawl(state, saved) {
  const deepOffset = Number.isInteger(saved?.deepOffset) && saved.deepOffset > 0 ? saved.deepOffset : 0;
  const headSeenAt = typeof saved?.headSeenAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.headSeenAt) ? saved.headSeenAt : null;
  return {
    state,
    saved: saved || {},
    // A deep scan that starts at the top reads the newest carriers itself: no head scan then.
    phase: deepOffset > 0 && headSeenAt ? 'head' : 'deep',
    headSeenAt,
    headOffset: 0,
    headDone: false,
    top: null, // newest add day on the first page of the list, read this run
    deepStart: deepOffset,
    deepPos: deepOffset,
    exhausted: false,
    total: 0, // rows in the state's list when the deep scan reached its end
    closed: false,
  };
}

/** The cursor to save after a run: each state's next position (see "Crawl cursor" above). */
function nextCursor(crawl, hash, now = new Date()) {
  const states = {};
  for (const c of crawl) {
    let headSeenAt = c.saved.headSeenAt ?? null;
    // Deep scan from the top: every row below the first page's newest day is read by this or a later deep scan.
    // Finished head scan: everything above the old mark was read this run.
    if (c.top && (c.deepStart === 0 || c.headDone)) headSeenAt = c.top;
    states[c.state] = {
      deepOffset: c.exhausted ? 0 : c.deepPos,
      headSeenAt,
      exhaustedAt: c.exhausted ? now.toISOString() : c.saved.exhaustedAt ?? null,
    };
  }
  return { v: CURSOR_VERSION, criteriaHash: hash, states };
}

/**
 * Walk census pages round-robin across states and yield fresh candidates (not in the user's CRM, operating authority
 * checked, at or above minScore).
 * Each state reads at most `pages` pages: with a `cursor`, first the head of its list down to the high-water mark,
 * then the deep scan from the saved offset (see "Crawl cursor" above); without one, from the top.
 * Stops when `want` candidates are found, every state reached the end of its list (exhausted), every state used its
 * pages, or the wall-clock budget is spent (timedOut).
 * At most STATE_CONCURRENCY census requests run at once. The first failed request (a 429, a timeout) stops the crawl:
 * no new request starts, the ones already in flight are awaited, and then the error is thrown, so nothing from this
 * crawl keeps calling FMCSA after collect() has returned and the generator lock is released.
 * Each page, cheapest first:
 *   1. de-duplication: the user's CRM (skipped), teammates' carriers (teamClaimed), do-not-call phones and suppressed
 *      emails (suppressed);
 *   2. the shared filters on the page (leadFilters.postFilter: unsafe rating, or filtered);
 *   3. the best score the carrier could reach (belowScore);
 * then, in batches of VERIFY_BATCH, one batch at a time and only until enough candidates are picked:
 *   4. shared-contact counts (sharedContact; fail-soft);
 *   5. operating authority (inactiveAuthority; a batch the licensing dataset did not answer throws
 *      AuthorityUnavailableError: fail closed);
 *   6. MC age from authority history, then the insurer (filtered; both fail-soft);
 *   7. the lead score (belowScore), picked in crawl order;
 *   8. QCMobile live safety for the picks only, at most `qcMax` per crawl (outOfService; fail-open).
 * Returns the next cursor too; the caller decides whether to save it.
 */
async function collect(user, criteria, minScore, want, {
  pages = PAGES_PER_STATE, cacheMs = 0, budgetMs = RUN_BUDGET_MS, cursor = null, hash = null, qcMax = QC_MAX_PER_RUN, now = new Date(),
} = {}) {
  const crawl = (criteria.states || []).map((s) => startCrawl(s, cursor?.states?.[s]));
  const stats = { scanned: 0, skipped: 0, belowScore: 0, inactiveAuthority: 0, teamClaimed: 0, suppressed: 0, unsafe: 0, filtered: 0, sharedContact: 0, outOfService: 0 };
  const scoring = { now, timezone: user.timezone || null, weights: weightsFor(criteria) };
  const picked = [];
  const seen = new Set();
  const handled = new Set(); // dot numbers fully handled this run (the cursor may move past them)
  const isHandled = (rec) => !rec.dotNumber || handled.has(rec.dotNumber);
  const done = (list, key) => { for (const r of list) { handled.add(r.dotNumber); if (key) stats[key]++; } };
  const deadline = Date.now() + budgetMs;
  let qcLeft = qcMax;
  let notes = null;
  let timedOut = false;
  for (let p = 0; p < pages && picked.length < want; p++) {
    const todo = crawl.filter((c) => !c.closed);
    if (!todo.length) break;
    if (Date.now() >= deadline) { timedOut = true; break; }
    // Fetch the next page of every open state, then interleave so one state cannot fill the whole batch.
    const pageOf = new Array(todo.length).fill(null);
    let next = 0;
    let failure = null;
    const worker = async () => {
      while (!failure && next < todo.length) {
        const i = next++;
        if (Date.now() >= deadline) { timedOut = true; continue; }
        const c = todo[i];
        const phase = c.phase;
        const offset = phase === 'head' ? c.headOffset : c.deepPos;
        try {
          const res = await census.search({ ...censusFilters(criteria, c.state, now), offset }, undefined, { cacheMs });
          if (res.note) notes = res.note;
          const items = res.items;
          if (offset === 0) c.top = newestDay(items);
          let rows = items;
          let headEnd = false;
          if (phase === 'head') {
            // Rows above the high-water mark; the first older row ends the head scan (the deep scan read the rest).
            const stop = items.findIndex((r) => { const d = addDay(r); return d && d < c.headSeenAt; });
            if (stop >= 0) rows = items.slice(0, stop);
            headEnd = stop >= 0 || items.length < PAGE;
          }
          pageOf[i] = { c, phase, offset, items, rows, headEnd };
        } catch (err) {
          failure ??= err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STATE_CONCURRENCY, todo.length) }, worker));
    if (failure) throw failure;
    const fetched = pageOf.filter(Boolean);
    const page = [];
    for (let i = 0; fetched.some((f) => i < f.rows.length); i++) for (const f of fetched) if (i < f.rows.length) page.push(f.rows[i]);
    const have = await dedupeKeys(user, page);
    const fresh = [];
    for (const rec of page) {
      if (!rec.dotNumber || seen.has(rec.dotNumber)) continue;
      seen.add(rec.dotNumber);
      stats.scanned++;
      if (have.dots.has(rec.dotNumber) || (rec.mcNumber && have.mcs.has(normMc(rec.mcNumber)))) { done([rec], 'skipped'); continue; }
      if (have.team.has(rec.dotNumber)) { done([rec], 'teamClaimed'); continue; }
      if ((rec.phone && have.dncPhones.has(normPhone(rec.phone))) || (rec.email && have.suppressedEmails.has(lower(rec.email)))) { done([rec], 'suppressed'); continue; }
      const why = postFilter(rec, criteria, now);
      if (why) { done([rec], why === 'unsafe' ? 'unsafe' : 'filtered'); continue; }
      // The best score this record can reach (authority active, a brand-new MC, no shared contact): below the minimum
      // it is not worth a lookup.
      if (scoreLead(rec, { ...scoring, optimistic: true }).score < minScore) { done([rec], 'belowScore'); continue; }
      fresh.push(rec);
    }
    for (let i = 0; i < fresh.length && picked.length < want; i += VERIFY_BATCH) {
      if (i > 0 && Date.now() >= deadline) { timedOut = true; break; }
      const batch = fresh.slice(i, i + VERIFY_BATCH);
      const shared = await sharedContactStep(batch, criteria, { cacheMs });
      done(shared.excluded, 'sharedContact');
      const verified = shared.kept.length ? await verifyBatch(shared.kept, criteria, stats, { cacheMs }) : [];
      const kept = new Set(verified.map((r) => r.dotNumber));
      for (const rec of shared.kept) if (!kept.has(rec.dotNumber)) handled.add(rec.dotNumber); // authority not active
      const aged = await mcAgeStep(verified, criteria, { cacheMs, now });
      done(aged.excluded, 'filtered');
      const insured = await insurerStep(aged.kept, criteria, { cacheMs, now });
      done(insured.excluded, 'filtered');
      // Pick in crawl order; QCMobile checks each round of picks, and a dropped pick makes room for the next one.
      let pool = insured.kept;
      while (pool.length && picked.length < want) {
        const round = [];
        let k = 0;
        for (; k < pool.length && picked.length + round.length < want; k++) {
          if (scoreLead(pool[k], scoring).score < minScore) { done([pool[k]], 'belowScore'); continue; }
          round.push(pool[k]);
        }
        pool = pool.slice(k);
        if (!round.length) break;
        const qc = await qcSafety(round, { max: qcLeft, deadline });
        qcLeft = Math.max(0, qcLeft - round.length);
        for (const r of round) {
          handled.add(r.dotNumber);
          const rec = withQc(r, qc.get(r.dotNumber));
          if (qcBlocks(rec._lead.qc)) { stats.outOfService++; continue; }
          const s = scoreLead(rec, scoring);
          if (s.score < minScore) { stats.belowScore++; continue; }
          picked.push({ ...rec, score: s.score, tier: s.tier, signals: s.signals, scoreReasons: s.reasons });
        }
      }
    }
    // Move each state past the rows it handled. A page left part-way (enough leads, time limit) ends its crawl here.
    for (const f of fetched) {
      const { c } = f;
      let k = 0;
      while (k < f.rows.length && isHandled(f.rows[k])) k++;
      if (k < f.rows.length) {
        if (f.phase === 'deep') c.deepPos = f.offset + k;
        c.closed = true;
      } else if (f.phase === 'head') {
        if (f.items.length < PAGE && f.rows.length === f.items.length) {
          // The head scan reached the end of the list without an older row: this run read every row.
          Object.assign(c, { headDone: true, exhausted: true, total: f.offset + f.items.length, closed: true });
        } else if (f.headEnd) { c.headDone = true; c.phase = 'deep'; } else c.headOffset += PAGE;
      } else {
        c.deepPos = f.offset + f.items.length;
        if (f.items.length < PAGE) { c.exhausted = true; c.total = c.deepPos; c.closed = true; }
      }
    }
  }
  return {
    picked,
    stats,
    exhausted: crawl.length > 0 && crawl.every((c) => c.exhausted),
    // Every state was read from its first row this run (so `scanned` covers the whole list when exhausted).
    fromTop: crawl.every((c) => c.deepStart === 0),
    matching: crawl.reduce((n, c) => n + c.total, 0),
    timedOut,
    note: notes,
    cursor: nextCursor(crawl, hash),
  };
}

/** Census pages a preview may reuse (runs always read fresh data). */
const PREVIEW_CACHE_MS = 10 * 60_000;

/**
 * Preview matches without creating anything or using quota. When the licensing dataset does not answer, the preview
 * shows no rows (never unverified carriers) and says why in `authorityError`.
 */
export async function previewLeads(user, criteria, minScore = 0, size = 25) {
  const base = { source: census.label, retrievedAt: new Date().toISOString() };
  try {
    const { picked, stats, exhausted, note } = await collect(user, criteria, minScore, size, { pages: 1, cacheMs: PREVIEW_CACHE_MS, budgetMs: PREVIEW_BUDGET_MS });
    return {
      // Best leads first.
      items: picked.map(leadView).sort((a, b) => b.score - a.score),
      ...stats,
      exhausted,
      note,
      authorityError: null,
      ...base,
    };
  } catch (err) {
    if (!(err instanceof AuthorityUnavailableError)) throw err;
    return {
      items: [],
      scanned: 0, skipped: 0, belowScore: 0, inactiveAuthority: 0, teamClaimed: 0, suppressed: 0, unsafe: 0, filtered: 0, sharedContact: 0, outOfService: 0,
      ...(err.stats || {}),
      exhausted: false,
      note: null,
      authorityError: `${AUTHORITY_UNAVAILABLE} No carriers are shown until it can be checked; try the preview again in a few minutes.`,
      ...base,
    };
  }
}

export function nextRunFrom(frequency, from = new Date()) {
  return new Date(from.getTime() + (frequency === 'weekly' ? 7 : 1) * 86400000);
}

/** Run one generator: fetch, de-duplicate, score and save leads. Always records a LeadGenRun. */
export async function runGenerator(user, gen, opts = {}) {
  // Database lock so two app processes (cluster workers) never run the same generator at once.
  try {
    return await withLock(`leadgen.${gen.id}`, 10 * 60_000, () => runGeneratorUnlocked(user, gen, opts));
  } catch (err) {
    if (err instanceof LockBusyError) throw new HttpError(409, 'This generator is already running');
    throw err;
  }
}

async function runGeneratorUnlocked(user, gen, { trigger = 'manual' } = {}) {
  {
    const criteria = parseCriteria(gen.criteria);
    const hash = criteriaHash(criteria, gen.minScore);
    const left = await remainingMany(user, ['leadGenMonth', 'carriers']);
    const budget = Math.min(gen.batchSize, left.leadGenMonth, left.carriers);
    const run = { trigger, status: 'ok', scanned: 0, created: 0, skipped: 0, belowScore: 0, message: null };
    let inactiveAuthority = 0; // also kept in the message (inactiveAuthorityText) for runs stored before `exclusions`
    let exclusions = null; // counts per reason without a column (EXCLUSION_KEYS)
    let cursor = null; // the crawl position to save; stays null when the run fails
    const ids = [];
    const createdCarriers = [];
    const now = new Date();

    if (budget <= 0) {
      const { plan } = await effectivePlan(user);
      run.status = 'limited';
      run.message = `Your ${plan?.name || 'current'} plan's monthly lead limit is used up. Upgrade for more leads.`;
    } else {
      try {
        const crawl = await collect(user, criteria, gen.minScore, budget, { cursor: readCursor(gen.cursor, hash), hash, now });
        const { picked, stats, exhausted, note } = crawl;
        ({ inactiveAuthority } = stats);
        exclusions = Object.fromEntries(EXCLUSION_KEYS.map((k) => [k, stats[k] || 0]));
        Object.assign(run, { scanned: stats.scanned, skipped: stats.skipped, belowScore: stats.belowScore });
        const stage = await stageByKey(gen.stageKey || 'lead');
        const list = gen.listId ? await prisma.prospectList.findFirst({ where: { id: gen.listId, ownerId: user.id } }) : null;
        for (const rec of picked) {
          const { score, tier, signals } = rec;
          try {
            const c = await prisma.carrier.create({
              data: {
                // authorityStatus/operatingStatus come from the FMCSA licensing check in collect().
                ...census.carrierColumns(rec), ownerId: user.id, stageId: stage.id, source: 'lead_generator', sourceRef: `USDOT ${rec.dotNumber} · ${gen.name}`.slice(0, 190),
                verifiedAt: now, priority: tierPriority(tier), leadScore: score, leadTier: tier, leadSignals: signalsJson(signals),
              },
            });
            // The note names the source of each status: operating authority from FMCSA licensing, USDOT from the census.
            const checked = [
              rec.authorityStatus === 'active' && 'Authority active, insurance on file (FMCSA licensing)',
              rec.usdotStatus === 'active' && 'USDOT registration active (census)',
            ].filter(Boolean);
            const body = `Lead score ${scoreText({ score, tier, signals })} from "${gen.name}".${checked.length ? ` Checked: ${checked.join('; ')}.` : ''}`;
            await prisma.carrierNote.create({ data: { carrierId: c.id, authorId: user.id, body } }).catch(() => {});
            if (list) await prisma.prospectListItem.create({ data: { listId: list.id, carrierId: c.id } }).catch(() => {});
            ids.push(c.id);
            createdCarriers.push(c);
            run.created++;
            await runAutomations(user, 'carrier_created', { carrier: c });
          } catch (err) {
            if (err.code === 'P2002') run.skipped++;
            else throw err;
          }
        }
        if (run.created < budget && exhausted) {
          // Every state's list was read to the end: say what happened to the carriers it holds.
          run.status = 'exhausted';
          run.message = exhaustedMessage({ ...stats, created: run.created, matching: crawl.matching, fromTop: crawl.fromTop });
        } else if (run.created < budget) {
          // Stopped at the per-run page cap or the time limit with rows left: the cursor continues from there.
          run.message = continuesMessage({ created: run.created, scanned: stats.scanned });
        } else if (budget < gen.batchSize) {
          run.status = 'limited';
          run.message = `Created ${run.created} of ${gen.batchSize}; your plan's monthly lead limit was reached.`;
        }
        if (note) run.message = [run.message, note].filter(Boolean).join(' ');
        if (gen.sequenceId && createdCarriers.length) {
          const seq = await prisma.emailSequence.findFirst({ where: { id: gen.sequenceId, ownerId: user.id, active: true } });
          if (seq) {
            const fresh = await prisma.carrier.findMany({ where: { id: { in: createdCarriers.map((c) => c.id) } } });
            const enr = await enrollCarriers(user, seq.id, fresh);
            run.message = [run.message, `Enrolled ${enr.enrolled} in "${seq.name}".`].filter(Boolean).join(' ');
          } else {
            run.message = [run.message, 'The linked sequence is missing or paused, so leads were not enrolled.'].filter(Boolean).join(' ');
          }
        }
        // The "all checked" message already lists the count.
        if (inactiveAuthority && run.status !== 'exhausted') run.message = [run.message, inactiveAuthorityText(inactiveAuthority)].filter(Boolean).join(' ');
        ({ cursor } = crawl);
      } catch (err) {
        run.status = 'error';
        run.message = err instanceof AuthorityUnavailableError
          ? `${AUTHORITY_UNAVAILABLE} No leads were added; ${trigger === 'scheduled' ? 'the run will try again later' : 'try again in a few minutes'}.`
          : err instanceof HttpError ? err.message : `Lead generation failed: ${err.message}`;
      }
    }

    // The crawl position is saved with the run record, and only for a run that finished its save phase: a failed run
    // (FMCSA error, authority check unavailable, save error) leaves it where it was, so no census row is skipped.
    const [row] = await prisma.$transaction([
      prisma.leadGenRun.create({
        data: { ...run, generatorId: gen.id, ownerId: user.id, carrierIds: JSON.stringify(ids), exclusions: exclusions ? JSON.stringify(exclusions) : null },
      }),
      prisma.leadGenerator.update({
        where: { id: gen.id },
        data: {
          lastRunAt: now,
          ...(gen.autoRun ? { nextRunAt: nextRunFrom(gen.frequency, now) } : {}),
          ...(cursor && run.status !== 'error' ? { cursor: JSON.stringify(cursor) } : {}),
        },
      }),
    ]);
    const saved = { ...row, inactiveAuthority };
    if (run.created) await logActivity(user, { type: 'import', summary: `Lead generator "${gen.name}" added ${run.created} lead(s)` });
    if (trigger === 'scheduled' && (run.created || run.status !== 'ok')) {
      await notify(user.id, {
        type: 'lead_generator',
        title: run.created ? `${run.created} new lead(s) from "${gen.name}"` : `"${gen.name}" found no new leads`,
        body: run.message,
        link: '/app/lead-generator',
      });
    }
    return saved;
  }
}

const userInclude = { teamMembership: { include: { team: true } } };

/** Scheduler job: run due auto generators for users whose plan includes scheduled runs. */
export async function runDueGenerators(now = new Date(), log = () => {}) {
  const due = await prisma.leadGenerator.findMany({
    where: { autoRun: true, active: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
    take: 3,
    include: { owner: { include: userInclude } },
  });
  let ran = 0;
  for (const gen of due) {
    try {
      if (gen.owner.status !== 'active') { await prisma.leadGenerator.update({ where: { id: gen.id }, data: { autoRun: false } }); continue; }
      const { plan } = await effectivePlan(gen.owner);
      if (!plan?.leadGenAutoRun) {
        await prisma.leadGenerator.update({ where: { id: gen.id }, data: { autoRun: false, nextRunAt: null } });
        await notify(gen.owner.id, {
          type: 'lead_generator',
          title: `Scheduled runs paused for "${gen.name}"`,
          body: `Your ${plan?.name || 'current'} plan does not include scheduled lead generation. You can still run it by hand.`,
          link: '/app/billing',
        });
        continue;
      }
      await runGenerator(gen.owner, gen, { trigger: 'scheduled' });
      ran++;
    } catch (err) {
      log('leadgen', gen.id, err.message);
      await prisma.leadGenerator.update({ where: { id: gen.id }, data: { nextRunAt: nextRunFrom(gen.frequency, now) } }).catch(() => {});
    }
  }
  return ran;
}
