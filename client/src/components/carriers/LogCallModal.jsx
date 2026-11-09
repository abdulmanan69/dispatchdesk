import { useEffect, useState } from 'react';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Textarea, Checkbox, cx } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { CALL_OUTCOMES, label } from '../../lib/format.js';
import { PhoneLink } from './shared.jsx';

const HINTS = {
  no_answer: 'Schedules a call-back next business day (carrier local time).',
  busy: 'Schedules a call-back next business day.',
  voicemail: 'Schedules a call-back next business day.',
  interested: 'Moves the carrier to Opportunities and ends active sequences.',
  not_interested: 'Stops sequences and tags the carrier "Not interested".',
  call_back: 'Schedules a follow-up at the time you pick (default: tomorrow).',
  follow_up: 'Schedules a follow-up at the time you pick (default: tomorrow).',
  converted: 'Marks the carrier as a signed customer.',
};

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Record the outcome of a call. When opened from a dial (`attempt`), the call is linked to it:
 * bridge calls use the duration the phone system reported; link calls use a live timer started at the click.
 */
export default function LogCallModal({ open, onClose, carrier, onLogged, attempt }) {
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [minutes, setMinutes] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [archive, setArchive] = useState(false);
  const [autoFollowUp, setAutoFollowUp] = useState(true);
  const [useTimer, setUseTimer] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { if (open) { setOutcome(''); setNotes(''); setMinutes(''); setFollowUpAt(''); setArchive(false); setAutoFollowUp(true); setUseTimer(true); } }, [open]);

  const reported = attempt?.durationSec != null;
  const timed = !!attempt && !reported;
  useEffect(() => {
    if (!open || !timed) return undefined;
    const start = new Date(attempt.createdAt).getTime();
    const tick = () => setElapsed(Math.max(0, (Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open, timed, attempt?.createdAt]);

  const log = useApiMutation((body) => api.post('/api/calls', body), {
    success: (d) => `Call logged${d.followUp ? ' — follow-up scheduled' : ''}${d.stage ? ` · stage: ${d.stage.name}` : ''}`,
    invalidate: [['carrier'], ['carriers'], ['queue'], ['follow-ups'], ['pipeline'], ['calls'], ['dashboard']],
    onSuccess: (d) => { onLogged?.(d); onClose(); },
  });
  if (!carrier) return null;
  const showWhen = ['call_back', 'follow_up', 'interested', 'no_answer', 'busy', 'voicemail'].includes(outcome);

  const submit = (e) => {
    e.preventDefault();
    if (!outcome) return;
    const manual = minutes ? Math.round(Number(minutes) * 60) : undefined;
    log.mutate({
      carrierId: carrier.id, outcome, notes,
      attemptId: attempt?.id,
      durationSec: manual ?? (timed && useTimer ? Math.round(elapsed) : undefined),
      followUpAt: followUpAt ? new Date(followUpAt).toISOString() : null,
      archive, autoFollowUp,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={`Log call — ${carrier.companyName}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="log-call" disabled={!outcome} loading={log.isPending}>Save call</Button></>}>
      <form id="log-call" onSubmit={submit} className="space-y-4">
        {attempt ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm">
            <span className="text-fg-2">{reported ? 'Call length from the phone system' : 'Time since you clicked call'}</span>
            <span className="font-mono tabular">{mmss(reported ? attempt.durationSec : elapsed)}</span>
          </div>
        ) : (
          <p className="text-sm text-muted">Call: <PhoneLink phone={carrier.phone} carrierId={carrier.id} /> {carrier.doNotCall && <strong className="font-medium text-red-600">· Marked do-not-call</strong>}</p>
        )}
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Outcome</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CALL_OUTCOMES.map((o) => (
              <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}
                className={cx('rounded-md border px-2 py-2 text-[13px] font-medium', outcome === o ? 'border-brand-600 bg-brand-600/10 text-brand-800 dark:text-brand-200' : 'border-line hover:bg-surface-2')}>
                {label(o)}
              </button>
            ))}
          </div>
          {outcome && <p className="mt-2 text-xs text-muted">{HINTS[outcome]}</p>}
        </fieldset>
        <Field label="Notes"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Equipment, lanes, objections, who you spoke with…" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Duration (minutes)" hint={reported ? 'Leave empty to use the reported length' : timed && useTimer ? 'Leave empty to use the timer' : undefined}>
            <Input type="number" min="0" step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
          {showWhen && <Field label="Follow up at" hint="Leave empty for next business day"><Input type="datetime-local" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} /></Field>}
        </div>
        {['no_answer', 'busy', 'voicemail', 'interested'].includes(outcome) && <Checkbox label="Schedule an automatic follow-up" checked={autoFollowUp} onChange={(e) => setAutoFollowUp(e.target.checked)} />}
        {outcome === 'not_interested' && <Checkbox label="Also move the carrier to Archived" checked={archive} onChange={(e) => setArchive(e.target.checked)} />}
        {timed && <Checkbox label="Use the timer as the call length" checked={useTimer} onChange={(e) => setUseTimer(e.target.checked)} />}
      </form>
    </Modal>
  );
}
