import { prisma } from '../../db.js';
import { remaining, limitDayStart } from '../../lib/plans.js';
import { DEFAULT_TZ } from '../../lib/timezones.js';
import { syncMailboxDay } from '../email/index.js';

/**
 * How many emails can still go out today from this mailbox under the mailbox's own daily limit and the plan's daily
 * email limit. Queued emails beyond that are not lost: the scheduler sends them on the following days, one at a time
 * per mailbox cooldown. Used to tell the user before a bulk send what will happen.
 */
export async function sendCapacity(user, account) {
  const planLeft = await remaining(user, 'emailsToday');
  const tz = user.timezone || DEFAULT_TZ;
  const mailboxLeft = account ? Math.max(0, (account.dailyLimit || 0) - await syncMailboxDay(account, tz, new Date(), { since: await limitDayStart(user) })) : 0;
  // Emails already due from this mailbox take today's capacity first (index Email(emailAccountId, status, ...)).
  const waiting = account ? await prisma.email.count({ where: { emailAccountId: account.id, status: 'scheduled', scheduledAt: { lte: new Date() } } }) : 0;
  return {
    mailbox: account ? { id: account.id, label: account.label, fromEmail: account.fromEmail, dailyLimit: account.dailyLimit, cooldownSeconds: account.cooldownSeconds } : null,
    mailboxLeftToday: mailboxLeft,
    planLeftToday: Number.isFinite(planLeft) ? planLeft : null,
    sendableToday: Math.max(0, Math.min(mailboxLeft, Number.isFinite(planLeft) ? planLeft : Infinity) - waiting),
    alreadyWaiting: waiting,
  };
}

/** One-line explanation of when `n` queued emails will go out. */
export function capacityMessage(n, cap) {
  if (!n) return 'Nothing was queued.';
  const today = Math.min(n, cap.sendableToday);
  const cooldown = cap.mailbox?.cooldownSeconds ? `, ${cap.mailbox.cooldownSeconds} seconds apart` : '';
  if (today >= n) return `${n} email${n === 1 ? '' : 's'} queued. They go out from your mailbox in the background${cooldown}.`;
  return `${n} email${n === 1 ? '' : 's'} queued. About ${today} can go out today${cooldown}; the rest go out on the next days within your mailbox and plan limits.`;
}
