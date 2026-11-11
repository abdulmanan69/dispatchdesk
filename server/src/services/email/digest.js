import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { DEFAULT_TZ, endOfUserDay, localDayKey, localParts } from '../../lib/timezones.js';
import { pickAccount, sendWithAccount, recordMailboxSend, syncMailboxDay } from './index.js';
import { sendSystemMail } from './system.js';

/**
 * One morning digest email per user (User.notifyDigest + notifyFollowUps), at DIGEST_HOUR in the user's time zone,
 * replacing the old one-email-per-reminder behavior. It lists overdue and today's follow-ups and today's sequence
 * call/text/task steps, plus any sections other features register. Nothing is sent when nothing is due.
 *
 * Delivery: from the user's own connected mailbox (their quota, counted on the mailbox), otherwise platform email
 * with category 'digest', which the platform budget limits so sign-in and password mail always has room
 * (services/email/system.js). Platform digests also need User.notifyEmail and a verified address.
 *
 * Progress is one SystemSetting row (`digest.state`): per time zone, the day handled and a user-id cursor, so a run
 * resumes where the last one stopped and nobody gets two digests on the same day. Users of a page are handled several
 * at a time (each sends through their own mailbox), and the cursor is saved once per page, not once per user.
 */
export const DIGEST_HOUR = 7;
const LAST_HOUR = 20; // after 8 PM local, that day's digest is skipped
const STATE_KEY = 'digest.state';
const ZONES_TTL_MS = 6 * 3600000;
const PAGE = 100;
const LIST = 8;
// Users handled at the same time. Mailboxes belong to one user (pickAccount), so this is also at most one send per
// mailbox at a time.
const CONCURRENCY = 10;

const sections = [];
/**
 * Add a section to the digest. fn(user, { now, end, tz }) -> { title, lines: string[], count? } | null.
 * Lines are plain text; the first 8 are shown. Register once at module load.
 */
export function registerDigestSection(name, fn) {
  if (!sections.some((s) => s.name === name)) sections.push({ name, fn });
}

function when(tz, d) {
  const p = localParts(tz, d);
  const h = p.hour % 12 || 12;
  return `${p.weekday} ${h}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const line = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function followUpSections(user, { now, end, tz }) {
  const select = { dueAt: true, type: true, title: true, note: true, carrier: { select: { companyName: true } } };
  const [overdue, today, overdueCount, todayCount] = await Promise.all([
    prisma.followUp.findMany({ where: { userId: user.id, status: 'pending', dueAt: { lt: now } }, orderBy: { dueAt: 'asc' }, take: LIST, select }),
    prisma.followUp.findMany({ where: { userId: user.id, status: 'pending', dueAt: { gte: now, lte: end } }, orderBy: { dueAt: 'asc' }, take: LIST, select }),
    prisma.followUp.count({ where: { userId: user.id, status: 'pending', dueAt: { lt: now } } }),
    prisma.followUp.count({ where: { userId: user.id, status: 'pending', dueAt: { gte: now, lte: end } } }),
  ]);
  const fmt = (f, past) => line(`${f.carrier?.companyName || 'Carrier'}: ${f.type}, ${past ? 'was due' : 'due'} ${when(tz, f.dueAt)}${f.title || f.note ? `. ${f.title || f.note}` : ''}`).slice(0, 200);
  return [
    overdueCount ? { key: 'overdue', title: `Overdue follow-ups (${overdueCount})`, count: overdueCount, lines: overdue.map((f) => fmt(f, true)) } : null,
    todayCount ? { key: 'today', title: `Follow-ups due today (${todayCount})`, count: todayCount, lines: today.map((f) => fmt(f, false)) } : null,
  ];
}

async function sequenceSection(user, { end }) {
  const rows = await prisma.sequenceEnrollment.findMany({
    where: { userId: user.id, status: 'active', sequence: { active: true }, nextStepAt: { lte: end } },
    orderBy: { nextStepAt: 'asc' }, take: 200,
    select: { sequenceId: true, currentStep: true, sequence: { select: { name: true } }, carrier: { select: { companyName: true, doNotCall: true } } },
  });
  if (!rows.length) return null;
  const steps = await prisma.sequenceStep.findMany({
    where: { sequenceId: { in: [...new Set(rows.map((r) => r.sequenceId))] } }, select: { sequenceId: true, order: true, type: true },
  });
  const typeOf = new Map(steps.map((s) => [`${s.sequenceId}:${s.order}`, s.type]));
  const work = rows.filter((r) => {
    const t = typeOf.get(`${r.sequenceId}:${r.currentStep}`);
    return t && t !== 'email' && !((t === 'call' || t === 'text') && r.carrier.doNotCall);
  });
  if (!work.length) return null;
  return {
    key: 'sequence', title: `Sequence steps due today (${work.length}${rows.length === 200 ? '+' : ''})`, count: work.length,
    lines: work.slice(0, LIST).map((r) => line(`${r.carrier.companyName}: ${typeOf.get(`${r.sequenceId}:${r.currentStep}`)}, step ${r.currentStep + 1} of "${r.sequence.name}"`).slice(0, 200)),
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Build the digest for one user, or null when nothing is due. */
export async function buildDigest(user, now = new Date()) {
  const tz = user.timezone || DEFAULT_TZ;
  const end = endOfUserDay(tz, now);
  const ctx = { now, end, tz };
  const parts = [...await followUpSections(user, ctx), await sequenceSection(user, ctx)];
  for (const s of sections) {
    try {
      const out = await s.fn(user, ctx);
      if (out?.lines?.length) parts.push({ key: s.name, title: out.title, count: out.count ?? out.lines.length, lines: out.lines.map(line) });
    } catch (err) {
      console.error(`[digest] section ${s.name} failed: ${err.message}`);
    }
  }
  const list = parts.filter(Boolean);
  if (!list.length) return null;
  const count = (k) => list.find((s) => s.key === k)?.count || 0;
  const summary = [
    count('today') && `${plural(count('today'), 'follow-up')} due today`,
    count('overdue') && `${count('overdue')} overdue`,
    count('sequence') && plural(count('sequence'), 'sequence step'),
  ].filter(Boolean);
  const subject = summary.length ? `Your day: ${summary.join(', ')}` : 'Your day in DispatchDesk';
  const first = String(user.name || '').split(/\s+/)[0] || 'there';
  const queueUrl = `${config.appUrl}/app/prospecting`;
  const settingsUrl = `${config.appUrl}/app/settings?tab=notifications`;
  const more = (s) => (s.count > s.lines.length ? [`and ${s.count - s.lines.length} more`] : []);
  const text = [
    `Good morning ${first},`, '',
    ...list.flatMap((s) => [s.title, ...s.lines.map((l) => `- ${l}`), ...more(s).map((l) => `  ${l}`), '']),
    `Open your queue: ${queueUrl}`, '',
    `You get this email because the daily digest is on. Turn it off in Settings, Notifications: ${settingsUrl}`,
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">`
    + `<p>Good morning ${esc(first)},</p>`
    + list.map((s) => `<p style="margin:16px 0 4px;font-weight:bold">${esc(s.title)}</p><ul style="margin:0;padding-left:18px">${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}${more(s).map((l) => `<li style="color:#6b7280">${esc(l)}</li>`).join('')}</ul>`).join('')
    + `<p style="margin-top:20px"><a href="${esc(queueUrl)}">Open your queue</a></p>`
    + `<p style="margin-top:24px;font-size:12px;color:#6b7280">You get this email because the daily digest is on. <a href="${esc(settingsUrl)}">Turn it off</a></p></div>`;
  return { subject, text, html, sections: list.map((s) => ({ key: s.key, count: s.count })) };
}

/** Send today's digest to one user. Returns { sent: 'mailbox'|'platform' } or { skipped: reason }. */
export async function sendDigest(user, now = new Date()) {
  if (!user.notifyDigest || !user.notifyFollowUps || user.status !== 'active') return { skipped: 'digest is off' };
  const digest = await buildDigest(user, now);
  if (!digest) return { skipped: 'nothing due' };
  const tz = user.timezone || DEFAULT_TZ;
  const account = await pickAccount(user.id);
  if (account && (await syncMailboxDay(account, tz, now)) < account.dailyLimit) {
    try {
      await sendWithAccount(account, {
        to: user.email, subject: digest.subject, text: digest.text, html: digest.html,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-DispatchDesk': 'digest' },
      });
      await recordMailboxSend(account, tz, new Date());
      return { sent: 'mailbox' };
    } catch (err) {
      console.warn(`[digest] mailbox send failed for ${user.id}, trying platform email: ${err.message}`);
    }
  }
  if (!user.notifyEmail || !user.emailVerifiedAt) return { skipped: 'no mailbox connected' };
  const r = await sendSystemMail({ to: user.email, subject: digest.subject, text: digest.text, html: digest.html, category: 'digest' });
  return r.sent ? { sent: 'platform' } : { skipped: r.reason, budget: !!r.budget };
}

async function readState() {
  const row = await prisma.systemSetting.findUnique({ where: { key: STATE_KEY } });
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}

async function writeState(state) {
  const value = JSON.stringify(state);
  await prisma.systemSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, secret: false }, update: { value } });
}

/**
 * The `email-digest` job: for each time zone where it is past DIGEST_HOUR (and before LAST_HOUR) and today's digests
 * are not finished, page through that zone's users by id and send, CONCURRENCY users at a time. Bounded by maxUsers
 * and a time budget per run; outside every zone's window a run costs one state read.
 */
export async function runDigests(now = new Date(), { maxUsers = 600, budgetMs = 45000, hour = DIGEST_HOUR, concurrency = CONCURRENCY } = {}) {
  const started = Date.now();
  const state = await readState();
  state.zones = state.zones || {};
  let dirty = false;
  if (!state.zoneList || !state.zonesAt || now.getTime() - state.zonesAt > ZONES_TTL_MS) {
    // Distinct zones of users who can get a digest. Refreshed every few hours, not every run.
    const zones = await prisma.user.groupBy({ by: ['timezone'], where: { notifyDigest: true, status: 'active' } });
    state.zoneList = zones.map((z) => z.timezone).filter(Boolean).slice(0, 200);
    state.zonesAt = now.getTime();
    dirty = true;
  }
  const out = { sent: 0, mailbox: 0, platform: 0, skipped: 0, zones: 0 };
  let users = 0;
  const outOfTime = () => users >= maxUsers || Date.now() - started > budgetMs;

  /** Send to the users of one page in order, CONCURRENCY at a time. Returns how many (a prefix) were handled. */
  async function sendPage(page) {
    let next = 0;
    const worker = async () => {
      while (next < page.length && !outOfTime()) {
        const u = page[next++];
        users++;
        try {
          const r = await sendDigest(u, now);
          if (r.sent) { out.sent++; out[r.sent]++; } else out.skipped++;
        } catch (err) {
          out.skipped++;
          console.error(`[digest] ${u.id}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, page.length)) }, worker));
    // Workers take users in order and every started one has finished, so the first `next` users are all done.
    return next;
  }

  for (const tz of state.zoneList) {
    const p = localParts(tz, now);
    const day = localDayKey(tz, now);
    const z = state.zones[tz] && state.zones[tz].day === day ? state.zones[tz] : { day, cursor: null, done: false };
    if (z.done) continue;
    if (p.hour < hour) continue;
    if (p.hour >= LAST_HOUR) { state.zones[tz] = { ...z, done: true }; dirty = true; continue; }
    out.zones++;
    while (!outOfTime()) {
      const page = await prisma.user.findMany({
        where: { timezone: tz, notifyDigest: true, notifyFollowUps: true, status: 'active', ...(z.cursor ? { id: { gt: z.cursor } } : {}) },
        orderBy: { id: 'asc' }, take: PAGE,
      });
      const handled = page.length ? await sendPage(page) : 0;
      if (handled) z.cursor = page[handled - 1].id;
      if (page.length < PAGE && handled === page.length) z.done = true;
      state.zones[tz] = z;
      dirty = true;
      // One state write per page (or partial page when the budget ran out), not one per user.
      await writeState(state);
      if (z.done || handled < page.length) break;
    }
    if (outOfTime()) break;
  }
  // Forget zones nobody uses any more.
  for (const tz of Object.keys(state.zones)) if (!state.zoneList.includes(tz)) { delete state.zones[tz]; dirty = true; }
  if (dirty) await writeState(state);
  return out;
}
