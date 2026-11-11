import { prisma } from '../../db.js';
import { normDot, normMc } from '../carriers/normalize.js';
import { lookupBroker, cachedSnapshot } from './fmcsa.js';
import { computeFlags, topLevel } from './flags.js';

/**
 * Broker vetting card: FMCSA snapshot + flags (services/brokers/flags.js) + the team's private "do not use" flag.
 * Broker.fmcsaSnapshot holds the latest snapshot JSON, Broker.flags a JSON array of flags; the team flag is the entry
 * with source 'team' and survives re-checks. Nothing here ever blocks a load save.
 */
export const TEAM_FLAG = 'team_do_not_use';

export function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export const teamFlagOf = (flags = []) => flags.find((f) => f.code === TEAM_FLAG) || null;

/** API view of a broker's stored vetting. */
export function vettingView(broker) {
  const flags = parseJson(broker?.flags, []);
  const list = Array.isArray(flags) ? flags : [];
  const snapshot = parseJson(broker?.fmcsaSnapshot, null);
  const fmcsaFlags = list.filter((f) => f.code !== TEAM_FLAG);
  return {
    snapshot,
    flags: fmcsaFlags,
    teamFlag: teamFlagOf(list),
    checkedAt: broker?.fmcsaCheckedAt ?? null,
    level: topLevel(list),
    watch: !!broker?.watch,
  };
}

/** Contacts this workspace already trusts for the broker (saved phone and email). */
export const knownContacts = (broker) => ({ phones: [broker?.phone].filter(Boolean), emails: [broker?.email].filter(Boolean) });

/**
 * Look up FMCSA and compute flags. `rateCon` is the contact block from a rate con ({ phone, email }).
 * Returns { snapshot, flags, level }. Throws when FMCSA is unreachable and nothing is cached.
 */
export async function vet({ mc, dot, rateCon = {}, known = {}, previous = null, fresh = false, now = new Date() }) {
  const snapshot = await lookupBroker({ mc, dot }, { fresh, now });
  if (!snapshot) return { snapshot: null, flags: [], level: null };
  const flags = computeFlags(snapshot, { previous, rateCon, known, now });
  return { snapshot, flags, level: topLevel(flags) };
}

/** Vetting from cache only (no network): used by /api/loads/parse so parsing never waits on FMCSA. */
export function cachedVetting({ mc, dot, rateCon = {}, known = {}, previous = null, now = new Date() }) {
  const snapshot = cachedSnapshot({ mc, dot });
  if (!snapshot) return null;
  const flags = computeFlags(snapshot, { previous, rateCon, known, now });
  return { snapshot, flags, level: topLevel(flags) };
}

/** Re-check a saved broker and store the snapshot and flags (keeps the team flag). Returns the updated broker. */
export async function verifyAndStore(broker, { rateCon = {}, fresh = true, now = new Date() } = {}) {
  const mc = normMc(broker.mcNumber);
  const dot = normDot(broker.dotNumber);
  if (!mc && !dot) return null;
  const previous = parseJson(broker.fmcsaSnapshot, null);
  const result = await vet({ mc, dot, rateCon, known: knownContacts(broker), previous, fresh, now });
  const team = teamFlagOf(parseJson(broker.flags, []) || []);
  const flags = [...result.flags, ...(team ? [team] : [])];
  return prisma.broker.update({
    where: { id: broker.id },
    data: { fmcsaSnapshot: JSON.stringify(result.snapshot), flags: JSON.stringify(flags), fmcsaCheckedAt: now },
  });
}

/** Set or clear the team's private "do not use" flag. */
export async function setTeamFlag(broker, { doNotUse, reason, user, now = new Date() }) {
  const list = (parseJson(broker.flags, []) || []).filter((f) => f.code !== TEAM_FLAG);
  if (doNotUse) {
    list.push({ code: TEAM_FLAG, level: 'red', message: reason || 'Marked do not use by your team.', source: 'team', by: user.name, byId: user.id, asOf: now.toISOString() });
  }
  return prisma.broker.update({ where: { id: broker.id }, data: { flags: list.length ? JSON.stringify(list) : null } });
}
