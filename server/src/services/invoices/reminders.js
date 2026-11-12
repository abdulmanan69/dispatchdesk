import { prisma } from '../../db.js';
import { notify } from '../../lib/activity.js';
import { queueUserEmail } from '../email/compose.js';
import { invoiceView, pastDue } from './index.js';
import { invoiceText, usd } from './print.js';

/**
 * Collection reminders (daily). Open invoices (sent or partly paid) past their due date reach stages at 0, 7, 15
 * and 30 days overdue; each stage is reported once (Invoice.reminderCount holds the last stage reached) in ONE
 * in-app notification per user per run. Reminder emails to the bill-to address go out only for invoices where the
 * user turned on automatic reminders, from the user's own mailbox (queued; the scheduler sends them).
 * The scan walks users and uses the Invoice(ownerId, status, dueAt) index for each (CROSS JOIN keeps that order),
 * so it never scans the whole Invoice table.
 */
export const STAGES = [0, 7, 15, 30];
const DAY = 86_400_000;

export const stageFor = (daysOverdue) => STAGES.filter((s) => daysOverdue >= s).length;

export async function runCollectionReminders(now = new Date(), { batch = 500, maxBatches = 4 } = {}) {
  let notified = 0;
  let emailed = 0;
  let checked = 0;
  // Stage k is reached once the invoice is STAGES[k - 1] days past due: only rows that reached a new stage match.
  const at = (days) => new Date(now.getTime() - days * DAY);
  for (let round = 0; round < maxBatches; round++) {
    const rows = await prisma.$queryRaw`
      SELECT i.id AS id FROM User u CROSS JOIN Invoice i
      WHERE i.ownerId = u.id AND i.status IN ('sent', 'partial') AND i.dueAt < ${now}
        AND ((i.reminderCount = 0)
          OR (i.reminderCount = 1 AND i.dueAt <= ${at(STAGES[1])})
          OR (i.reminderCount = 2 AND i.dueAt <= ${at(STAGES[2])})
          OR (i.reminderCount = 3 AND i.dueAt <= ${at(STAGES[3])}))
      LIMIT ${batch}`;
    if (!rows.length) break;
    const invoices = await prisma.invoice.findMany({ where: { id: { in: rows.map((x) => x.id) } } });
    const byOwner = new Map();
    const progressed = [];
    for (const inv of invoices) {
      checked += 1;
      // The query only returns invoices past their due date, so this is at least 1.
      const { days } = pastDue(inv, now);
      const stage = Math.max(stageFor(days), inv.reminderCount + 1);
      progressed.push({ inv, stage, days });
      const list = byOwner.get(inv.ownerId) || [];
      list.push({ inv, days });
      byOwner.set(inv.ownerId, list);
    }
    for (const { inv, stage } of progressed) {
      await prisma.invoice.update({ where: { id: inv.id }, data: { reminderCount: stage, lastReminderAt: now } });
    }
    for (const [ownerId, list] of byOwner) {
      const total = list.reduce((s, x) => s + (x.inv.amountCents - x.inv.paidCents), 0);
      const lines = list.slice(0, 5).map(({ inv, days }) => `#${inv.number} ${inv.billToName} · ${usd(inv.amountCents - inv.paidCents)} · ${days} day${days === 1 ? '' : 's'} past due`);
      if (list.length > 5) lines.push(`and ${list.length - 5} more`);
      await notify(ownerId, {
        type: 'invoice_overdue',
        title: list.length === 1 ? `Invoice #${list[0].inv.number} is past due` : `${list.length} invoices are past due (${usd(total)})`,
        body: lines.join('\n'),
        link: '/app/invoices?status=overdue',
      });
      notified += 1;
      // Invoices submitted to a factoring company are collected by the factor: no reminder emails to the broker.
      const auto = list.filter(({ inv }) => {
        const meta = invoiceView(inv).meta;
        return inv.billToEmail && meta.autoRemind && !meta.factoring?.submittedAt;
      });
      if (!auto.length) continue;
      const user = await prisma.user.findUnique({ where: { id: ownerId }, include: { teamMembership: { include: { team: { select: { name: true } } } } } });
      if (!user || user.status !== 'active') continue;
      for (const { inv, days } of auto) {
        const view = invoiceView(inv, now);
        try {
          await queueUserEmail({
            user, toEmail: inv.billToEmail, brokerId: inv.kind === 'freight' ? inv.brokerId : null, carrierId: inv.kind === 'dispatch_fee' ? inv.carrierId : null,
            subject: `Reminder: invoice #${inv.number} is ${days} day${days === 1 ? '' : 's'} past due`,
            body: `Hello,\n\nThis is a reminder that the invoice below was due on ${inv.dueAt.toISOString().slice(0, 10)}. Please let us know when payment is scheduled.\n\n${invoiceText(view, { tz: user.timezone })}`,
            sendNow: false,
          });
          emailed += 1;
        } catch {
          // No mailbox, recipient opted out or daily limit reached: the in-app notification above still went out.
        }
      }
    }
    if (rows.length < batch) break;
  }
  return { checked, notified, emailed };
}
