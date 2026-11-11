import { runCollectionReminders } from '../../services/invoices/reminders.js';

/**
 * Collection reminders: once a day (14:00 UTC, morning in US time zones) report invoices that reached 0, 7, 15 or
 * 30 days past due in one notification per user, and queue reminder emails only for invoices where the user turned
 * automatic reminders on. Batched (500 invoices per round, 4 rounds per run).
 */
export const jobs = [
  {
    name: 'invoice-reminders',
    label: 'Overdue invoice reminders (daily, one notification per user)',
    dailyAtUtc: 14,
    run: (now) => runCollectionReminders(now),
  },
];
