import { runAuthorityRefresh } from '../../services/carriers/authorityRefresh.js';

/**
 * Carrier authority refresh: once a day, re-check the operating authority (FMCSA licensing dataset) of up to 2,000
 * leads with an MC number that are not customers and were not checked in the last 7 days (never-checked first), 200
 * per request. Leads that lost their authority have their sequences stopped and the owner gets one notification.
 * Runs under the database job lock like every maintenance job. See services/carriers/authorityRefresh.js.
 */
export const jobs = [
  {
    name: 'carrier-authority-refresh',
    label: 'Re-check operating authority of leads (FMCSA licensing), up to 2,000 a day; stop sequences of leads that lost it',
    dailyAtUtc: 11, // 5-6 AM Central, before the dispatch day and sequence sends
    run: (now) => runAuthorityRefresh(now),
  },
];
