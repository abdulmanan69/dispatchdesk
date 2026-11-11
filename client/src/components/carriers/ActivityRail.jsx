import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, Mail, MessageSquare, Phone, StickyNote, ArrowRightLeft, Activity as ActivityIcon } from 'lucide-react';
import { api } from '../../lib/api.js';
import { relative, dateTime } from '../../lib/format.js';
import { Button, Spinner, cx } from '../ui.jsx';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'call', label: 'Calls', count: 'calls' },
  { value: 'email', label: 'Emails', count: 'emails' },
  { value: 'text', label: 'Texts', count: 'texts' },
  { value: 'note', label: 'Notes' },
  { value: 'stage_change', label: 'Stage' },
];
const ICON = { call: Phone, email: Mail, text: MessageSquare, note: StickyNote, stage_change: ArrowRightLeft };
const TONE = {
  call: 'bg-c-blue-soft text-c-blue', email: 'bg-c-purple-soft text-c-purple', text: 'bg-c-green-soft text-c-green',
  note: 'bg-c-amber-soft text-c-amber', stage_change: 'bg-c-pink-soft text-c-pink',
};

/** "Log a call, email, or text" menu: three plain choices, closes on outside click and Escape. */
function LogMenu({ onCall, onEmail, onText, emailDisabled }) {
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
  const item = (Icon, text, fn, disabled) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => { setOpen(false); fn(); }}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
      <Icon className="size-4 text-muted" aria-hidden />{text}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 border-y border-line px-4 py-2.5 text-left text-sm font-medium transition-ui hover:bg-surface-2">
        Log a call, email, or text<ChevronRight className={cx('size-4 text-muted transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="dd-pop absolute inset-x-3 top-full z-20 mt-1 rounded-lg border border-line-strong bg-surface p-1 shadow-lg shadow-black/10">
          {item(Phone, 'Log a call', onCall)}
          {item(Mail, 'Send an email', onEmail, emailDisabled)}
          {item(MessageSquare, 'Log a text', onText)}
        </div>
      )}
    </div>
  );
}

const PAGE = 15;
const MAX_ITEMS = 150;

/**
 * Activity history for a carrier: counts, filter chips, the log menu and a timeline.
 * "Show more" grows one request (the newest N items) instead of keeping a page list, so a refresh after logging a
 * call is always a single request however far the user scrolled.
 */
export default function ActivityRail({ carrier, canWrite, onLogCall, onEmail, onText }) {
  const [type, setType] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const counts = carrier.activityCounts || { calls: carrier.calls?.length || 0, emails: carrier._count?.emails || 0, texts: 0 };
  const q = useQuery({
    queryKey: ['carrier', carrier.id, 'activities', 'rail', type, limit],
    queryFn: ({ signal }) => api.get(`/api/carriers/${carrier.id}/activities`, { page: 1, pageSize: limit, ...(type ? { type } : {}) }, { signal }),
    // While "Show more" loads, keep the items on screen; a different filter starts fresh.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[4] === type ? keepPreviousData(prev) : undefined),
  });
  const items = q.data?.items || [];
  const hasMore = !!q.data && q.data.total > items.length && limit < MAX_ITEMS;
  const pickType = (v) => { setType(v); setLimit(PAGE); };
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-sm font-medium">Activity history</h2>
        <span className="text-xs text-muted tabular">{counts.calls} calls · {counts.emails} emails · {counts.texts} texts</span>
      </header>
      <div className="flex flex-wrap gap-1.5 px-4 pb-3" role="tablist" aria-label="Activity type">
        {FILTERS.map((f) => (
          <button key={f.value || 'all'} type="button" role="tab" aria-selected={type === f.value} onClick={() => pickType(f.value)}
            className={cx('rounded-full border px-2.5 py-1 text-xs transition-ui', type === f.value ? 'border-fg bg-fg text-bg' : 'border-line text-fg-2 hover:bg-surface-2')}>
            {f.label}{f.count ? <span className="ml-1 tabular opacity-70">{counts[f.count]}</span> : null}
          </button>
        ))}
      </div>
      {canWrite && <LogMenu onCall={onLogCall} onEmail={onEmail} onText={onText} emailDisabled={!carrier.email || carrier.doNotEmail} />}
      <div className="max-h-[520px] overflow-y-auto">
        {q.isLoading ? <div className="flex justify-center py-6"><Spinner /></div>
          : !items.length ? <p className="px-4 py-6 text-center text-sm text-muted">{type ? 'Nothing of this type yet.' : 'No activity yet.'}</p>
            : (
              <ol className="divide-y divide-line">
                {items.map((a) => {
                  const Icon = ICON[a.type] || ActivityIcon;
                  return (
                    <li key={a.id} className="flex gap-3 px-4 py-2.5 text-sm">
                      <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md ${TONE[a.type] || 'bg-c-gray-soft text-c-gray'}`}><Icon className="size-3.5" aria-hidden /></span>
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-fg">{a.summary}</p>
                        <p className="mt-0.5 text-xs text-muted" title={dateTime(a.createdAt)}>{relative(a.createdAt)}{a.user?.name ? ` · ${a.user.name}` : ''}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
        {hasMore && <div className="border-t border-line p-2 text-center"><Button size="sm" variant="ghost" loading={q.isPlaceholderData && q.isFetching} onClick={() => setLimit((n) => Math.min(MAX_ITEMS, n + PAGE))}>Show more</Button></div>}
        {!hasMore && q.data && q.data.total > items.length && <p className="border-t border-line px-4 py-2 text-center text-xs text-muted">Showing the latest {items.length} of {q.data.total}.</p>}
      </div>
    </section>
  );
}
