import { useEffect, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { Button, cx } from '../ui.jsx';
import { useDialer, ATTEMPT_LABEL } from './useDialer.js';
import LogCallModal from '../carriers/LogCallModal.jsx';

const pretty = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(phone || '');
};
const telHref = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  return `tel:+1${d.length === 10 ? d : d.replace(/^1/, '')}`;
};

/**
 * Click-to-call through the user's configured provider (Settings → Calling).
 * variant "link": the phone number itself (compact, used in tables); "button": a Call button.
 * After dialing, the log-call form opens automatically (if enabled) with the attempt linked.
 */
export default function CallButton({ phone, carrierId, variant = 'link', label = 'Call', className, size = 'md', onLogged }) {
  const d = useDialer();
  const [logOpen, setLogOpen] = useState(false);

  // Bridge calls: open the log form once the call finishes, unless the system logged it already.
  useEffect(() => {
    if (d.mode === 'bridge' && d.isFinal && d.attempt && !d.attempt.callId && d.attempt.carrier && d.autoOpenLog && d.attempt.status !== 'failed' && d.attempt.status !== 'canceled') setLogOpen(true);
  }, [d.mode, d.isFinal, d.attempt, d.autoOpenLog]);

  if (!phone && !carrierId) return <span className="text-muted">—</span>;

  const start = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const res = await d.dial({ carrierId, phone });
    if (res?.mode === 'link' && res.autoOpenLog !== false && res.attempt?.carrier) setLogOpen(true);
  };

  const active = d.mode === 'bridge' && d.attempt && !d.isFinal;

  return (
    <>
      {variant === 'link' ? (
        <a href={telHref(phone)} onClick={start} className={cx('tabular text-fg hover:underline', d.dialing && 'opacity-60', className)} title="Call with your calling app">
          {pretty(phone)}
        </a>
      ) : (
        <Button icon={Phone} size={size} onClick={start} loading={d.dialing} className={className}>{label}</Button>
      )}
      {active && (
        <span className="ml-2 inline-flex items-center gap-2 text-xs text-fg-2" role="status" onClick={(e) => e.stopPropagation()}>
          <span className="size-1.5 rounded-full bg-brand-600" aria-hidden />
          {ATTEMPT_LABEL[d.attempt.status] || d.attempt.status}
          <button type="button" onClick={d.cancel} className="inline-flex items-center gap-1 text-muted hover:text-fg"><PhoneOff className="size-3.5" />Hang up</button>
        </span>
      )}
      {logOpen && d.attempt?.carrier && (
        <span onClick={(e) => e.stopPropagation()}>
          <LogCallModal open={logOpen} onClose={() => { setLogOpen(false); d.reset(); }} carrier={d.attempt.carrier} attempt={d.attempt} onLogged={onLogged} />
        </span>
      )}
    </>
  );
}
