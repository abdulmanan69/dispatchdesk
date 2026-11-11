import { runWatchlist } from '../../services/brokers/watchlist.js';

/**
 * FMCSA watchlist: every 10 minutes inside the nightly window (05:00-12:00 UTC), re-check up to 1,000 customer
 * carriers and 1,000 watched brokers that were not checked in the last 20 hours, and notify owners about authority,
 * insurance, bond, out-of-service and contact changes. Free public data (FMCSA census; QCMobile when configured).
 */
export const jobs = [
  {
    name: 'fmcsa-watchlist',
    label: 'FMCSA watchlist: re-check of customer carriers and watched brokers, about daily (up to 1,000 each per run)',
    everyMs: 10 * 60_000,
    run: (now) => runWatchlist(now),
  },
];
