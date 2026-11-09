import { useState } from 'react';
import { Flag } from 'lucide-react';
import { Modal } from '../Modal.jsx';
import { Button, Field, Select, Textarea } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useToast } from '../Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useNavigate, useLocation } from 'react-router';

const REASONS = [
  ['spam', 'Spam or advertising'],
  ['scam', 'Scam or fraud'],
  ['abuse', 'Harassment or abuse'],
  ['inappropriate', 'Inappropriate content'],
  ['other', 'Something else'],
];

/** Report button + modal. `url` is the report endpoint (POST {reason, details}). */
export function ReportButton({ url, what = 'content', size = 'sm', variant = 'ghost' }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('spam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post(url, { reason, details });
      toast.success(res.duplicate ? 'You already reported this. Moderators will review it.' : 'Thanks — moderators will review this report.');
      setOpen(false);
      setDetails('');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const onClick = () => {
    if (!user) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
    setOpen(true);
  };

  return (
    <>
      <Button variant={variant} size={size} icon={Flag} onClick={onClick}>Report</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Report ${what}`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" type="submit" form="report-form" loading={busy}>Submit report</Button></>}>
        <form id="report-form" onSubmit={submit} className="space-y-3">
          <Field label="Reason" required>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Details" hint="Optional. Help moderators understand the problem.">
            <Textarea rows={3} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
