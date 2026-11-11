import { prisma } from '../../db.js';
import { canViewTeam, teamMemberIds } from '../../lib/access.js';
import { normDot, normMc } from './normalize.js';

/**
 * Team collision guard. Every team member keeps separate carrier records, so two dispatchers can call the same USDOT
 * without knowing it. These helpers say, for a set of USDOT/MC numbers, which ones are already in the user's own CRM
 * (owned or assigned to them) and which ones a teammate has, with who and when they last touched it.
 * Teammates' details are limited to name, stage and last contact; the record id is shared only with users who may
 * view team data. Both lookups use the (ownerId, dotNumber) / (ownerId, mcNumber) unique indexes.
 */

const keyDot = (d) => `dot:${d}`;
const keyMc = (m) => `mc:${m}`;

function cleanKeys({ dots = [], mcs = [] }) {
  return {
    dots: [...new Set(dots.map(normDot).filter(Boolean))].slice(0, 500),
    mcs: [...new Set(mcs.map(normMc).filter(Boolean))].slice(0, 500),
  };
}

function orKeys(dots, mcs) {
  const or = [];
  if (dots.length) or.push({ dotNumber: { in: dots } });
  if (mcs.length) or.push({ mcNumber: { in: mcs } });
  return or;
}

/** Map "dot:123" / "mc:456" -> { id } for carriers the user owns or is assigned. */
export async function ownMatches(user, input) {
  const { dots, mcs } = cleanKeys(input);
  const or = orKeys(dots, mcs);
  if (!or.length) return new Map();
  const mine = user.teamMembership ? { OR: [{ ownerId: user.id }, { assignedToId: user.id }] } : { ownerId: user.id };
  const rows = await prisma.carrier.findMany({ where: { AND: [mine, { OR: or }] }, select: { id: true, dotNumber: true, mcNumber: true }, take: 1000 });
  const out = new Map();
  for (const r of rows) {
    if (r.dotNumber && !out.has(keyDot(r.dotNumber))) out.set(keyDot(r.dotNumber), { id: r.id });
    if (r.mcNumber && !out.has(keyMc(r.mcNumber))) out.set(keyMc(r.mcNumber), { id: r.id });
  }
  return out;
}

/** Map "dot:123" / "mc:456" -> [{ ownerName, assignedToName, stage, lastContactedAt, carrierId? }] for teammates' records. */
export async function teamClaims(user, input) {
  if (!user.teamMembership) return new Map();
  const { dots, mcs } = cleanKeys(input);
  const or = orKeys(dots, mcs);
  if (!or.length) return new Map();
  const team = (await teamMemberIds(user)).filter((id) => id !== user.id);
  if (!team.length) return new Map();
  const shareIds = canViewTeam(user);
  const rows = await prisma.carrier.findMany({
    // Records assigned to this user are already "mine" (ownMatches); NULL-safe comparison for unassigned rows.
    where: { ownerId: { in: team }, AND: [{ OR: or }, { OR: [{ assignedToId: null }, { assignedToId: { not: user.id } }] }] },
    select: {
      id: true, dotNumber: true, mcNumber: true, lastContactedAt: true,
      owner: { select: { name: true } }, assignedTo: { select: { name: true } }, stage: { select: { key: true, name: true } },
    },
    take: 1000,
  });
  const out = new Map();
  const add = (k, v) => { if (!out.has(k)) out.set(k, []); out.get(k).push(v); };
  for (const r of rows) {
    const claim = {
      ownerName: r.owner?.name || 'A teammate',
      assignedToName: r.assignedTo?.name || null,
      stage: r.stage ? { key: r.stage.key, name: r.stage.name } : null,
      lastContactedAt: r.lastContactedAt,
      ...(shareIds ? { carrierId: r.id } : {}),
    };
    if (r.dotNumber) add(keyDot(r.dotNumber), claim);
    if (r.mcNumber && !(r.dotNumber && dots.includes(r.dotNumber))) add(keyMc(r.mcNumber), claim);
  }
  return out;
}

/** Look up both maps for one census-style record { dotNumber, mcNumber }. */
export function matchFor(map, rec) {
  return (rec.dotNumber && map.get(keyDot(normDot(rec.dotNumber)))) || (rec.mcNumber && map.get(keyMc(normMc(rec.mcNumber)))) || null;
}

/** Add { existsInCrm, existingId, teamClaims } to census records for this user. */
export async function annotateRecords(user, items) {
  const input = { dots: items.map((i) => i.dotNumber), mcs: items.map((i) => i.mcNumber) };
  const [own, team] = await Promise.all([ownMatches(user, input), teamClaims(user, input)]);
  return items.map((i) => {
    const mine = matchFor(own, i);
    return { ...i, existsInCrm: !!mine, existingId: mine?.id || null, teamClaims: mine ? [] : matchFor(team, i) || [] };
  });
}
