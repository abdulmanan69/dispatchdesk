import { useEffect, useState } from 'react';
import { Modal } from '../Modal.jsx';
import StartForm from './StartForm.jsx';
import NegotiationView from './NegotiationView.jsx';

/**
 * "Negotiate with AI": the start form (from a load or a broker), then the negotiation itself. With `negotiationId`
 * it opens an existing negotiation.
 */
export default function NegotiationPanel({ open, onClose, negotiationId = null, load = null, broker = null }) {
  const [id, setId] = useState(negotiationId);
  useEffect(() => { if (open) setId(negotiationId); }, [open, negotiationId]);
  return (
    <Modal open={open} onClose={onClose} size="lg" title={id ? 'Rate negotiation' : 'Negotiate with AI'}>
      {id ? <NegotiationView id={id} /> : <StartForm load={load} broker={broker} onStarted={setId} onCancel={onClose} />}
    </Modal>
  );
}
