import { runRecurringLoads } from '../../services/loads/templates.js';

/**
 * Dedicated lanes: every hour, templates with a weekly schedule get their planned loads created leadDays ahead
 * (pickup weekdays and time in the pickup facility's zone). Batched (200 templates per round, 5 rounds, 20 s budget),
 * most-behind templates first; idempotent through LoadTemplate.generatedTo and a (template, pickup day) check.
 */
export const jobs = [
  {
    name: 'recurring-loads',
    label: 'Dedicated lanes: create planned loads ahead (hourly)',
    everyMs: 60 * 60_000,
    run: (now) => runRecurringLoads(now),
  },
];
