import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { num } from '../../lib/format.js';
import { Badge, Button, cx } from '../ui.jsx';
import { day, Chip, Unavailable, Section, Num } from './profileParts.jsx';

/**
 * Roadside inspections, violations, inspected vehicles and crashes (GET /api/carrier-profile/dot/:dot/inspections),
 * and related carriers (GET /api/carrier-profile/dot/:dot/related). Both load after the profile; each takes the
 * react-query result so loading and errors show inside the section.
 */

const RATE_TONE = (x) => (x.oosRate == null || x.nationalAvg == null ? '' : x.oosRate >= x.nationalAvg * 2 ? 'text-c-red' : x.oosRate > x.nationalAvg ? 'text-c-amber' : 'text-c-green');

function SectionState({ q, what }) {
  if (q.isLoading) return <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />Loading {what} from FMCSA…</p>;
  return <Unavailable>{q.error?.message || 'Not available right now'}</Unavailable>;
}

function Tile({ label, value, sub, tone }) {
  return (
    <div className="min-w-0 rounded-lg border border-line px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cx('text-lg font-medium tabular', tone)}>{value}</dd>
      {sub && <dd className="text-xs text-muted">{sub}</dd>}
    </div>
  );
}

const rateText = (x) => (x.oosRate != null ? `${x.oosRate}%` : x.inspections ? 'Too few' : '—');

function OosTable({ s, minForRate }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1 pr-2 font-medium">Out-of-service rate</th>
            <th className="py-1 pr-2 text-right font-medium">Inspections</th>
            <th className="py-1 pr-2 text-right font-medium">Out of service</th>
            <th className="py-1 pr-2 text-right font-medium">Rate</th>
            <th className="py-1 text-right font-medium">National avg</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {[['Vehicle', s.vehicle], ['Driver', s.driver], ['Hazmat', s.hazmat]].filter(([k, x]) => k !== 'Hazmat' || x.inspections > 0).map(([k, x]) => (
            <tr key={k}>
              <td className="py-1.5 pr-2">{k}</td>
              <td className="py-1.5 pr-2 text-right tabular">{num(x.inspections)}</td>
              <td className="py-1.5 pr-2 text-right tabular">{num(x.oos)}</td>
              <td className={cx('py-1.5 pr-2 text-right font-medium tabular', RATE_TONE(x))} title={x.oosRate == null && x.inspections ? `A rate needs at least ${minForRate} inspections` : undefined}>{rateText(x)}</td>
              <td className="py-1.5 text-right tabular text-muted">{x.nationalAvg != null ? `${x.nationalAvg}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bars({ items, valueKey = 'inspections', label, sub }) {
  const max = Math.max(1, ...items.map((x) => x[valueKey]));
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((x) => (
        <li key={label(x)} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2">
          <span className="truncate text-fg-2">{label(x)}</span>
          <span className="h-1.5 rounded-full bg-surface-2" aria-hidden>
            <span className="block h-1.5 rounded-full bg-brand-600" style={{ width: `${Math.max(3, (x[valueKey] / max) * 100)}%` }} />
          </span>
          <span className="text-xs tabular text-muted">{sub(x)}</span>
        </li>
      ))}
    </ul>
  );
}

function InspectionRecord({ r }) {
  const [open, setOpen] = useState(false);
  const unit = r.units?.[0];
  return (
    <li className="py-2">
      <button type="button" className="flex w-full items-start justify-between gap-3 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="min-w-0">
          <span className="font-medium tabular">{day(r.date)}</span>
          <span className="text-fg-2"> · {[r.location || r.state, r.levelLabel].filter(Boolean).join(' · ')}</span>
          <span className="block text-xs text-muted">
            {[unit && [unit.type, unit.make, unit.license && `plate ${unit.license}${unit.licenseState ? ` ${unit.licenseState}` : ''}`].filter(Boolean).join(' '), r.reportNumber && `report ${r.reportNumber}`].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {r.oosViolations > 0 ? <Badge color="red">Out of service</Badge> : r.violations ? <Badge color="amber">{r.violations} violation{r.violations === 1 ? '' : 's'}</Badge> : <Badge color="green">Clean</Badge>}
          {r.postCrash && <Badge color="gray">Post-crash</Badge>}
          {r.hazmat && <Badge color="gray">Hazmat</Badge>}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
          {r.violationList?.length ? (
            <ul className="space-y-1.5">
              {r.violationList.map((v, i) => (
                <li key={`${v.code}-${i}`}>
                  <span className="font-mono text-xs text-muted">{v.code}</span> {v.description || 'Violation'}
                  <span className="block text-xs text-muted">{[v.categoryLabel, v.unit, v.oos && 'out of service', v.citation && 'citation issued'].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-muted">{r.violations ? 'Violation details are not in the public file yet.' : 'No violations.'}</p>}
          {r.units?.length > 0 && (
            <p className="text-xs text-muted">Units: {r.units.map((u) => [u.type, u.make, u.vin && `VIN ${u.vin}`].filter(Boolean).join(' ')).join('; ')}</p>
          )}
        </div>
      )}
    </li>
  );
}

export function InspectionsSection({ q, anchor }) {
  const [showStates, setShowStates] = useState(false);
  const rep = q.data;
  if (!rep) return <Section title="Inspections and crashes" anchor={anchor}><SectionState q={q} what="inspections" /></Section>;
  const s = rep.summary;
  const crashes = rep.crashes;
  return (
    <Section title={`Inspections and crashes (last ${rep.windowMonths} months)`} anchor={anchor}>
      {s ? (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Inspections" value={num(s.inspections)} sub={s.inspections ? `${num(s.oosInspections)} with out-of-service` : 'none on record'} />
          <Tile label="Vehicle OOS" value={rateText(s.vehicle)} sub={`national ${s.vehicle.nationalAvg}%`} tone={RATE_TONE(s.vehicle)} />
          <Tile label="Driver OOS" value={rateText(s.driver)} sub={`national ${s.driver.nationalAvg}%`} tone={RATE_TONE(s.driver)} />
          <Tile label="Crashes" value={crashes ? num(crashes.total) : '—'} sub={crashes ? (crashes.total ? `${num(crashes.fatal)} fatal · ${num(crashes.injury)} injury · ${num(crashes.tow)} tow-away` : 'none reported') : 'not available'} tone={crashes?.fatal ? 'text-c-red' : undefined} />
        </dl>
      ) : <Unavailable>Inspection totals are not available right now.</Unavailable>}
      {s?.inspections > 0 && <OosTable s={s} minForRate={rep.minForRate} />}
      {s && <p className="text-xs text-muted">Vehicle rate: Level I, II, V and VI inspections. Driver rate: Level I, II, III and VI. A rate needs {rep.minForRate} or more inspections. National averages: FMCSA{rep.nationalAvgAsOf ? `, ${String(rep.nationalAvgAsOf).length === 4 ? rep.nationalAvgAsOf : day(rep.nationalAvgAsOf)}` : ''}.</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {rep.violationsByCategory?.some((c) => c.violations > 0) && (
          <div>
            <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Violations by category{rep.detailCount ? <span className="font-normal text-muted"> · latest {rep.detailCount} inspections</span> : null}</h4>
            <Bars items={rep.violationsByCategory.filter((c) => c.violations > 0).sort((a, b) => b.violations - a.violations)} valueKey="violations"
              label={(c) => c.label} sub={(c) => `${c.violations}${c.oos ? ` · ${c.oos} OOS` : ''}`} />
          </div>
        )}
        {rep.byYear?.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Inspections by year</h4>
            <Bars items={rep.byYear} label={(y) => String(y.year)} sub={(y) => `${num(y.inspections)}${y.oos ? ` · ${num(y.oos)} OOS` : ''}`} />
          </div>
        )}
      </div>

      {rep.byState?.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Where it was inspected</h4>
          <ul className="flex flex-wrap gap-1.5">
            {(showStates ? rep.byState : rep.byState.slice(0, 10)).map((x) => <li key={x.state}><Badge>{x.state} <span className="tabular text-muted">{num(x.inspections)}</span></Badge></li>)}
            {rep.byState.length > 10 && <li><button type="button" className="text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setShowStates(!showStates)}>{showStates ? 'Fewer' : `All ${rep.byState.length} states`}</button></li>}
          </ul>
        </div>
      )}

      <div>
        <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Trucks and trailers seen at inspections</h4>
        {rep.equipment == null ? <Unavailable /> : !rep.equipment.length ? <p className="text-sm text-muted">No vehicles on recent inspections.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-2 font-medium">Vehicle</th>
                  <th className="py-1 pr-2 font-medium">Plate</th>
                  <th className="py-1 pr-2 font-medium">VIN</th>
                  <th className="py-1 pr-2 text-right font-medium">Inspections</th>
                  <th className="py-1 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rep.equipment.slice(0, 25).map((e) => (
                  <tr key={e.vin || `${e.license}-${e.licenseState}`}>
                    <td className="py-1.5 pr-2"><span className="font-medium">{[e.year, e.make, e.model].filter(Boolean).join(' ') || e.type}</span><span className="block text-xs text-muted">{e.type}{e.oosInspections ? ` · ${e.oosInspections} out of service` : ''}</span></td>
                    <td className="py-1.5 pr-2 whitespace-nowrap font-mono text-xs">{e.license ? `${e.license}${e.licenseState ? ` ${e.licenseState}` : ''}` : '—'}</td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{e.vin || '—'}</td>
                    <td className="py-1.5 pr-2 text-right tabular">{num(e.inspections)}</td>
                    <td className="py-1.5 text-right whitespace-nowrap tabular">{day(e.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-muted">From the latest {rep.detailCount} inspections. Year, make and model decoded from the VIN (NHTSA); a year can be off by a 30-year cycle.</p>
          </div>
        )}
      </div>

      <div>
        <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Inspection reports{rep.records?.length ? <span className="font-normal text-muted"> · latest {rep.records.length}</span> : null}</h4>
        {rep.records == null ? <Unavailable /> : !rep.records.length ? <p className="text-sm text-muted">No inspections on file.</p> : (
          <RecordList records={rep.records} />
        )}
      </div>

      {crashes?.records?.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Crash reports</h4>
          <ul className="divide-y divide-line text-sm">
            {crashes.records.map((c, i) => (
              <li key={`${c.reportNumber}-${i}`} className="flex flex-wrap items-start justify-between gap-2 py-1.5">
                <span><span className="font-medium tabular">{day(c.date)}</span> <span className="text-fg-2">· {[c.city, c.state].filter(Boolean).join(', ')}{c.location ? ` · ${c.location}` : ''}</span></span>
                <span className="flex flex-wrap gap-1">
                  {c.fatalities > 0 && <Badge color="red">{c.fatalities} fatal</Badge>}
                  {c.injuries > 0 && <Badge color="amber">{c.injuries} injured</Badge>}
                  {c.towAway && <Badge color="gray">Tow-away</Badge>}
                  {c.hazmatReleased && <Badge color="red">Hazmat released</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!rep.complete && <p className="text-xs text-muted">Some FMCSA files did not answer: {rep.sources.filter((x) => !x.ok).map((x) => x.name.toLowerCase()).join(', ')}. Refresh tries again.</p>}
      <p className="text-xs text-muted">FMCSA MCMIS inspection and crash files (data.transportation.gov), updated daily. Inspections reach the file a few days after the stop. Dispute wrong records with FMCSA DataQs.</p>
    </Section>
  );
}

function RecordList({ records }) {
  const [all, setAll] = useState(false);
  const shown = all ? records : records.slice(0, 8);
  return (
    <>
      <ul className="divide-y divide-line">{shown.map((r) => <InspectionRecord key={r.id} r={r} />)}</ul>
      {records.length > 8 && (
        <button type="button" className="text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${records.length} reports`}
        </button>
      )}
    </>
  );
}

const MATCH = { phone: 'Same phone', email: 'Same email', address: 'Same address' };

export function RelatedSection({ q, anchor, onOpen }) {
  const rel = q.data;
  return (
    <Section title="Related carriers" anchor={anchor}>
      {!rel ? <SectionState q={q} what="related carriers" /> : (
        <>
          {!rel.checked.length ? <p className="text-sm text-muted">FMCSA has no phone, email or street address on file to compare.</p>
            : !rel.carriers.length ? <p className="text-sm text-muted">No other carrier in the FMCSA census uses this carrier's {rel.checked.join(', ')}.</p> : (
              <ul className="divide-y divide-line text-sm">
                {rel.carriers.map((c) => (
                  <li key={c.dot} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="font-medium">{c.name || `USDOT ${c.dot}`}</span>
                      <span className="block font-mono text-xs tabular text-muted">USDOT {c.dot}{c.mc ? ` · MC ${c.mc}` : ''}{c.registeredAt ? ` · since ${day(c.registeredAt)}` : ''}{c.city ? ` · ${c.city}, ${c.state}` : ''}</span>
                      <span className="mt-1 flex flex-wrap gap-1">{c.matches.map((m) => <Chip key={m} tone="gray">{MATCH[m]}</Chip>)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Badge color={c.usdotStatus === 'active' ? 'green' : c.usdotStatus === 'inactive' ? 'red' : 'gray'}>{c.usdotStatus === 'active' ? 'Active' : c.usdotStatus === 'inactive' ? 'Inactive' : 'Unknown'}</Badge>
                      {c.priorRevoke && <Badge color="amber">Revoked before</Badge>}
                      {onOpen
                        ? <Button size="sm" variant="ghost" onClick={() => onOpen(c.dot)}>Check</Button>
                        : <Button size="sm" variant="ghost" icon={ExternalLink} href={`/app/carrier-check?dot=${c.dot}`} target="_blank" rel="noopener noreferrer">Check</Button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          {rel.total > rel.carriers.length && <p className="text-xs text-muted">Showing {rel.carriers.length} of {rel.total}.</p>}
          {rel.serviceShared?.length > 0 && <p className="text-xs text-muted">{rel.serviceShared.map((x) => `Its ${x.kind} is on ${num(x.count)}+ filings`).join('; ')}: likely a registration agent or service company, so those carriers are not listed.</p>}
          <p className="text-xs text-muted">Carriers that share a phone, email or street address in the FMCSA census. A shared detail is a reason to ask, not proof: family fleets and separate authorities of one company share them too. A carrier shut down and restarted under a new USDOT number (a chameleon carrier) usually does as well.</p>
        </>
      )}
    </Section>
  );
}
