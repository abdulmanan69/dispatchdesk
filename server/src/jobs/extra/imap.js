import { pollDueMailboxes } from '../../services/email/imap.js';

/**
 * Reply, bounce and Google Voice detection for mailboxes that turned it on (Email → Mailboxes →
 * "Detect replies and bounces"). Each run checks the most overdue recently active mailboxes, several at a time, within a time
 * budget, reading only messages newer than the last one seen. A reply stops the carrier's sequence; a bounce
 * suppresses the address.
 */
export const jobs = [
  {
    name: 'imap-replies',
    label: 'Check connected inboxes for replies, bounces and Google Voice notices',
    // Every 3 minutes on the priority lane, so a carrier's reply stops its sequence promptly.
    everyMs: 3 * 60000,
    lane: 'priority',
    run: (now) => pollDueMailboxes(now),
  },
];
