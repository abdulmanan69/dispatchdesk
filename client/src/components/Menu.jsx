import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, cx } from './ui.jsx';

/**
 * A button with a drop-down list of actions (the "More" menu of a record header). Closes on a choice, an outside
 * click or Escape. items: [{ label, icon, onClick, disabled, title, danger, hidden, divider }].
 */
export function MenuButton({ label = 'More', icon, items, variant = 'secondary', size, align = 'right', className }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  return (
    <div ref={ref} className={cx('relative', className)}>
      <Button variant={variant} size={size} icon={icon} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}<ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </Button>
      {open && (
        <div role="menu" className={cx('dd-pop absolute top-full z-30 mt-1 w-56 rounded-lg border border-line-strong bg-surface p-1 shadow-lg shadow-black/10', align === 'right' ? 'right-0' : 'left-0')}>
          {shown.map((i, n) => (i.divider ? <div key={`d${n}`} className="my-1 border-t border-line" role="separator" /> : (
            <button key={i.label} type="button" role="menuitem" disabled={i.disabled} title={i.title}
              onClick={() => { setOpen(false); i.onClick?.(); }}
              className={cx('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40',
                i.danger ? 'text-c-red' : 'text-fg-2 hover:text-fg')}>
              {i.icon && <i.icon className={cx('size-4', i.danger ? 'text-c-red' : 'text-muted')} aria-hidden />}{i.label}
            </button>
          )))}
        </div>
      )}
    </div>
  );
}
