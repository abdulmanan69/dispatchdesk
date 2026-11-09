import { useState } from 'react';
import { Modal } from '../Modal.jsx';
import { Button, Field, Select, EmptyState } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useSequences } from './shared.jsx';

/** Enroll one or more carriers in a sequence. */
export default function EnrollModal({ open, onClose, carrierIds = [], onDone }) {
  const seqs = useSequences();
  const [seqId, setSeqId] = useState('');
  const active = (seqs.data?.items || []).filter((s) => s.active);
  const enroll = useApiMutation((id) => api.post(`/api/sequences/${id}/enroll`, { carrierIds }), {
    success: (d) => `Enrolled ${d.enrolled}${d.skipped ? `, ${d.skipped} already enrolled` : ''}`,
    invalidate: [['carrier'], ['carriers'], ['sequences'], ['queue'], ['pipeline']],
    onSuccess: () => { onDone?.(); onClose(); },
  });
  return (
    <Modal open={open} onClose={onClose} title={`Enroll ${carrierIds.length} carrier${carrierIds.length === 1 ? '' : 's'} in a sequence`} size="sm"
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
