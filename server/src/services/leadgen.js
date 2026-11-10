import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { effectivePlan, remaining } from '../lib/plans.js';
import { logActivity, notify } from '../lib/activity.js';
import { stageByKey } from './pipeline.js';
import { runAutomations } from './automation.js';
import { enrollCarriers } from './sequenceEngine.js';
import { normMc } from './carriers/normalize.js';
import * as census from './carriers/fmcsaCensus.js';
import { withLock, LockBusyError } from '../lib/locks.js';

/**
 * Lead generator: turns saved FMCSA Census criteria into fresh, de-duplicated, scored carrier leads.
 * Every lead comes from the live public census at run time; nothing is invented.
 * Usage counts against the plan's monthlyLeadGenLimit (and maxCarriers).
 */

const PAGE = 200;
const PAGES_PER_STATE = 3; // at most 600 census rows scanned per state per run

const monthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d; };

export function parseCriteria(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw || {}; } catch { return {}; }
}

/** 0–100 fit score for a dispatch prospect, with the reasons shown to the user. */
export function scoreLead(rec, now = new Date()) {
  const reasons = [];
  let score = 0;
  const add = (n, why) => { score += n; reasons.push(why); };
  if (rec.phone) add(25, 'Phone on file');
  if (rec.email) add(20, 'Email on file');
  if (rec.mcNumber) add(15, 'MC authority');
  if (rec.authorityStatus === 'active') add(10, 'USDOT active');
  if (rec.authorityDate) {
    const months = (now - new Date(rec.authorityDate)) / (30.44 * 86400000);
    if (months >= 0 && months <= 24) add(15, months <= 6 ? 'New authority (under 6 months)' : 'Authority under 2 years');
  }
  if (rec.fleetSize != null) {
    if (rec.fleetSize >= 1 && rec.fleetSize <= 10) add(15, 'Small fleet (1–10 trucks)');
    else if (rec.fleetSize <= 50) add(8, 'Mid-size fleet');
  }
  return { score: Math.min(100, score), reasons };
}

function censusFilters(c, state) {
  return {
    state,
    activeOnly: c.activeOnly !== false,
    hasMc: !!c.requireMc,
    hasEmail: !!c.requireEmail,
    hasPhone: !!c.requirePhone,
    cargo: c.cargo || [],
    minPowerUnits: c.minPowerUnits ?? undefined,
    maxPowerUnits: c.maxPowerUnits ?? undefined,
    addedBefore: c.authorityAgeMinMonths != null ? monthsAgo(c.authorityAgeMinMonths) : undefined,
    addedAfter: c.authorityAgeMaxMonths != null ? monthsAgo(c.authorityAgeMaxMonths) : undefined,
    order: 'newest',
    limit: PAGE,
  };
}

async function existingKeys(userId, recs) {
  const dots = recs.map((r) => r.dotNumber).filter(Boolean);
  const mcs = recs.map((r) => r.mcNumber).filter(Boolean);
  const rows = await prisma.carrier.findMany({
    where: { ownerId: userId, OR: [{ dotNumber: { in: dots } }, { mcNumber: { in: mcs } }] },
    select: { dotNumber: true, mcNumber: true },
  });
  return { dots: new Set(rows.map((r) => r.dotNumber).filter(Boolean)), mcs: new Set(rows.map((r) => r.mcNumber).filter(Boolean)) };
}

/**
 * Walk census pages round-robin across states and yield fresh candidates (not in the user's CRM, at or above minScore).
 * Stops when `want` candidates are found or every state is exhausted.
 */
async function collect(userId, criteria, minScore, want, { pages = PAGES_PER_STATE } = {}) {
  const states = criteria.states || [];
  const open = new Set(states);
  const stats = { scanned: 0, skipped: 0, belowScore: 0 };
  const picked = [];
  const seen = new Set();
  let notes = null;
  for (let p = 0; p < pages && open.size && picked.length < want; p++) {
    // Fetch this page for every open state, then interleave so one state cannot fill the whole batch.
    const perState = [];
    for (const state of states) {
      if (!open.has(state)) continue;
      const res = await census.search({ ...censusFilters(criteria, state), offset: p * PAGE });
      if (res.note) notes = res.note;
      if (res.items.length < PAGE) open.delete(state);
      stats.scanned += res.items.length;
      perState.push(res.items);
    }
    const page = [];
    for (let i = 0; perState.some((l) => i < l.length); i++) for (const l of perState) if (i < l.length) page.push(l[i]);
    {
      const have = await existingKeys(userId, page);
      for (const rec of page) {
        if (picked.length >= want) break;
        if (!rec.dotNumber || seen.has(rec.dotNumber)) continue;
        seen.add(rec.dotNumber);
        if (have.dots.has(rec.dotNumber) || (rec.mcNumber && have.mcs.has(normMc(rec.mcNumber)))) { stats.skipped++; continue; }
        const s = scoreLead(rec);
        if (s.score < minScore) { stats.belowScore++; continue; }
        picked.push({ ...rec, score: s.score, scoreReasons: s.reasons });
      }
    }
  }
  return { picked, stats, exhausted: open.size === 0, note: notes };
}

/** Preview matches without creating anything or using quota. */
export async function previewLeads(user, criteria, minScore = 0, size = 25) {
  const { picked, stats, exhausted, note } = await collect(user.id, criteria, minScore, size, { pages: 1 });
  return {
    items: picked.map(({ _extra, ...r }) => ({ ...r, cargo: _extra?.cargo || [] })),
    ...stats,
    exhausted,
    note,
    source: census.label,
    retrievedAt: new Date().toISOString(),
  };
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
    const budget = Math.min(gen.batchSize, await remaining(user, 'leadGenMonth'), await remaining(user, 'carriers'));
    const run = { trigger, status: 'ok', scanned: 0, created: 0, skipped: 0, belowScore: 0, message: null };
    const ids = [];
    const createdCarriers = [];
    const now = new Date();

    if (budget <= 0) {
      const { plan } = await effectivePlan(user);
      run.status = 'limited';
      run.message = `Your ${plan?.name || 'current'} plan's monthly lead limit is used up. Upgrade for more leads.`;
    } else {
      try {
        const { picked, stats, exhausted, note } = await collect(user.id, criteria, gen.minScore, budget);
        Object.assign(run, stats);
        const stage = await stageByKey(gen.stageKey || 'lead');
        const list = gen.listId ? await prisma.prospectList.findFirst({ where: { id: gen.listId, ownerId: user.id } }) : null;
        for (const rec of picked) {
          const { _extra, score, scoreReasons, ...fields } = rec;
          try {
            const c = await prisma.carrier.create({
              data: {
                ...fields, ownerId: user.id, stageId: stage.id, source: 'lead_generator', sourceRef: `USDOT ${rec.dotNumber} · ${gen.name}`.slice(0, 190),
                verifiedAt: now, priority: score >= 80 ? 2 : score >= 60 ? 1 : 0,
              },
            });
            await prisma.carrierNote.create({ data: { carrierId: c.id, authorId: user.id, body: `Lead score ${score}/100 from "${gen.name}": ${scoreReasons.join(', ') || 'no signals'}.` } }).catch(() => {});
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
        if (run.created < budget) {
          run.status = 'exhausted';
          run.message = `Found ${run.created} new lead(s); no more matches in the first ${PAGES_PER_STATE * PAGE} census records per state. Widen the criteria for more.`;
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
      } catch (err) {
        run.status = 'error';
        run.message = err instanceof HttpError ? err.message : `Lead generation failed: ${err.message}`;
      }
    }

    const saved = await prisma.leadGenRun.create({
      data: { ...run, generatorId: gen.id, ownerId: user.id, carrierIds: JSON.stringify(ids) },
    });
    await prisma.leadGenerator.update({
      where: { id: gen.id },
      data: { lastRunAt: now, ...(gen.autoRun ? { nextRunAt: nextRunFrom(gen.frequency, now) } : {}) },
    });
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
