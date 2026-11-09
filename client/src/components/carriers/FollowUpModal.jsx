import { FollowUpDialog } from '../followups/FollowUpForm.jsx';

/** Create a follow-up for carrierId, or edit `followUp`. Uses the shared follow-up form (priority, repeat, reminder). */
export default function FollowUpModal({ open, onClose, carrierId, carrierName, followUp }) {
  const carrier = carrierId ? { id: carrierId, companyName: carrierName } : followUp?.carrier || null;
  return <FollowUpDialog open={open} onClose={onClose} followUp={followUp} carrier={carrier} />;
}
