import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { registerUser, createAdmin, prisma } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { invalidatePlans } = await import('../src/lib/plans.js');
const { runTrialReminders } = await import('../src/services/billing/trialReminders.js');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const backdate = async (u, ms) => prisma.user.update({ where: { id: u.user.id }, data: { createdAt: new Date(Date.now() - ms) } });
const types = async (u) => (await prisma.notification.findMany({ where: { userId: u.user.id, type: { startsWith: 'trial_' } } })).map((n) => n.type).sort();

describe('trial reminders', () => {
  let three; let one; let ended; let fresh; let paying; let admin; let old;
  beforeAll(async () => {
    await setSetting('app.trialDays', '14');
    [three, one, ended, fresh, paying, old] = await Promise.all([registerUser(), registerUser(), registerUser(), registerUser(), registerUser(), registerUser()]);
    admin = await createAdmin();
    await backdate(three, 11 * DAY + HOUR); // ends in 3 days
    await backdate(one, 13 * DAY + HOUR); // ends tomorrow
    await backdate(ended, 14 * DAY + 6 * HOUR); // ended 6 hours ago
    await backdate(old, 30 * DAY); // ended long ago: no late "ended" notice
    await backdate(paying, 11 * DAY + HOUR);
    await backdate(admin, 11 * DAY + HOUR);
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    await prisma.subscription.create({ data: { userId: paying.user.id, planId: pro.id, status: 'active', stripeSubscriptionId: `sub_rem_${Date.now()}` } });
    invalidatePlans();
  });
  afterAll(async () => { await setSetting('app.trialDays', ''); invalidatePlans(); });

  it('sends each stage once, only to accounts on a trial', async () => {
    const out = await runTrialReminders(new Date());
    expect(out.sent).toBeGreaterThanOrEqual(3);
    expect(await types(three)).toEqual(['trial_t3']);
    expect(await types(one)).toEqual(['trial_t1']);
    expect(await types(ended)).toEqual(['trial_ended']);
    expect(await types(fresh)).toEqual([]);
    expect(await types(old)).toEqual([]);
    expect(await types(paying)).toEqual([]);
    expect(await types(admin)).toEqual([]);
    const n = await prisma.notification.findFirst({ where: { userId: three.user.id, type: 'trial_t3' } });
    expect(n).toMatchObject({ title: 'Your free trial ends in 3 days', link: '/app/billing' });

    await runTrialReminders(new Date());
    expect(await types(three)).toEqual(['trial_t3']); // not twice
  });

  it('shows the trial funnel to admins and flags a failed renewal to its owner', async () => {
    const stats = (await admin.agent.get('/api/admin/stats')).body;
    expect(stats.billing).toMatchObject({ trialDays: 14 });
    expect(stats.billing.paying).toBeGreaterThanOrEqual(1);
    expect(stats.billing.onTrial).toBeGreaterThanOrEqual(3); // fresh, three, one (and others from earlier files)
    expect(stats.billing.endingSoon).toBeGreaterThanOrEqual(2);
    expect(stats.billing.ended).toBeGreaterThanOrEqual(2);

    expect((await paying.agent.get('/api/auth/me')).body.user.billingAlert).toBeNull();
    await prisma.subscription.updateMany({ where: { userId: paying.user.id }, data: { status: 'past_due' } });
    expect((await paying.agent.get('/api/auth/me')).body.user.billingAlert).toBe('past_due');
  });

  it('does nothing while the trial is off', async () => {
    await setSetting('app.trialDays', '0');
    invalidatePlans();
    expect(await runTrialReminders(new Date())).toMatchObject({ sent: 0, skipped: 'trial off' });
    await setSetting('app.trialDays', '14');
    invalidatePlans();
  });
});
