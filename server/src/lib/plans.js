import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { paymentRequired } from './errors.js';
import { broadcast, onBroadcast } from './broadcast.js';
import { DEFAULT_TZ, localParts, startOfUserDay as zonedStartOfDay, zonedTimeToUtc } from './timezones.js';

const LIVE = ['active', 'trialing'];
export const DEFAULT_TIMEZONE = DEFAULT_TZ;

// ---------------------------------------------------------------------------
// Day and month boundaries in the user's own time zone
// ---------------------------------------------------------------------------

// Delegated to lib/timezones.js, so plan counters reset at the same instant the email sender's capacity() check uses.
// A user without a zone gets America/Chicago; an unknown zone name gets the same fallback as lib/timezones.js.

/** Start of the user's current day (local midnight in their time zone). */
export function startOfUserDay(tz, now = new Date()) {
  return zonedStartOfDay(tz || DEFAULT_TZ, now);
}

/** Start of the user's current month (local midnight on the 1st). */
export function startOfUserMonth(tz, now = new Date()) {
  const zone = tz || DEFAULT_TZ;
  const p = localParts(zone, now);
  return zonedTimeToUtc(zone, p.year, p.month, 1, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Limit windows that a time-zone change cannot restart
// ---------------------------------------------------------------------------

/** Audit action written by PATCH /api/profile when the time zone changes (details: { from, to }). */
export const TZ_CHANGE_ACTION = 'profile.timezone_changed';
const TZ_LOOKBACK_MS = 48 * 3600_000;
const ZONES_TTL_MS = 60_000;
const ZONES_MAX = 5000;
const zonesCache = new Map(); // `${userId}|${currentTz}` -> { at, zones }

/**
 * Zones the user switched away from in the last two days. Daily and monthly limits count from the EARLIEST local
 * midnight among these and the current zone, so picking a zone whose midnight just passed does not reset a count.
 * Without a recent change this is just the current zone (one indexed lookup, cached for a minute per process).
 */
async function recentZones(user, now) {
  const key = `${user.id}|${user.timezone || ''}`;
  const hit = zonesCache.get(key);
  if (hit && now.getTime() - hit.at < ZONES_TTL_MS && hit.at <= now.getTime()) return hit.zones;
  const rows = await prisma.auditLog.findMany({
    where: { actorId: user.id, action: TZ_CHANGE_ACTION, createdAt: { gte: new Date(now.getTime() - TZ_LOOKBACK_MS) } },
    select: { details: true }, orderBy: { createdAt: 'desc' }, take: 20,
  });
  const zones = [...new Set(rows.map((r) => { try { return JSON.parse(r.details || '{}').from; } catch { return null; } }).filter(Boolean))];
  zonesCache.delete(key);
  if (zonesCache.size >= ZONES_MAX) zonesCache.delete(zonesCache.keys().next().value);
  zonesCache.set(key, { at: now.getTime(), zones });
  return zones;
}

const earliest = (dates) => new Date(Math.min(...dates.map((d) => d.getTime())));

/** Where "today" starts for plan and mailbox limits: the earliest local midnight among the user's recent zones. */
export async function limitDayStart(user, now = new Date()) {
  const zones = [user.timezone, ...(await recentZones(user, now))];
  return earliest(zones.map((z) => startOfUserDay(z, now)));
}

/** Where "this month" starts for plan limits (same rule as limitDayStart). */
export async function limitMonthStart(user, now = new Date()) {
  const zones = [user.timezone, ...(await recentZones(user, now))];
  return earliest(zones.map((z) => startOfUserMonth(z, now)));
}

// ---------------------------------------------------------------------------
// Effective plan (cached 10 s per user, cleared in every process when billing changes)
// ---------------------------------------------------------------------------

const PLAN_TTL_MS = 10_000;
const PLAN_CACHE_MAX = 5000;
const planCache = new Map(); // `${userId}|${teamId}` -> { at, value }
let planGeneration = 0;
onBroadcast('plans', () => { planGeneration += 1; planCache.clear(); });

/** A subscription, plan or team membership changed: drop cached plans in every process. */
export function invalidatePlans() { broadcast('plans'); }

/** Active subscription for the user directly, or through their team. Status comes only from verified Stripe events. */
export async function activeSubscription(user) {
  const teamId = user.teamMembership?.teamId;
  return prisma.subscription.findFirst({
    where: {
      status: { in: LIVE },
      AND: [
        { OR: [{ userId: user.id, teamId: null }, ...(teamId ? [{ teamId }] : [])] },
        // Plans granted by an admin (no Stripe subscription) stop at their end date; Stripe plans follow webhooks.
        { OR: [{ stripeSubscriptionId: { not: null } }, { currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }] },
      ],
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
}

/** { plan, subscription } for the user. Treat the result as read-only: it may be shared by concurrent requests. */
export async function effectivePlan(user) {
  const key = `${user.id}|${user.teamMembership?.teamId || ''}`;
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.value;
  const gen = planGeneration;
  const sub = await activeSubscription(user);
  const value = sub
    ? { plan: sub.plan, subscription: sub }
    : { plan: await prisma.plan.findUnique({ where: { key: 'free' } }), subscription: null };
  // Do not cache a result read before a concurrent invalidation.
  if (gen === planGeneration) {
    planCache.delete(key);
    if (planCache.size >= PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value);
    planCache.set(key, { at: Date.now(), value });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Usage counters and limits
// ---------------------------------------------------------------------------

// Each counter runs only when asked for. Daily and monthly counters reset at the user's local midnight (the earliest
// one among zones used in the last two days, see limitDayStart).
const COUNTERS = {
  carriers: (u) => prisma.carrier.count({ where: { ownerId: u.id } }),
  emailsToday: async (u, t) => prisma.email.count({ where: { userId: u.id, status: { in: ['sent', 'sending'] }, sentAt: { gte: await t.day() } } }),
  aiMonth: async (u, t) => prisma.aIMessage.count({ where: { role: 'user', conversation: { userId: u.id }, createdAt: { gte: await t.month() } } }),
  sequences: (u) => prisma.emailSequence.count({ where: { ownerId: u.id } }),
  automations: (u) => prisma.automation.count({ where: { ownerId: u.id } }),
  discoveryToday: async (u, t) => prisma.carrier.count({ where: { ownerId: u.id, source: { in: ['fmcsa_census', 'fmcsa_qc'] }, createdAt: { gte: await t.day() } } }),
  leadGenMonth: async (u, t) => (await prisma.leadGenRun.aggregate({ where: { ownerId: u.id, createdAt: { gte: await t.month() } }, _sum: { created: true } }))._sum.created || 0,
  leadGenerators: (u) => prisma.leadGenerator.count({ where: { ownerId: u.id } }),
};
export const USAGE_KEYS = Object.keys(COUNTERS);

/** Usage for the requested counters only (default: all of them, for the Billing page). */
export async function usage(user, keys = USAGE_KEYS) {
  const now = new Date();
  let day; let month;
  const t = { day: () => (day ??= limitDayStart(user, now)), month: () => (month ??= limitMonthStart(user, now)) };
  const list = [...new Set(keys)].filter((k) => COUNTERS[k]);
  const values = await Promise.all(list.map((k) => COUNTERS[k](user, t)));
  return Object.fromEntries(list.map((k, i) => [k, values[i]]));
}

const LIMITS = {
  carriers: ['maxCarriers', 'carriers', 'carrier records'],
  emailsToday: ['dailyEmailLimit', 'emailsToday', 'emails per day'],
  aiMonth: ['monthlyAiMessages', 'aiMonth', 'AI messages this month'],
  sequences: ['maxSequences', 'sequences', 'sequences'],
  automations: ['maxAutomations', 'automations', 'automations'],
  discoveryToday: ['maxDiscoveryPerDay', 'discoveryToday', 'discovered leads saved per day'],
  leadGenMonth: ['monthlyLeadGenLimit', 'leadGenMonth', 'generated leads per month'],
  leadGenerators: ['maxLeadGenerators', 'leadGenerators', 'lead generators'],
};

/** Throw 402 when adding `adding` units would exceed the plan limit. A limit of -1 means unlimited. Runs one counter. */
export async function assertLimit(user, kind, adding = 1) {
  const [field, usageKey, label] = LIMITS[kind];
  const { plan } = await effectivePlan(user);
  const limit = plan?.[field] ?? 0;
  if (limit < 0) return;
  const used = (await usage(user, [usageKey]))[usageKey];
  if (used + adding > limit) {
    throw paymentRequired(`Your ${plan?.name || 'current'} plan allows ${limit} ${label}. Upgrade for higher limits.`, { kind, limit, used });
  }
}

/** Units left for one limit (Infinity when unlimited). */
export async function remaining(user, kind) {
  return (await remainingMany(user, [kind]))[kind];
}

/** Units left for several limits with one plan lookup and only the needed counters, e.g. ['discoveryToday', 'carriers']. */
export async function remainingMany(user, kinds) {
  const { plan } = await effectivePlan(user);
  const out = {};
  const needed = [];
  for (const kind of kinds) {
    const [field, usageKey] = LIMITS[kind];
    const limit = plan?.[field] ?? 0;
    if (limit < 0) out[kind] = Infinity;
    else needed.push([kind, usageKey, limit]);
  }
  if (needed.length) {
    const u = await usage(user, needed.map(([, k]) => k));
    for (const [kind, key, limit] of needed) out[kind] = Math.max(0, limit - u[key]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File storage quota
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const envMb = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Storage per account in MB: Free, any individual paid plan, and Teams plans (per member, pooled). Override with env vars. */
export const STORAGE_MB = {
  free: envMb('STORAGE_FREE_MB', 500),
  paid: envMb('STORAGE_PAID_MB', 5 * 1024),
  teamPerMember: envMb('STORAGE_TEAM_MB_PER_MEMBER', 20 * 1024),
};

export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1024 * MB) return `${(v / (1024 * MB)).toFixed(v >= 10 * 1024 * MB ? 0 : 1).replace(/\.0$/, '')} GB`;
  if (v >= MB) return `${(v / MB).toFixed(v >= 10 * MB ? 0 : 1).replace(/\.0$/, '')} MB`;
  return `${Math.ceil(v / 1024)} KB`;
}

async function fileSize(subdir, storedName) {
  if (!storedName) return 0;
  try { return (await fs.stat(path.join(config.uploadDir, subdir, path.basename(storedName)))).size; } catch { return 0; }
}

/**
 * Whose storage an upload uses: a Teams subscription pools storage for every member (per-member allowance x seats),
 * otherwise the user's own plan applies. Returns { scope, userIds, limitBytes, planName }.
 */
export async function storageAccount(user) {
  const { plan, subscription } = await effectivePlan(user);
  if (subscription?.teamId && plan?.perSeat) {
    const members = await prisma.teamMember.findMany({ where: { teamId: subscription.teamId }, select: { userId: true }, take: 1000 });
    const userIds = [...new Set([user.id, ...members.map((m) => m.userId)])];
    const seats = Math.max(userIds.length, subscription.seats || 1);
    return { scope: 'team', userIds, limitBytes: Math.round(STORAGE_MB.teamPerMember * seats * MB), planName: plan.name };
  }
  const paid = !!subscription && plan?.key !== 'free';
  return { scope: 'user', userIds: [user.id], limitBytes: Math.round((paid ? STORAGE_MB.paid : STORAGE_MB.free) * MB), planName: plan?.name || 'Free' };
}

// Avatars have no size column: their sizes are read from disk a few at a time (the libuv pool is shared with DNS,
// compression and crypto) and cached per account for a minute in each process (at most one file per user).
const STAT_CONCURRENCY = 8;
const FILES_TTL_MS = 60_000;
const FILES_CACHE_MAX = 1000;
const filesCache = new Map(); // sorted user ids -> { at, bytes }

async function statAll(files) {
  let total = 0;
  for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
    const sizes = await Promise.all(files.slice(i, i + STAT_CONCURRENCY).map(([dir, name]) => fileSize(dir, name)));
    total += sizes.reduce((s, n) => s + n, 0);
  }
  return total;
}

async function diskFileBytes(ids) {
  const key = [...ids].sort().join(',');
  const hit = filesCache.get(key);
  if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.bytes;
  const avatars = await prisma.user.findMany({ where: { id: { in: ids }, avatarPath: { not: null } }, select: { avatarPath: true } });
  const bytes = await statAll(avatars.map((a) => ['avatars', a.avatarPath]));
  filesCache.delete(key);
  if (filesCache.size >= FILES_CACHE_MAX) filesCache.delete(filesCache.keys().next().value);
  filesCache.set(key, { at: Date.now(), bytes });
  return bytes;
}

/**
 * Bytes stored by these accounts: documents, AI knowledge files and marketplace listing images they own (sizes are
 * on the rows, set at upload: one SUM each, always current), plus avatars (sizes read from disk, at most a minute
 * old). Knowledge files and listing images stored before their size column existed count once the size-backfill
 * job (jobs/extra/size-backfill.js) has recorded them.
 */
export async function storageUsedBytes(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return 0;
  const [docs, knowledge, listings, avatars] = await Promise.all([
    prisma.document.aggregate({ where: { ownerId: { in: ids } }, _sum: { sizeBytes: true } }),
    prisma.aIKnowledgeDocument.aggregate({ where: { ownerId: { in: ids } }, _sum: { sizeBytes: true } }),
    prisma.marketplaceListing.aggregate({ where: { sellerId: { in: ids }, imagePath: { not: null } }, _sum: { sizeBytes: true } }),
    diskFileBytes(ids),
  ]);
  return (docs._sum.sizeBytes || 0) + (knowledge._sum.sizeBytes || 0) + (listings._sum.sizeBytes || 0) + avatars;
}

/** { scope, limitBytes, usedBytes, remainingBytes, planName } for the Billing page and upload checks. */
export async function storageStatus(user) {
  const acct = await storageAccount(user);
  const usedBytes = await storageUsedBytes(acct.userIds);
  return { scope: acct.scope, planName: acct.planName, limitBytes: acct.limitBytes, usedBytes, remainingBytes: Math.max(0, acct.limitBytes - usedBytes) };
}

export function storageFullError(status, addingBytes = 0) {
  const who = status.scope === 'team' ? 'Your team\'s' : 'Your';
  return paymentRequired(
    `Not enough file storage. ${who} ${status.planName} plan includes ${formatBytes(status.limitBytes)} and ${formatBytes(status.usedBytes)} is in use${addingBytes ? `; this file needs ${formatBytes(addingBytes)}` : ''}. Delete files you no longer need or upgrade for more space.`,
    { kind: 'storage', code: 'STORAGE_FULL', limitBytes: status.limitBytes, usedBytes: status.usedBytes },
  );
}

/** Throw 402 when storing `addingBytes` more would exceed the account's storage. Returns the status otherwise. */
export async function assertStorage(user, addingBytes, { creditBytes = 0 } = {}) {
  const status = await storageStatus(user);
  if (status.usedBytes - creditBytes + addingBytes > status.limitBytes) throw storageFullError(status, addingBytes);
  return status;
}
