import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { getSetting } from '../../lib/settings.js';
import { notify } from '../../lib/activity.js';
import { effectivePlan } from '../../lib/plans.js';
import { sendSystemMail } from '../email/system.js';
import { platformEmail } from '../email/platformTemplate.js';
import { trialSettings, TRIAL_LAUNCH } from './trial.js';

const DAY = 86_400_000;

/**
 * Trial reminders (daily job): an in-app notice and an email 3 days and 1 day before the free trial ends, and on the
 * day it ends. Each stage is sent once per user (the notification is the record). Accounts with a plan, platform
 * admins and suspended accounts get nothing.
 */
export const TRIAL_STAGES = {
  t3: {
    subject: (app) => `Your ${app} trial ends in 3 days`,
    title: 'Your free trial ends in 3 days',
    lines: (app, plan, end) => [`Your free trial with every ${plan} feature ends on ${end}.`, 'Choose a plan now to keep adding carriers, calling and running sequences without a break.'],
  },
  t1: {
    subject: (app) => `Your ${app} trial ends tomorrow`,
    title: 'Your free trial ends tomorrow',
    lines: (app, plan, end) => [`Your free trial ends tomorrow (${end}).`, 'Pick a plan today so nothing stops: scheduled emails, follow-ups and lead generation keep running.'],
  },
  ended: {
    subject: (app) => `Your ${app} trial has ended`,
    title: 'Your free trial has ended',
    lines: () => ['Your account is now read-only. Your carriers, loads and notes are safe, and you can still view and export them.', 'Choose a plan to start working again. It takes a minute.'],
  },
};

export function stageFor(trial, now = new Date()) {
  if (!trial) return null;
  if (trial.active) return trial.daysLeft === 3 ? 't3' : trial.daysLeft === 1 ? 't1' : null;
  // "Ended" goes out once, within two days of the end (a later first run does not send a stale notice).
  return trial.locked && now.getTime() - new Date(trial.endsAt).getTime() < 2 * DAY ? 'ended' : null;
}

/** One run. `now` is injectable for tests. Returns { checked, sent }. */
export async function runTrialReminders(now = new Date()) {
  const t = await trialSettings();
  if (!t.days) return { checked: 0, sent: 0, skipped: 'trial off' };
  // Only accounts whose trial ends between yesterday-ish and 4 days from now can be due.
  const from = new Date(now.getTime() - (t.days + 3) * DAY);
  const to = new Date(now.getTime() - (t.days - 4) * DAY);
  const launchEnd = TRIAL_LAUNCH.getTime() + t.days * DAY;
  const launchCohort = now.getTime() > launchEnd - 4 * DAY && now.getTime() < launchEnd + 3 * DAY;
  const users = await prisma.user.findMany({
    where: {
      status: 'active',
      OR: [{ createdAt: { gte: from, lte: to } }, ...(launchCohort ? [{ createdAt: { lte: TRIAL_LAUNCH } }] : [])],
    },
    select: { id: true, name: true, email: true, createdAt: true, roleId: true, teamMembership: true },
    take: 5000,
  });
  const appName = (await getSetting('app.name')) || 'DispatchDesk';
  let sent = 0;
  for (const u of users) {
    const { trial, subscription } = await effectivePlan(u);
    if (subscription) continue;
    const stage = stageFor(trial, now);
    if (!stage) continue;
    const type = `trial_${stage}`;
    if (await prisma.notification.findFirst({ where: { userId: u.id, type }, select: { id: true } })) continue;
    const s = TRIAL_STAGES[stage];
    const end = new Date(trial.endsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
    const lines = s.lines(appName, trial.planName || 'Pro', end);
    await notify(u.id, { type, title: s.title, body: lines.join(' '), link: '/app/billing' });
    const mail = platformEmail({
      appName,
      preheader: lines[0],
      heading: s.title,
      paragraphs: [`Hi ${u.name || 'there'},`, ...lines],
      button: { label: 'Choose a plan', url: `${config.appUrl}/app/billing` },
      after: ['Have a code from us? Enter it on the same page under "Have a code?".'],
      footer: `You get this email because you have a ${appName} account on a free trial.`,
    });
    await sendSystemMail({ to: u.email, subject: s.subject(appName), text: mail.text, html: mail.html, category: 'notice' })
      .catch((err) => console.error(`[trial] reminder email to user ${u.id} failed: ${err.message}`));
    sent += 1;
  }
  return { checked: users.length, sent };
}
