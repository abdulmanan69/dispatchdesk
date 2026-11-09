import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button, cx } from './ui.jsx';

// Stack of open modals so Escape closes only the topmost one.
const stack = [];

export function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const token = {};
    stack.push(token);
    const prev = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === token) { e.stopPropagation(); closeRef.current?.(); }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => ref.current?.querySelector('input,select,textarea,button:not([data-close])')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      stack.splice(stack.indexOf(token), 1);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className={cx('flex max-h-[92vh] w-full flex-col rounded-t-xl border border-line bg-surface shadow-xl sm:rounded-xl', widths[size])}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-base font-medium">{title}</h2>
          <button data-close type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"><X className="size-4" /></button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

const ConfirmCtx = createContext(null);

/** const confirm = useConfirm(); if (await confirm({ title, message, danger: true })) ... */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (v) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={!!state} onClose={() => close(false)} title={state?.title || 'Are you sure?'} size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => close(false)}>{state?.cancelLabel || 'Cancel'}</Button>
          <Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel || (state?.danger ? 'Delete' : 'Confirm')}</Button>
        </>}>
        <p className="text-sm text-muted">{state?.message}</p>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);
