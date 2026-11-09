import { useState } from 'react';
import { Link } from 'react-router';
import { Card, PageHeader, QueryState, cx } from '../../components/ui.jsx';
import { date } from '../../lib/format.js';
import MarketMap, { MapLegend } from '../../components/market/MarketMap.jsx';
import { SourceLink, SpotRatesCard, StatePanel, TripPlanner, useMarketSummary } from '../../components/market/panels.jsx';
import { BY_CODE } from '../../components/market/usStates.js';
import { DataSources, FuelCards, Holidays, Indicators, WeatherAlerts, WeatherAtPlace } from '../../components/market/LiveData.jsx';

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

/** Ranked list with thin bars (one accent for the top row). */
function RankList({ items, total, empty, linkFor }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(...items.map((x) => x.count));
  return (
    <ol className="space-y-2.5">
      {items.map((x, i) => (
        <li key={x.state}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex items-baseline gap-2"><span className="w-5 font-mono text-xs text-muted tabular">{i + 1}</span>
              {linkFor ? <Link to={linkFor(x.state)} className="hover:underline">{BY_CODE[x.state]?.name || x.state}</Link> : BY_CODE[x.state]?.name || x.state}</span>
            <span className="tabular text-fg-2">{x.count.toLocaleString('en-US')}{total ? <span className="ml-1.5 text-xs text-muted">{((x.count / total) * 100).toFixed(1)}%</span> : null}</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-surface-2"><div className={cx('h-1 rounded-full', i === 0 ? 'bg-brand-600' : 'bg-fg-2/30')} style={{ width: `${(x.count / max) * 100}%` }} /></div>
        </li>
      ))}
    </ol>
  );
}

export default function Market() {
  const q = useMarketSummary();
  const [mode, setMode] = useState('zones');
  const [selected, setSelected] = useState(null);
  const [route, setRoute] = useState([]);
  return (
    <div>
      <PageHeader title="Market" subtitle="Where carriers are, what fuel costs, weather on the road, and what a trip burns. Free public sources, linked." />
      <QueryState query={q}>
        {(d) => {
          const census = d.carriersByState;
          const total = census.items.reduce((s, x) => s + x.count, 0);
          const values = Object.fromEntries((mode === 'mine' ? d.mine : census.items).map((x) => [x.state, x.count]));
          const max = Math.max(0, ...Object.values(values));
          return (
            <div className="space-y-6">
              <FuelCards diesel={d.diesel} gasoline={d.gasoline} />

              <Card bodyClass="grid gap-6 p-5 xl:grid-cols-[1fr_340px]">
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-medium">Map</h2>
                    <Segmented label="Color states by" value={mode} onChange={setMode} options={[['zones', 'Time zones'], ['carriers', 'Carriers'], ['mine', 'Your carriers']]} />
                  </div>
                  <MarketMap mode={mode} values={values} selected={selected} onSelect={setSelected} route={route} />
                  <MapLegend mode={mode} max={max} />
                </div>
                <div className="min-w-0 border-t border-line pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
                  {selected ? <StatePanel code={selected} summary={d} onClose={() => setSelected(null)} />
                    : (
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium">Pick a state</h3>
                        <p className="text-[13px] text-fg-2">See its local time, how many active carriers are registered there, how many you already have, and diesel for its region. Then jump to finding carriers there.</p>
                      </div>
                    )}
                </div>
              </Card>

              <div className="grid gap-6 lg:grid-cols-3">
                <Card title="Best states to hunt carriers" actions={<SourceLink href={census.sourceUrl}>FMCSA{census.fetchedAt ? ` · ${date(census.fetchedAt)}` : ''}</SourceLink>}>
                  <p className="mb-4 text-[13px] text-fg-2">Active USDOT registrations by state.</p>
                  {census.error && !census.items.length ? <p className="text-sm text-muted">{census.error}</p>
                    : <RankList items={census.items.slice(0, 10)} total={total} empty="No data" linkFor={(s) => `/app/discover?state=${s}`} />}
                </Card>
                <Card title="Your coverage">
                  <p className="mb-4 text-[13px] text-fg-2">Carriers in your CRM by state.</p>
                  <RankList items={d.mine.slice(0, 10)} empty="No carriers with a state yet." linkFor={(s) => `/app/carriers?state=${s}`} />
                </Card>
                <Card title="Spot rates"><SpotRatesCard /></Card>
              </div>

              <Card title="Trip fuel planner">
                <TripPlanner onRoute={setRoute} />
                {route.length > 1 && <p className="mt-3 text-xs text-muted">The route is drawn on the map above.</p>}
              </Card>

              <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                <WeatherAlerts />
                <div className="space-y-6">
                  <WeatherAtPlace />
                  <Holidays />
                </div>
              </div>

              <Indicators />

              <DataSources />
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
