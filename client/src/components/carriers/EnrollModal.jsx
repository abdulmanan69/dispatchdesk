import { useState } from 'react';
import { Modal } from '../Modal.jsx';
import { Button, Field, Select, EmptyState } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useSequences } from './shared.jsx';
import { useToast } from '../Toast.jsx';

/**
 * Enroll one or more carriers in a sequence.
 * carrierIds: the selected ids. filter (+ count): every carrier matching the list filters ("select all matching"),
 * enrolled through the carrier bulk endpoint.
 */
export default function EnrollModal({ open, onClose, carrierIds = [], filter, count, onDone }) {
  const seqs = useSequences();
  const [seqId, setSeqId] = useState('');
  const active = (seqs.data?.items || []).filter((s) => s.active);
  const n = filter ? count ?? 0 : carrierIds.length;
  const toast = useToast();
  const enroll = useApiMutation(async (id) => {
    if (!filter) {
      const d = await api.post(`/api/sequences/${id}/enroll`, { carrierIds });
      return { ...d, skipped: (d.skipped || 0) + (d.inaccessible || 0), sequenceId: id };
    }
    const d = await api.post('/api/carriers/bulk', { action: 'enroll_sequence', filter, value: id });
    return { enrolled: d.affected, skipped: (d.skipped || 0) + (d.inaccessible || 0), reason: d.reason, sequenceId: id };
  }, {
    invalidate: [['carrier'], ['carriers'], ['sequences'], ['queue'], ['pipeline']],
    onSuccess: (d) => {
      // Next step after enrolling: work the sequence's calls in the dialer (nothing is dialed until a click).
      toast.success(`Enrolled ${d.enrolled}${d.skipped ? `, ${d.skipped} skipped (already enrolled or read-only)` : ''}`,
        d.enrolled ? { action: { label: 'Start dialer', href: `/app/dialer?sequenceId=${d.sequenceId}` } } : undefined);
      onDone?.();
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={`Enroll ${n.toLocaleString('en-US')} carrier${n === 1 ? '' : 's'} in a sequence`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!seqId} loading={enroll.isPending} onClick={() => enroll.mutate(seqId)}>Enroll</Button></>}>
      {seqs.isLoading ? <p className="text-sm text-muted">Loading sequences…</p> : !active.length ? (
        <EmptyState title="No active sequences" action={<Button to="/app/sequences" size="sm">Create a sequence</Button>}>Build a call/email cadence first.</EmptyState>
      ) : (
        <Field label="Sequence">
          <Select value={seqId} onChange={(e) => setSeqId(e.target.value)}>
            <option value="">Choose…</option>
            {active.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.steps.length} steps)</option>)}
          </Select>
        </Field>
      )}
    </Modal>
  );
}
