import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Handshake } from 'lucide-react';
import { api } from '../../lib/api.js';
import { relative } from '../../lib/format.js';
import { Button, Card } from '../ui.jsx';
import NegotiationPanel from './NegotiationPanel.jsx';
import { OPEN, StatusBadge, laneText, usd } from './shared.jsx';

/** Compact rows: lane, status, numbers, last change. */
export function NegotiationRows({ items, onOpen }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((x) => (
        <li key={x.id}>
          <button type="button" onClick={() => onOpen(x.id)} className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm transition-ui hover:bg-surface-2/60">
            <span className="min-w-0">
              <span className="block truncate font-medium">{laneText(x.lane)}</span>
              <span className="block text-xs text-muted tabular">
                {x.status === 'agreed' ? `Agreed ${usd(x.agreedCents)}` : `Offer ${usd(x.offerCents)} · target ${usd(x.targetCents)} · walk-away ${usd(x.floorCents)}`} · round {x.rounds} of {x.maxRounds}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {x.nextAction && OPEN.includes(x.status) && x.canWrite ? <StatusBadge status="needs_review" /> : <StatusBadge status={x.status} />}
              <span className="text-xs text-muted">{relative(x.updatedAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Load detail section: this load's negotiations and the "Negotiate with AI" button while the load is planned. */
export function LoadNegotiations({ load }) {
  const [panel, setPanel] = useState(null); // { id } | { start: true }
  const q = useQuery({ queryKey: ['negotiations', { loadId: load.id }], queryFn: () => api.get('/api/negotiations', { loadId: load.id, pageSize: 5 }) });
  const items = q.data?.items || [];
  const hasOpen = items.some((x) => OPEN.includes(x.status));
  const canStart = load.status === 'planned' && !hasOpen;
  if (!items.length && !canStart) return null;
  return (
    <div className="rounded-md border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><Handshake className="size-4 shrink-0 text-brand-600" aria-hidden />Rate negotiation</span>
        {canStart && <Button size="sm" variant="secondary" onClick={() => setPanel({ start: true })}>Negotiate with AI</Button>}
      </div>
      {items.length > 0
        ? <div className="border-t border-line"><NegotiationRows items={items} onOpen={(id) => setPanel({ id })} /></div>
        : <p className="border-t border-line px-3 py-2 text-xs text-muted">The AI emails the broker for a better rate inside your limits. It never accepts a rate or books a load on its own.</p>}
      <NegotiationPanel open={!!panel} onClose={() => setPanel(null)} negotiationId={panel?.id || null} load={load} />
    </div>
  );
}

/** Broker page card: negotiations with this broker; ?negotiation=<id> (notification links) opens one. */
export function BrokerNegotiations({ broker }) {
  const [sp, setSp] = useSearchParams();
  const [starting, setStarting] = useState(false);
  const fromUrl = sp.get('negotiation');
  const q = useQuery({ queryKey: ['negotiations', { brokerId: broker.id }], queryFn: () => api.get('/api/negotiations', { brokerId: broker.id, pageSize: 10 }) });
  const items = q.data?.items || [];
  const openId = (id) => setSp((p) => { const next = new URLSearchParams(p); next.set('negotiation', id); return next; }, { replace: true });
  const close = () => {
    setStarting(false);
    if (fromUrl) setSp((p) => { const next = new URLSearchParams(p); next.delete('negotiation'); return next; }, { replace: true });
  };
  return (
    <Card title="Rate negotiations" bodyClass="p-0"
      actions={<Button size="sm" variant="secondary" icon={Handshake} disabled={!broker.email} title={broker.email ? undefined : 'Add the broker’s email first'} onClick={() => setStarting(true)}>Negotiate with AI</Button>}>
      {items.length
        ? <NegotiationRows items={items} onOpen={openId} />
        : <p className="px-4 py-4 text-sm text-muted">{q.isLoading ? 'Loading…' : `No negotiations with this broker yet. The AI emails ${broker.companyName} for a better rate inside your limits and never accepts or books on its own.`}</p>}
      {q.data?.total > items.length && <p className="border-t border-line px-4 py-2 text-xs text-muted">Showing the {items.length} most recent of {q.data.total}</p>}
      <NegotiationPanel open={starting || !!fromUrl} onClose={close} negotiationId={fromUrl || null} broker={broker} />
    </Card>
  );
}
