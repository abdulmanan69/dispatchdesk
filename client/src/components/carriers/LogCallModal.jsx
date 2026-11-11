import { useEffect, useState } from 'react';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Textarea, Checkbox, cx } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { PhoneLink } from './shared.jsx';
import CallTimer, { secondsSince } from '../calling/CallTimer.jsx';
import CarrierTimeInput from '../calling/CarrierTimeInput.jsx';
import { tzOf } from '../calling/callWindow.js';
import { AUTO_FOLLOW_UP_OUTCOMES, CALL_OUTCOMES, FOLLOW_UP_OUTCOMES, OUTCOME_HINTS, ensureDoNotCall, outcomeLabel } from '../calling/outcomes.js';

/**
 * Record the outcome of a call. When opened from a dial (`attempt`), the call is linked to it:
 * bridge calls use the duration the phone system reported; link calls use a live timer started at the click.
 * Follow-up times are typed in the carrier's local time by default (your time is shown alongside).
 */
export default function LogCallModal({ open, onClose, carrier, onLogged, attempt }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [minutes, setMinutes] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [archive, setArchive] = useState(false);
  const [autoFollowUp, setAutoFollowUp] = useState(true);
  const [useTimer, setUseTimer] = useState(true);
  useEffect(() => { if (open) { setOutcome(''); setNotes(''); setMinutes(''); setFollowUpAt(''); setArchive(false); setAutoFollowUp(true); setUseTimer(true); } }, [open]);

  const reported = attempt?.durationSec != null;
  const timed = !!attempt && !reported;

  const log = useApiMutation(async (body) => {
    const res = await api.post('/api/calls', body);
    if (body.outcome === 'do_not_call') {
      try { await ensureDoNotCall(body.carrierId, res); res.doNotCall = true; } catch (err) { res.dncError = err; }
    }
    return res;
  }, {
    success: (d) => `Call logged${d.followUp ? ', follow-up scheduled' : ''}${d.doNotCall ? ', do-not-call is on' : ''}${d.stage ? ` · stage: ${d.stage.name}` : ''}`,
    invalidate: [carrier?.id ? ['carrier', carrier.id] : ['carrier'], ['carriers'], ['queue'], ['follow-ups'], ['pipeline'], ['calls'], ['dashboard']],
    onSuccess: (d) => {
      if (d.dncError) toast.error(`The call is saved, but do-not-call could not be turned on: ${d.dncError.message}`);
      onLogged?.(d);
      onClose();
    },
  });
  if (!carrier) return null;
  const tz = tzOf(carrier);
  const showWhen = FOLLOW_UP_OUTCOMES.includes(outcome);

  const submit = (e) => {
    e.preventDefault();
    if (!outcome) return;
    const manual = minutes ? Math.round(Number(minutes) * 60) : undefined;
    log.mutate({
      carrierId: carrier.id, outcome, notes,
      attemptId: attempt?.id,
      durationSec: manual ?? (timed && useTimer ? Math.round(secondsSince(attempt.createdAt)) : undefined),
      followUpAt: showWhen && followUpAt ? followUpAt : null,
      archive, autoFollowUp: showWhen ? autoFollowUp : false,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={`Log call: ${carrier.companyName}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="log-call" disabled={!outcome} loading={log.isPending}>Save call</Button></>}>
      <form id="log-call" onSubmit={submit} className="space-y-4">
        {attempt ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm">
            <span className="text-fg-2">{reported ? 'Call length from the phone system' : 'Time since you clicked call'}</span>
            <CallTimer since={attempt.createdAt} seconds={reported ? attempt.durationSec : undefined} running={open} className="font-mono tabular" />
          </div>
        ) : (
          <p className="text-sm text-muted">Call: <PhoneLink phone={carrier.phone} carrierId={carrier.id} /> {carrier.doNotCall && <strong className="font-medium text-red-600">· Marked do-not-call</strong>}</p>
        )}
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Outcome</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {CALL_OUTCOMES.map((o) => (
              <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}
                className={cx('rounded-md border px-2 py-2 text-[13px] font-medium', outcome === o
                  ? (o === 'do_not_call' ? 'border-red-500 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-brand-600 bg-brand-600/10 text-brand-800 dark:text-brand-200')
                  : 'border-line hover:bg-surface-2')}>
                {outcomeLabel(o)}
              </button>
            ))}
          </div>
          {outcome && <p className="mt-2 text-xs text-muted">{OUTCOME_HINTS[outcome]}</p>}
        </fieldset>
        <Field label="Notes"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={outcome === 'do_not_call' ? 'What the carrier asked for, in their words' : 'Equipment, lanes, objections, who you spoke with…'} /></Field>
        <Field label="Duration (minutes)" hint={reported ? 'Leave empty to use the reported length' : timed && useTimer ? 'Leave empty to use the timer' : undefined}>
          <Input type="number" min="0" step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-40" />
        </Field>
        {showWhen && (
          <Field label="Follow up at" hint="Leave empty for the next business day">
            {(id) => <CarrierTimeInput id={id} value={followUpAt} onChange={setFollowUpAt} timezone={tz} aria-label="Follow up at" />}
          </Field>
        )}
        {AUTO_FOLLOW_UP_OUTCOMES.includes(outcome) && <Checkbox label="Schedule an automatic follow-up" checked={autoFollowUp} onChange={(e) => setAutoFollowUp(e.target.checked)} />}
        {outcome === 'not_interested' && <Checkbox label="Also move the carrier to Archived" checked={archive} onChange={(e) => setArchive(e.target.checked)} />}
        {timed && <Checkbox label="Use the timer as the call length" checked={useTimer} onChange={(e) => setUseTimer(e.target.checked)} />}
      </form>
    </Modal>
  );
}
