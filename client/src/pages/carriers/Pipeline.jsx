import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, Table2, MoreHorizontal } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money, relative } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Card, Checkbox, DataTable, ErrorState, Input, Loading, PageHeader, Select, cx } from '../../components/ui.jsx';
import { PhoneLink, STAGES, StageBadge, TagList, equipmentLabel } from '../../components/carriers/shared.jsx';

export default function Pipeline() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState(() => { try { return localStorage.getItem('dd_pipeline_view') || 'board'; } catch { return 'board'; } });
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('mine');
  const [archived, setArchived] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const params = { q, scope, includeArchived: String(archived), perStage: 40 };
  const board = useQuery({ queryKey: ['pipeline', 'board', params], queryFn: () => api.get('/api/pipeline/board', params) });

  const move = useApiMutation(({ id, stage }) => api.post(`/api/carriers/${id}/stage`, { stage }), {
    success: (d) => `Moved to ${d.stage.name}`,
    invalidate: [['pipeline'], ['carriers'], ['carrier'], ['dashboard']],
  });
  const setV = (v) => { setView(v); try { localStorage.setItem('dd_pipeline_view', v); } catch { /* ignore */ } };

  const onDrop = (stageKey) => {
    if (dragging && dragging.stage !== stageKey) move.mutate({ id: dragging.id, stage: stageKey });
    setDragging(null);
    setOver(null);
  };

  const rows = board.data?.columns.flatMap((c) => c.items) || [];

  return (
    <div>
      <PageHeader title="Pipeline" subtitle="Drag carriers between stages, or use the menu on each card."
        actions={<div className="flex rounded-md border border-line p-0.5" role="group" aria-label="View">
          <Button size="sm" variant={view === 'board' ? 'secondary' : 'ghost'} icon={LayoutGrid} onClick={() => setV('board')} aria-pressed={view === 'board'}>Board</Button>
          <Button size="sm" variant={view === 'table' ? 'secondary' : 'ghost'} icon={Table2} onClick={() => setV('table')} aria-pressed={view === 'table'}>Table</Button>
        </div>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input aria-label="Filter pipeline" placeholder="Filter by name, MC, DOT…" className="max-w-xs" onKeyDown={(e) => e.key === 'Enter' && setQ(e.currentTarget.value.trim())} onBlur={(e) => setQ(e.target.value.trim())} />
        {user?.team && <Select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} className="w-36"><option value="mine">My pipeline</option><option value="team">Team</option></Select>}
        <Checkbox label="Show archived" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      </div>

      {board.isLoading ? <Loading /> : board.isError ? <ErrorState error={board.error} onRetry={board.refetch} /> : view === 'board' ? (
        <div className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-4 sm:-mx-6 sm:px-6">
          {board.data.columns.map((col) => (
            <section key={col.key} aria-label={col.name}
              onDragOver={(e) => { e.preventDefault(); setOver(col.key); }} onDragLeave={() => setOver(null)} onDrop={() => onDrop(col.key)}
              className={cx('flex w-72 shrink-0 flex-col rounded-lg border bg-surface-2/50', over === col.key ? 'border-brand-500 bg-brand-50/40 dark:bg-brand-900/20' : 'border-line')}>
              <header className="flex items-center justify-between px-3 py-2.5">
                <span className="flex items-center gap-2 text-sm font-medium"><span className="size-2 rounded-full" style={{ background: col.color }} />{col.name}</span>
                <span className="rounded bg-surface px-1.5 text-xs tabular text-muted">{col.total}</span>
              </header>
              <div className="flex max-h-[calc(100vh-280px)] min-h-24 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {col.items.map((c) => (
                  <article key={c.id} draggable onDragStart={() => setDragging({ id: c.id, stage: col.key })} onDragEnd={() => setDragging(null)}
                    className={cx('cursor-grab rounded-md border border-line bg-surface p-2.5 text-sm shadow-sm active:cursor-grabbing', dragging?.id === c.id && 'opacity-50')}>
                    <div className="flex items-start justify-between gap-1">
                      <Link to={`/app/carriers/${c.id}`} className="font-medium leading-snug hover:underline">{c.companyName}</Link>
                      <MoveMenu carrier={c} current={col.key} onMove={(stage) => move.mutate({ id: c.id, stage })} />
                    </div>
                    <div className="mt-1 text-xs text-muted tabular">{[c.mcNumber && `MC ${c.mcNumber}`, c.state, c.fleetSize != null && `${c.fleetSize} trucks`].filter(Boolean).join(' · ')}</div>
                    {c.phone && <div className="mt-1 text-xs"><PhoneLink phone={c.phone} /></div>}
                    {c.opportunity?.estimatedValueCents > 0 && <div className="mt-1 text-xs text-green-700 dark:text-green-400">{money(c.opportunity.estimatedValueCents, { digits: 0 })}/mo est.</div>}
                    <TagList tags={c.tags} className="mt-1.5" />
                    {c.priority > 0 && <div className="mt-1 text-[11px] font-medium text-signal-600">{c.priority === 2 ? 'Hot' : 'High priority'}</div>}
                  </article>
                ))}
                {col.total > col.items.length && <Link to={`/app/carriers?stage=${col.key}`} className="py-1 text-center text-xs text-muted hover:text-fg">View all {col.total}</Link>}
                {!col.items.length && <p className="py-6 text-center text-xs text-muted">Drop carriers here</p>}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Card bodyClass="p-0">
          <DataTable rows={rows} onRowClick={(c) => navigate(`/app/carriers/${c.id}`)} columns={[
            { key: 'companyName', header: 'Carrier', render: (c) => <span className="font-medium">{c.companyName}</span> },
            { key: 'stage', header: 'Stage', render: (c) => (
              <span onClick={(e) => e.stopPropagation()}>
                <Select aria-label={`Stage for ${c.companyName}`} value={c.stage.key} onChange={(e) => move.mutate({ id: c.id, stage: e.target.value })} className="h-8 w-40 text-[13px]">
                  {STAGES.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                </Select>
              </span>
            ) },
            { key: 'phone', header: 'Phone', render: (c) => <PhoneLink phone={c.phone} /> },
            { key: 'state', header: 'State' },
            { key: 'equipment', header: 'Equipment', render: (c) => equipmentLabel(c.equipment) },
            { key: 'value', header: 'Est. value', className: 'tabular', render: (c) => (c.opportunity?.estimatedValueCents ? money(c.opportunity.estimatedValueCents, { digits: 0 }) : '—') },
            { key: 'stageChangedAt', header: 'In stage since', render: (c) => <span className="text-[13px] text-muted">{relative(c.stageChangedAt)}</span> },
          ]} />
          <p className="border-t border-line px-4 py-2 text-xs text-muted">Showing up to 40 carriers per stage. Use the carrier list for the complete set.</p>
        </Card>
      )}
    </div>
  );
}

/** Keyboard-accessible alternative to drag-and-drop. */
function MoveMenu({ carrier, current, onMove }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" aria-label={`Move ${carrier.companyName}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} onBlur={(e) => { if (!e.currentTarget.parentElement.contains(e.relatedTarget)) setOpen(false); }}
        className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg"><MoreHorizontal className="size-4" /></button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-line bg-surface py-1 shadow-lg">
          <p className="px-3 py-1 text-[11px] text-muted">Move to</p>
          {STAGES.filter((s) => s.key !== current).map((s) => (
            <button key={s.key} role="menuitem" type="button" onClick={() => { setOpen(false); onMove(s.key); }} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-2">
              <StageBadge stage={{ ...s, color: undefined }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
