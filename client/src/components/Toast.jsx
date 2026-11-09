import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cx } from './ui.jsx';

const ToastCtx = createContext(null);
let nextId = 1;

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const dismiss = useCallback((id) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((type, message, ms = 4500) => {
    const id = nextId++;
    setItems((xs) => [...xs.slice(-4), { id, type, message }]);
    if (ms) setTimeout(() => dismiss(id), ms);
  }, [dismiss]);
  const api = useMemo(() => ({
    success: (m) => push('success', m),
    error: (m) => push('error', typeof m === 'string' ? m : m?.message || 'Something went wrong', 7000),
    info: (m) => push('info', m),
  }), [push]);
  const icons = { success: CheckCircle2, error: AlertCircle, info: Info };
  const tone = { success: 'text-green-600', error: 'text-red-600', info: 'text-brand-600' };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((t) => {
          const Icon = icons[t.type];
          return (
            <div key={t.id} role={t.type === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm shadow-lg">
              <Icon className={cx('mt-0.5 size-4 shrink-0', tone[t.type])} aria-hidden />
              <span className="flex-1">{t.message}</span>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-muted hover:text-fg"><X className="size-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
