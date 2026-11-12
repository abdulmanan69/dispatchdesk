import { Field, Textarea } from '../ui.jsx';

/** Postal address for the email footer. US law (CAN-SPAM) requires a physical address in sales emails. */
export default function MailingAddressField({ value, onChange, className = '' }) {
  const missing = !String(value || '').trim();
  return (
    <Field label="Mailing address" className={className}
      hint="Printed small at the bottom of every email, above the unsubscribe link. US law (CAN-SPAM) requires a physical postal address in sales emails; a PO box works.">
      <Textarea rows={2} maxLength={300} value={value} onChange={(e) => onChange(e.target.value)} placeholder={'123 Main St, Suite 4\nDallas, TX 75201'} aria-label="Mailing address" />
      {missing && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">No address yet: add one before you send sequence emails.</p>}
    </Field>
  );
}
