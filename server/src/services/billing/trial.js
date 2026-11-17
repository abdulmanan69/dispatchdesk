import { getSettings } from '../../lib/settings.js';

/**
 * Free trial: an account without a paid (or granted) plan gets the trial plan's features for `app.trialDays` days
 * (default 14) from sign-up, then becomes read-only until it picks a plan (middleware/auth.js requireActivePlan).
 * Accounts that existed before trials began start their trial on TRIAL_LAUNCH. `app.trialDays` = 0 turns the trial
 * off: accounts without a plan then stay on the Free plan with its limits and are never locked.
 */
// TRIAL_LAUNCH (env) moves the start for tests.
export const TRIAL_LAUNCH = new Date(process.env.TRIAL_LAUNCH || '2026-11-17T00:00:00Z');
export const DEFAULT_TRIAL_DAYS = 14;
const DAY = 86_400_000;

export async function trialSettings() {
  const s = await getSettings(['app.trialDays', 'app.trialPlan']);
  // A cleared setting ('') means the default: TRIAL_DAYS from the environment, else 14.
  const raw = String(s['app.trialDays'] ?? '').trim() || process.env.TRIAL_DAYS || String(DEFAULT_TRIAL_DAYS);
  const n = Number.parseInt(raw, 10);
  return { days: Number.isFinite(n) && n >= 0 ? Math.min(n, 365) : DEFAULT_TRIAL_DAYS, planKey: s['app.trialPlan'] || 'pro' };
}

/** When the user's trial ends (or ended). */
export function trialEndFor(user, days) {
  const start = Math.max(new Date(user.createdAt || Date.now()).getTime(), TRIAL_LAUNCH.getTime());
  return new Date(start + days * DAY);
}

/**
 * Trial state for a user with no live subscription: { active, endsAt, daysLeft, locked }.
 * `enabled` false (app.trialDays = 0): the Free plan applies and nothing is locked.
 */
export function trialState(user, days, now = new Date()) {
  if (!days) return { enabled: false, active: false, locked: false, endsAt: null, daysLeft: 0 };
  const endsAt = trialEndFor(user, days);
  const left = endsAt.getTime() - now.getTime();
  return { enabled: true, active: left > 0, locked: left <= 0, endsAt, daysLeft: Math.max(0, Math.ceil(left / DAY)) };
}
