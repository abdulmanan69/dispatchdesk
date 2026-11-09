import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Bot, Map as MapIcon } from 'lucide-react';
import { Modal } from '../Modal.jsx';
import { cx } from '../ui.jsx';
import MarketMap, { MapLegend } from './MarketMap.jsx';
import { StatePanel, TripPlanner, useMarketSummary } from './panels.jsx';

function Segmented({ value, onChange, options, label }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} onClick={() => onChange(v)}
          className={cx('h-7 rounded-md px-3 text-[13px] transition-ui', value === v ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}>{l}</button>
      ))}
    </div>
  );
}

/** Large map with state details and the trip planner, opened from the floating dock. */
export function MarketMapModal({ open, onClose }) {
  const summary = useMarketSummary();
  const [mode, setMode] = useState('zones');
  const [selected, setSelected] = useState(null);
  const [panel, setPanel] = useState('trip');
  const [route, setRoute] = useState([]);
  const values = Object.fromEntries((mode === 'mine' ? summary.data?.mine : summary.data?.carriersByState?.items)?.map((x) => [x.state, x.count]) || []);
  const max = Math.max(0, ...Object.values(values));
  const pick = (code) => { setSelected(code); setPanel('state'); };
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Market map">
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-3">
          <Segmented label="Color states by" value={mode} onChange={setMode} options={[['zones', 'Time zones'], ['carriers', 'Carriers'], ['mine', 'Your carriers']]} />
          <MarketMap mode={mode} values={values} selected={selected} onSelect={pick} route={route} className="rounded-xl border border-line bg-surface-2/40 p-2" />
          <MapLegend mode={mode} max={max} />
        </div>
        <div className="min-w-0 space-y-4">
          <Segmented label="Panel" value={panel} onChange={setPanel} options={[['trip', 'Trip'], ['state', selected ? selected : 'State']]} />
          {panel === 'trip' ? <TripPlanner compact onRoute={setRoute} />
            : selected ? <StatePanel code={selected} summary={summary.data} onClose={() => { setSelected(null); setPanel('trip'); }} />
              : <p className="text-sm text-muted">Click a state on the map to see its local time, carriers and diesel price.</p>}
        </div>
      </div>
    </Modal>
  );
}

/** Bottom-right dock: AI dispatcher and the market map, on every app page. */
export default function FloatingDock() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); setOpen(true); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('dd:market-map', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('dd:market-map', onOpen); };
  }, []);
  const btn = 'inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-ui';
  return (
    <>
      <div className="fixed bottom-4 right-4 z-40 flex items-center gap-1 rounded-full border border-line bg-surface/95 p-1 shadow-lg shadow-black/10 backdrop-blur print:hidden">
        <button type="button" onClick={() => navigate('/app/ai')} className={cx(btn, 'text-fg-2 hover:bg-surface-2 hover:text-fg')} title="AI dispatcher">
          <Bot className="size-4" aria-hidden />AI
        </button>
        <button type="button" onClick={() => setOpen(true)} className={cx(btn, 'bg-fg text-bg hover:opacity-90')} title="Market map (Alt+M)">
          <MapIcon className="size-4" aria-hidden />Map
        </button>
      </div>
      {open && <MarketMapModal open onClose={() => setOpen(false)} />}
    </>
  );
}
