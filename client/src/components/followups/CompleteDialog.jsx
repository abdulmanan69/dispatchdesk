import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Button, Field, Textarea, cx } from '../ui.jsx';
import { Modal } from '../Modal.jsx';
import { FOLLOW_UP_INVALIDATE } from './FollowUpForm.jsx';
import { OUTCOMES, RECURRENCES } from './followUpUtils.js';

/** Mark a follow-up done with an outcome and note. Recurring follow-ups schedule their next occurrence. */
export default function CompleteDialog({ followUp, onClose }) {
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const done = useApiMutation((body) => api.post(`/api/follow-ups/${followUp.id}/complete`, body), {
    invalidate: FOLLOW_UP_INVALIDATE,
    success: (d) => (d.next ? `Done · next one ${new Date(d.next.dueAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : 'Marked done'),
    onSuccess: onClose,
  });
  const repeat = RECURRENCES.find(([v]) => v === followUp?.recurrence)?.[1];
  return (
    <Modal open={!!followUp} onClose={onClose} size="sm" title={`Complete · ${followUp?.carrier?.companyName || ''}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={done.isPending} onClick={() => done.mutate({ outcome: outcome || null, note: note.trim() || null })}>Mark done</Button></>}>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[13px] font-medium">Outcome</p>
          <div className="flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(outcome === o ? '' : o)}
                className={cx('h-7 rounded-md border px-2 text-xs transition-ui', outcome === o ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-fg-2 hover:bg-surface-2')}>{o}</button>
            ))}
          </div>
        </div>
        <Field label="Note"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was agreed" /></Field>
        {repeat && followUp.recurrence !== 'none' && <p className="text-xs text-muted">Repeats: {repeat.toLowerCase()}. The next one is scheduled when you mark this done.</p>}
      </div>
    </Modal>
  );
}
