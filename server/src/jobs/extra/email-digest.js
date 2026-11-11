import { runDigests, DIGEST_HOUR } from '../../services/email/digest.js';
// Registers the Today board's digest section in this process (the scheduler's worker may not have loaded it yet).
import '../../services/fleet/today.js';

/**
 * Morning digest emails: one per user per day at DIGEST_HOUR in the user's own time zone, only when something is
 * due. Sent from the user's mailbox when connected, else platform email within the daily platform budget.
 * Each run handles at most a few hundred users and resumes where the previous run stopped.
 */
export const jobs = [
  {
    name: 'email-digest',
    label: `Daily follow-up digest emails (${DIGEST_HOUR} AM in each user's time zone)`,
    // Every minute on the priority lane; runs outside every zone's morning window return after one state read.
    everyMs: 60000,
    lane: 'priority',
    run: (now) => runDigests(now),
  },
];
