import { Check, Circle } from 'lucide-react';
import { PASSWORD_RULES } from '../../lib/validation.js';
import { cx } from '../ui.jsx';

/** Live checklist under a new-password field: each rule turns green as it is met. */
export default function PasswordChecklist({ password = '', id, className }) {
  return (
    <ul id={id} className={cx('flex flex-wrap gap-x-4 gap-y-1 text-xs', className)}>
      {PASSWORD_RULES.map((r) => {
        const ok = r.test(password);
        return (
          <li key={r.key} className={cx('flex items-center gap-1.5 transition-ui', ok ? 'text-c-green' : 'text-muted')}>
            {ok ? <Check className="size-3.5" strokeWidth={2.5} aria-hidden /> : <Circle className="size-3" aria-hidden />}
            {r.label}<span className="sr-only">{ok ? ' (done)' : ' (not yet)'}</span>
          </li>
        );
      })}
    </ul>
  );
}
