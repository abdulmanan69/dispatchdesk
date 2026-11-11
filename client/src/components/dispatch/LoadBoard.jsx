import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Package } from 'lucide-react';
import { api } from '../../lib/api.js';
import { errorToast } from '../../lib/hooks.js';
import { date, dollars, label, money } from '../../lib/format.js';
import { Badge, Button, EmptyState, ErrorState, Loading, cx } from '../ui.jsx';
import { useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { LOAD_STATUS_COLOR } from './calc.js';
import { formatAt } from './zoned.js';

/** Board columns in workflow order (canceled only when asked for). Mirror of the server's STATUS_FLOW. */
export const BOARD_STATUSES = ['planned', 'booked', 'in_transit', 'delivered', 'invoiced', 'paid'];
const pretty = (s) => String(s || '').replace(/_/g, ' ');

/**
 * Client mirror of checkTransition in server/src/services/loads/status.js: forward moves go straight through, while a
 * backward move, canceling finished work or reopening a canceled load asks first (the server answers 409 otherwise).
 */
export function moveCheck(from, to) {
  if (from === to) return { ok: true, noop: true };
  if (to === 'canceled') {
    return ['planned', 'booked', 'in_transit'].includes(from) ? { ok: true } : { ok: true, needsConfirm: true, reason: `This load is already ${pretty(from)}. Cancel it anyway?` };
  }
  if (from === 'canceled') return { ok: true, needsConfirm: true, reason: `This load was canceled. Reopen it as ${pretty(to)}?` };
  const a = BOARD_STATUSES.indexOf(from);
  const b = BOARD_STATUSES.indexOf(to);
  if (b < 0) return { ok: false, reason: `Unknown status "${to}"` };
  if (b < a) return { ok: true, needsConfirm: true, reason: `Move this load back from ${pretty(from)} to ${pretty(to)}?` };
  return { ok: true };
}

/**
 * Columns after moving one card (optimistic update): the card leaves its column and goes to the top of the target
 * column with the new status; both totals follow. A target column that is not on the board (canceled while hidden)
 * just loses the card. Returns the same array when the card is not found.
 */
export function moveCard(columns, loadId, to) {
  let card = null;
  for (const c of columns) {
    card = c.items.find((l) => l.id === loadId);
    if (card) break;
  }
  if (!card || card.status === to) return columns;
  return columns.map((c) => {
    if (c.status === card.status) return { ...c, total: Math.max(0, c.total - 1), items: c.items.filter((l) => l.id !== loadId) };
    if (c.status === to) return { ...c, total: c.total + 1, items: [{ ...card, status: to }, ...c.items.filter((l) => l.id !== loadId)] };
    return c;
  });
}

/** Append a "load more" page to one column, skipping cards already shown (moves shift the offsets). */
export function appendPage(columns, page) {
  return columns.map((c) => {
    if (c.status !== page.status) return c;
    const have = new Set(c.items.map((l) => l.id));
    return { ...c, total: page.total, page: page.page, items: [...c.items, ...page.items.filter((l) => !have.has(l.id))] };
  });
}

/** Pickup and delivery as the facility sees them ("Nov 12, 8:00 AM CST"), or the plain date. */
export function stopLabel(load, kind) {
  const at = load[`${kind}WindowStart`];
  if (at) return formatAt(at, load[`${kind}Tz`]);
  const d = load[`${kind}Date`];
  return d ? date(d, { month: 'short', day: 'numeric' }) : null;
}

function Chips({ docs }) {
  if (!docs) return null;
  const chip = (on, text, title) => (
    <span key={text} title={`${title}: ${on ? 'on file' : 'missing'}`}
      className={on ? 'rounded border border-c-green/30 bg-c-green-soft px-1 text-[10.5px] font-medium leading-4 text-c-green' : 'rounded border border-dashed border-line-strong px-1 text-[10.5px] leading-4 text-muted'}>
      {text}<span className="sr-only">{on ? ' on file' : ' missing'}</span>
    </span>
  );
  return <span className="inline-flex gap-1">{[chip(docs.rateCon, 'RC', 'Rate con'), chip(docs.bol, 'BOL', 'BOL'), chip(docs.pod, 'POD', 'POD')]}</span>;
}

/** Keyboard and touch alternative to dragging: a menu of the other statuses. */
function MoveMenu({ load, statuses, onMove }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    wrap.current?.querySelector('[role="menuitem"]')?.focus();
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const onKeyDown = (e) => {
    const items = [...(wrap.current?.querySelectorAll('[role="menuitem"]') || [])];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  const name = load.referenceNumber ? `load ${load.referenceNumber}` : `load ${load.originCity} to ${load.destCity}`;
  return (
    <div ref={wrap} className="relative" onKeyDown={onKeyDown}>
      <button ref={trigger} type="button" aria-label={`Move ${name}`} aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"><MoreHorizontal className="size-4" aria-hidden /></button>
      {open && (
        <div role="menu" aria-label="Move to" className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-line bg-surface py-1 shadow-lg">
          <p className="px-3 py-1 text-[11px] text-muted">Move to</p>
          {statuses.filter((s) => s !== load.status).map((s) => (
            <button key={s} role="menuitem" type="button" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
              onClick={(e) => { e.stopPropagation(); setOpen(false); onMove(s); }}>
              <Badge color={LOAD_STATUS_COLOR[s]}>{label(s)}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ load, statuses, dragging, onDragStart, onDragEnd, onOpen, onMove }) {
  const pickup = stopLabel(load, 'pickup');
  const delivery = stopLabel(load, 'delivery');
  return (
    <article draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', load.id); onDragStart(load); }} onDragEnd={onDragEnd}
      onClick={() => onOpen(load.id)}
      className={cx('cursor-grab rounded-md border border-line bg-surface p-2.5 text-sm shadow-sm active:cursor-grabbing', dragging && 'opacity-50')}>
      <div className="flex items-start justify-between gap-1">
        <button type="button" className="min-w-0 text-left font-medium leading-snug hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(load.id); }}>
          {load.referenceNumber ? `#${load.referenceNumber}` : `${load.originCity} → ${load.destCity}`}
        </button>
        <MoveMenu load={load} statuses={statuses} onMove={onMove} />
      </div>
      <p className="mt-0.5 truncate text-xs text-fg-2">{load.originCity}, {load.originState} → {load.destCity}, {load.destState}</p>
      {load.carrier && <p className="mt-0.5 truncate text-xs text-muted">{load.carrier.companyName}</p>}
      {(pickup || delivery) && (
        <p className="mt-1 text-xs text-muted tabular">
          {pickup && <span>PU {pickup}</span>}
          {pickup && delivery && <span aria-hidden> · </span>}
          {delivery && <span>DEL {delivery}</span>}
        </p>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-xs tabular"><span className="font-medium">{money(load.rateCents, { digits: 0 })}</span>{load.ratePerMile != null && <span className="text-muted"> · {dollars(load.ratePerMile)}/mi</span>}</span>
        <Chips docs={load.docs} />
      </div>
    </article>
  );
}

/**
 * Kanban of loads by status. Cards move by drag and drop or the "Move to" menu, through POST /api/loads/:id/status
 * (the same side effects as everywhere else), with an optimistic update that rolls back on error. Each column shows
 * its first 50 loads; "Load more" fetches the next page of that column only.
 */
export default function LoadBoard({ filters = {}, showCanceled = false, onOpen }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const params = { view: 'board', ...filters, canceled: showCanceled ? 'true' : undefined };
  const key = ['loads', 'board', params];
  const q = useQuery({ queryKey: key, queryFn: () => api.get('/api/loads', params) });
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [more, setMore] = useState(null);
  const statuses = [...BOARD_STATUSES, 'canceled'];

  const move = useMutation({
    mutationFn: ({ load, to, force }) => api.post(`/api/loads/${load.id}/status`, { status: to, ...(force ? { force: true } : {}) }),
    onMutate: async ({ load, to }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (d) => (d ? { ...d, columns: moveCard(d.columns, load.id, to) } : d));
      return { prev };
    },
    onError: async (err, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      // The board was out of date and the server wants a confirmation after all.
      if (err.status === 409 && err.details?.code === 'CONFIRM_STATUS' && !vars.force) {
        if (await confirm({ title: 'Change status?', message: err.message, confirmLabel: 'Move load' })) move.mutate({ ...vars, force: true });
        return;
      }
      errorToast(toast, err);
    },
    onSuccess: (d, { load }) => {
      const missing = d?.paperwork?.missing || [];
      const docsHref = `/app/loads?load=${load.id}&tab=documents`;
      if (missing.includes('pod')) toast.info(`Load marked ${label(d.load.status)}. No POD on file yet.`, { action: { label: 'Upload POD', href: docsHref } });
      else if (missing.includes('rate_confirmation')) toast.info(`Load marked ${label(d.load.status)}. No rate con on file yet.`, { action: { label: 'Upload rate con', href: docsHref } });
      else toast.success(`Load marked ${label(d.load.status)}`);
    },
    onSettled: (_d, _e, { load }) => {
      // Everything else that shows loads refreshes; the board keeps its optimistic state (and any "load more" pages)
      // and refetches the next time it is opened.
      qc.invalidateQueries({ queryKey: ['loads'], predicate: (x) => x.queryKey[1] !== 'board' });
      qc.invalidateQueries({ queryKey: ['loads', 'board'], refetchType: 'none' });
      for (const k of [['load', load.id], ['fleet'], ['broker'], ['customer']]) qc.invalidateQueries({ queryKey: k });
    },
  });

  const requestMove = async (load, to) => {
    const check = moveCheck(load.status, to);
    if (check.noop) return;
    if (!check.ok) { toast.error(check.reason); return; }
    let force = false;
    if (check.needsConfirm) {
      if (!(await confirm({ title: 'Change status?', message: check.reason, confirmLabel: 'Move load' }))) return;
      force = true;
    }
    move.mutate({ load, to, force });
  };

  const loadMore = async (col) => {
    setMore(col.status);
    try {
      const page = await api.get('/api/loads', { ...params, status: col.status, page: col.page + 1, pageSize: col.pageSize });
      const next = page.columns?.[0];
      if (next) qc.setQueryData(key, (d) => (d ? { ...d, columns: appendPage(d.columns, next) } : d));
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setMore(null);
    }
  };

  const onDrop = (status) => {
    const load = dragging;
    setDragging(null);
    setOver(null);
    if (load && load.status !== status) requestMove(load, status);
  };

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const columns = q.data?.columns || [];
  if (columns.every((c) => c.total === 0)) {
    return <EmptyState icon={Package} title="No loads match">Loads appear here by status once you record them. Clear the search to see every load.</EmptyState>;
  }
  return (
    <div className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-4 sm:-mx-6 sm:px-6">
      {columns.map((col) => (
        <section key={col.status} aria-label={`${label(col.status)}, ${col.total} load${col.total === 1 ? '' : 's'}`}
          onDragOver={(e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(col.status); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}
          onDrop={(e) => { e.preventDefault(); onDrop(col.status); }}
          className={cx('flex w-72 shrink-0 flex-col rounded-lg border bg-surface-2/50', over === col.status && dragging?.status !== col.status ? 'border-brand-500 bg-brand-50/40 dark:bg-brand-900/20' : 'border-line')}>
          <header className="flex items-center justify-between px-3 py-2.5">
            <Badge color={LOAD_STATUS_COLOR[col.status]}>{label(col.status)}</Badge>
            <span className="rounded bg-surface px-1.5 text-xs tabular text-muted">{col.total}</span>
          </header>
          <div className="flex max-h-[calc(100vh-300px)] min-h-24 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {col.items.map((l) => (
              <Card key={l.id} load={l} statuses={statuses} dragging={dragging?.id === l.id}
                onDragStart={setDragging} onDragEnd={() => { setDragging(null); setOver(null); }} onOpen={onOpen} onMove={(to) => requestMove(l, to)} />
            ))}
            {col.items.length < col.total && (
              <Button size="sm" variant="ghost" loading={more === col.status} onClick={() => loadMore(col)}>Load more ({col.total - col.items.length} left)</Button>
            )}
            {!col.items.length && <p className="py-6 text-center text-xs text-muted">Drop loads here</p>}
          </div>
        </section>
      ))}
    </div>
  );
}
