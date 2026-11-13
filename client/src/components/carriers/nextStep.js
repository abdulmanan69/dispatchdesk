import { authorityProblem } from './shared.jsx';

/**
 * The one next step for a carrier record, from what the CRM already knows: stage, follow-ups, last contact, the
 * dispatch agreement link, the active sequence, the FMCSA verdict and the carrier's local time. Pure: the carrier
 * page renders it as the "Next step" bar under the header.
 *
 * Returns { key, tone, title, detail, action, idleDays } where action is { kind, label } or null:
 *   call | email | followup | onboarding | agreement | check | convert | customer | sequence
 * tone: red (blocked or overdue), amber (waiting too long), green (ready to move on), brand (normal), gray (nothing to do).
 */

// Days without contact before a record "goes stale" in each stage (Pipedrive-style rotting).
export const IDLE_DAYS = { lead: 14, prospecting: 7, opportunity: 5, trial: 3 };
const DAY = 86_400_000;

const rel = (d, now) => {
  const ms = new Date(d).getTime() - now.getTime();
  const abs = Math.abs(ms);
  const fmt = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const span = abs < 3_600_000 ? fmt(Math.max(1, Math.round(abs / 60_000)), 'minute') : abs < DAY ? fmt(Math.round(abs / 3_600_000), 'hour') : fmt(Math.round(abs / DAY), 'day');
  return ms >= 0 ? `in ${span}` : `${span} ago`;
};

function reachAction(c, { followUp = false } = {}) {
  if (c.phone && !c.doNotCall) return { kind: 'call', label: followUp ? 'Call now' : 'Call' };
  if (c.email && !c.doNotEmail) return { kind: 'email', label: 'Email' };
  return null;
}

export function nextStepFor(c, { callWindow = null, now = new Date() } = {}) {
  const stage = c.stage?.key || 'lead';
  const idleDays = c.lastContactedAt ? Math.floor((now.getTime() - new Date(c.lastContactedAt).getTime()) / DAY) : null;
  const stale = IDLE_DAYS[stage] != null && idleDays != null && idleDays >= IDLE_DAYS[stage];
  const pending = (c.followUps || []).filter((f) => f.status === 'pending').sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))[0] || null;
  const verdict = c.fmcsaVerdict || null;
  const ob = c.onboarding || null;
  const out = (o) => ({ idleDays, ...o });

  if (stage === 'archived') return out({ key: 'archived', tone: 'gray', title: 'Archived', detail: 'Move it to a stage to work this carrier again.', action: null });
  if (c.doNotCall && c.doNotEmail) return out({ key: 'paused', tone: 'gray', title: 'Contact paused', detail: 'Do-not-call and do-not-email are on.', action: null });

  // Never book or onboard a carrier FMCSA does not allow to haul.
  if (stage !== 'customer' && (verdict?.level === 'fail' || authorityProblem(c.authorityStatus))) {
    return out({
      key: 'check', tone: 'red', title: 'Check this carrier before you work with it',
      detail: verdict?.level === 'fail' ? verdict.text : c.operatingStatus || 'FMCSA does not show active operating authority.',
      action: { kind: 'check', label: 'Open carrier check' },
    });
  }

  if (pending) {
    const due = new Date(pending.dueAt);
    const overdue = due.getTime() < now.getTime() - 15 * 60_000;
    const soon = due.getTime() <= now.getTime() + 3_600_000;
    if (overdue || soon) {
      return out({
        key: 'followup_due', tone: overdue ? 'red' : 'amber',
        title: `${overdue ? 'Overdue' : 'Due now'}: ${pending.title || 'follow-up'}`,
        detail: `Follow-up ${overdue ? 'was due' : 'due'} ${rel(due, now)}${pending.notes ? ` · ${pending.notes}` : ''}`,
        action: reachAction(c, { followUp: true }) || { kind: 'followup', label: 'Open follow-ups' },
      });
    }
  }

  if (stage === 'customer') {
    return out({ key: 'customer', tone: 'brand', title: 'Customer: keep their trucks moving', detail: 'Book loads, send weekly statements and share the carrier portal from the customer profile.', action: c.customer ? { kind: 'customer', label: 'Open customer' } : null });
  }

  if (stage === 'opportunity' || stage === 'trial') {
    if (!ob || ['revoked', 'expired'].includes(ob.status)) {
      return out({
        key: 'agreement_send', tone: stale ? 'amber' : 'brand', title: ob ? 'Send a new agreement link' : 'Send the dispatch agreement',
        detail: `${ob ? `The last link ${ob.status === 'expired' ? 'expired' : 'was revoked'}. ` : ''}One link: they sign on their phone and upload the W-9, insurance and authority themselves.`,
        action: { kind: 'onboarding', label: 'Send agreement link' },
      });
    }
    if (ob.status === 'signed') {
      return out({ key: 'agreement_signed', tone: 'green', title: 'Agreement signed: make them a customer', detail: `Signed ${rel(ob.signedAt, now)}.`, action: { kind: 'convert', label: 'Move to Customers' } });
    }
    const waiting = Math.floor((now.getTime() - new Date(ob.sentAt).getTime()) / DAY);
    return out({
      key: 'agreement_waiting', tone: waiting >= 2 ? 'amber' : 'brand',
      title: ob.viewedAt ? 'They opened the agreement but have not signed' : 'Waiting for them to open the agreement',
      detail: `Sent ${rel(ob.sentAt, now)}${ob.viewedAt ? `, opened ${rel(ob.viewedAt, now)}` : ''}. A short call usually gets it signed.`,
      action: reachAction(c, { followUp: true }) || { kind: 'agreement', label: 'View agreement' },
    });
  }

  const enrollment = (c.enrollments || []).find((e) => e.status === 'active');
  if (enrollment) {
    return out({
      key: 'sequence', tone: 'brand', title: `In sequence: ${enrollment.sequence?.name || 'sequence'}`,
      detail: enrollment.step ? `Step ${enrollment.step.order} (${enrollment.step.type}) ${enrollment.nextStepAt ? rel(enrollment.nextStepAt, now) : 'next'}. A reply stops it.` : 'Running.',
      action: { kind: 'sequence', label: 'View sequence' },
    });
  }

  if (!c.lastContactedAt) {
    const when = callWindow?.localTime ? (callWindow.callable ? `It is ${callWindow.localTime} there: a good time to call.` : callWindow.recommendation) : null;
    return out({ key: 'first_touch', tone: 'brand', title: c.phone && !c.doNotCall ? 'Make the first call' : 'Send the first email', detail: when || 'No contact logged yet.', action: reachAction(c) });
  }
  if (pending) {
    return out({ key: 'followup_set', tone: stale ? 'amber' : 'gray', title: `Next: ${pending.title || 'follow-up'}`, detail: `Due ${rel(pending.dueAt, now)} · last contact ${rel(c.lastContactedAt, now)}`, action: reachAction(c, { followUp: true }) });
  }
  return out({
    key: 'followup_missing', tone: stale ? 'amber' : 'brand',
    title: stale ? `No contact in ${idleDays} days` : 'Set the next follow-up',
    detail: `Last contact ${rel(c.lastContactedAt, now)} and nothing scheduled. Interested? Move it to Opportunities and send the agreement.`,
    action: { kind: 'followup', label: 'Schedule follow-up' },
  });
}
