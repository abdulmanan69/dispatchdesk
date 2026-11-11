import { runStaleNegotiations } from '../../services/negotiation/index.js';

/**
 * Broker rate negotiations: every 30 minutes, active negotiations with no broker reply for 48 hours since our last
 * email are marked "needs review" with a "no reply" note and the owner is notified once (up to 200 per run).
 */
export const jobs = [
  {
    name: 'negotiations-stale',
    label: 'Rate negotiations: flag the ones with no broker reply for 48 hours (up to 200 per run)',
    everyMs: 30 * 60_000,
    run: (now) => runStaleNegotiations(now),
  },
];
