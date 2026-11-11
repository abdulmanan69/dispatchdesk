import { api } from '../../lib/api.js';

/**
 * Call outcomes, in the order of the dialer hotkeys 1-9 then 0. Mirrors server/src/lib/constants.js CALL_OUTCOMES.
 */
export const CALL_OUTCOMES = ['no_answer', 'busy', 'voicemail', 'interested', 'not_interested', 'call_back', 'follow_up', 'converted', 'wrong_number', 'do_not_call'];
export const OUTCOME_HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
export const outcomeForKey = (key) => { const i = OUTCOME_HOTKEYS.indexOf(key); return i >= 0 ? CALL_OUTCOMES[i] : null; };

const LABELS = {
  no_answer: 'No answer', busy: 'Busy', voicemail: 'Voicemail', interested: 'Interested', not_interested: 'Not interested',
  call_back: 'Call back', follow_up: 'Follow up', converted: 'Converted', wrong_number: 'Wrong number', do_not_call: 'Do not call',
};
/** Sentence-case label for an outcome (also used for non-call results in the dialer summary). */
export const outcomeLabel = (o) => LABELS[o] || String(o || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const OUTCOME_HINTS = {
  no_answer: 'Schedules a call-back next business day (carrier local time).',
  busy: 'Schedules a call-back next business day.',
  voicemail: 'Schedules a call-back next business day.',
  interested: 'Moves the carrier to Opportunities and ends active sequences.',
  not_interested: 'Stops sequences and tags the carrier "Not interested".',
  call_back: 'Schedules a follow-up at the time you pick (default: tomorrow).',
  follow_up: 'Schedules a follow-up at the time you pick (default: tomorrow).',
  converted: 'Marks the carrier as a signed customer.',
  wrong_number: 'No call-back is scheduled. Update the phone number on the carrier profile or enrich it from FMCSA.',
  do_not_call: 'Turns on do-not-call for this carrier and stops its sequences. The request is kept in the call history.',
};

/** Outcomes that schedule (or can schedule) a follow-up call. */
export const FOLLOW_UP_OUTCOMES = ['call_back', 'follow_up', 'interested', 'no_answer', 'busy', 'voicemail'];
export const AUTO_FOLLOW_UP_OUTCOMES = ['no_answer', 'busy', 'voicemail', 'interested'];

/**
 * After a do-not-call outcome is logged: make sure the carrier is marked do-not-call and its sequences are stopped.
 * When the server already applied it (the call response says doNotCall: true) nothing else is sent.
 * Returns true when the carrier is now do-not-call.
 */
export async function ensureDoNotCall(carrierId, response) {
  if (response?.doNotCall === true || response?.carrier?.doNotCall === true) return true;
  await api.patch(`/api/carriers/${carrierId}`, { doNotCall: true });
  try {
    const { carrier } = await api.get(`/api/carriers/${carrierId}`);
    const live = (carrier?.enrollments || []).filter((e) => e.status === 'active' || e.status === 'paused');
    await Promise.all(live.map((e) => api.post(`/api/sequences/enrollments/${e.id}/stop`).catch(() => null)));
  } catch { /* the do-not-call flag is set; sequences skip call and text steps for do-not-call carriers */ }
  return true;
}
