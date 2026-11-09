import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui.jsx';

/**
 * Small anchored popover. `trigger` receives { open, toggle } and returns the button;
 * `children` receives { close }. Closes on outside click and Escape.
 */
export default function Popover({ trigger, children, align = 'right', className, width = 'w-56' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div role="menu" className={cx('dd-enter absolute top-full z-40 mt-1 rounded-xl border border-line bg-surface p-1 shadow-lg', align === 'right' ? 'right-0' : 'left-0', width, className)}>
          {children({ close })}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, icon: Icon, danger }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-ui hover:bg-surface-2', danger ? 'text-red-600 dark:text-red-400' : 'text-fg')}>
      {Icon && <Icon className="size-4 shrink-0 text-muted" aria-hidden />}
      {children}
    </button>
  );
}
