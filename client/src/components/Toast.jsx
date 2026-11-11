import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cx } from './ui.jsx';

const ToastCtx = createContext(null);
let nextId = 1;

/**
 * In-app navigation from outside the router (toasts render above RouterProvider). The app shell listens for
 * 'dd:navigate' and cancels the event when it handled it; otherwise this falls back to a full page load.
 */
export function navigateTo(href) {
  const handled = !window.dispatchEvent(new CustomEvent('dd:navigate', { detail: { href }, cancelable: true }));
  if (!handled) window.location.assign(href);
}

/**
 * const toast = useToast();
 * toast.success('Saved'); toast.error(err); toast.info('Heads up', { action: { label: 'See plans', href: '/app/billing' } })
 * An action is { label, href } (in-app link) or { label, onClick }.
 */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const dismiss = useCallback((id) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((type, message, ms = 4500, action = null) => {
    const id = nextId++;
    setItems((xs) => [...xs.slice(-4), { id, type, message, action }]);
    if (ms) setTimeout(() => dismiss(id), action ? Math.max(ms, 8000) : ms);
    return id;
  }, [dismiss]);
  const api = useMemo(() => ({
    success: (m, opts) => push('success', m, 4500, opts?.action),
    error: (m, opts) => push('error', typeof m === 'string' ? m : m?.message || 'Something went wrong', 7000, opts?.action),
    info: (m, opts) => push('info', m, 4500, opts?.action),
    dismiss,
  }), [push, dismiss]);
  const icons = { success: CheckCircle2, error: AlertCircle, info: Info };
  const tone = { success: 'text-green-600', error: 'text-red-600', info: 'text-brand-600' };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      {/* Above the floating dock on wider screens; clear of the home indicator on phones. */}
      <div className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 sm:bottom-16" aria-live="polite">
        {items.map((t) => {
          const Icon = icons[t.type];
          return (
            <div key={t.id} role={t.type === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm shadow-lg">
              <Icon className={cx('mt-0.5 size-4 shrink-0', tone[t.type])} aria-hidden />
              <div className="min-w-0 flex-1">
                <span className="break-words">{t.message}</span>
                {t.action && (
                  <button type="button" className="mt-1.5 block text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300"
                    onClick={() => { dismiss(t.id); if (t.action.onClick) t.action.onClick(); else if (t.action.href) navigateTo(t.action.href); }}>
                    {t.action.label}
                  </button>
                )}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-muted hover:text-fg"><X className="size-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
