import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { date, dateTime, nf, num, phoneFmt } from '../../lib/format.js';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, cx } from '../ui.jsx';
import { Modal } from '../Modal.jsx';
import { PhoneLink } from './shared.jsx';

/**
 * Full FMCSA carrier profile (GET /api/carrier-profile/...): authority, insurance, operation, fleet, drivers, safety
 * and compliance from FMCSA's public data, with the sources and their dates. Sections whose source did not answer say
 * "Not available right now"; nothing is filled in by guess.
 *   <FmcsaProfile carrierId={id} />   a saved carrier (stored on the carrier, reused for 24 hours)
 *   <FmcsaProfile dot="1775913" />    any USDOT number (leads before saving)
 *   <FmcsaProfileButton dot=... />    a button that opens the profile in a wide dialog
 */
const TIMEOUT_MS = 90_000; // a cold profile reads up to 15 FMCSA sources
const digits = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
const UTC_DAY = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
const day = (d) => (d ? date(`${d}T00:00:00Z`, UTC_DAY) : '—');
const usd = (n) => (n == null ? '—' : nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n));
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');
const addressText = (a) => (a ? [a.street, [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') : null);

function target(carrierId, dot) {
  if (carrierId) return { key: ['fmcsa-profile', 'carrier', carrierId], url: `/api/carrier-profile/carrier/${encodeURIComponent(carrierId)}` };
  const d = digits(dot);
  return { key: ['fmcsa-profile', 'dot', d], url: `/api/carrier-profile/dot/${d}` };
}

const TONE = {
  red: 'bg-c-red-soft text-c-red border-c-red/30',
  amber: 'bg-c-amber-soft text-c-amber border-c-amber/30',
  green: 'bg-c-green-soft text-c-green border-c-green/30',
  gray: 'bg-c-gray-soft text-fg-2 border-line',
};
/** A flag that may wrap on small screens (Badge stays on one line). */
function Chip({ tone = 'gray', children, title, className }) {
  return <span title={title} className={cx('inline-flex items-start rounded border px-1.5 py-0.5 text-[12px] font-medium leading-snug', TONE[tone], className)}>{children}</span>;
}

const AUTHORITY = { active: ['green', 'Authority active'], pending: ['amber', 'Authority pending'], inactive: ['red', 'Authority inactive'], unknown: ['gray', 'Authority not verified'] };
const RATING_TONE = { Satisfactory: 'green', Conditional: 'amber', Unsatisfactory: 'red' };
const BASIS = {
  motus: 'From FMCSA\'s Motus registration system (current).',
  legacy: 'From FMCSA\'s legacy licensing records, which FMCSA stopped updating on May 14, 2026.',
  qcmobile: 'Live status from FMCSA QCMobile.',
  'motus+legacy': 'Checked in FMCSA\'s Motus and legacy licensing records.',
};

/** "3.2 years · granted Mar 4, 2023" / "45 days · granted Sep 28, 2026" from the authority history; plain text otherwise. */
export function mcAgeText(a) {
  if (!a?.since || a.ageDays == null) return a?.history ? 'No authority grant on record' : 'Not available right now';
  const age = a.ageYears >= 1 ? `${num(a.ageYears, 1)} years` : `${num(a.ageDays)} day${a.ageDays === 1 ? '' : 's'}`;
  return <span className="tabular">{age} · granted {day(a.since)}</span>;
}

export function AuthorityStatusBadge({ authority }) {
  const [tone, text] = AUTHORITY[authority?.status] || AUTHORITY.unknown;
  return <Badge color={tone} title={authority?.label || undefined}>{text}</Badge>;
}

function Unavailable({ children = 'Not available right now' }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/** Collapsible on phones (tap the title); always open from the sm breakpoint up. */
function Section({ title, children, defaultOpen = true, className }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={cx('min-w-0 rounded-xl border border-line bg-surface', className)}>
      <h3 className="text-sm font-medium">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left sm:pointer-events-none">
          {title}
          <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform sm:hidden', open && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      <div id={id} className={cx('space-y-3 border-t border-line px-4 py-3', open ? 'block' : 'hidden sm:block')}>{children}</div>
    </section>
  );
}

function Rows({ children }) {
  return <dl className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">{children}</dl>;
}
function Row({ k, children }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{children ?? '—'}</dd>
    </>
  );
}
const Num = ({ children }) => <span className="tabular">{children}</span>;

function ShowMore({ items, initial, render, noun }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, initial);
  return (
    <>
      {shown.map(render)}
      {items.length > initial && (
        <li>
          <button type="button" className="text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${items.length} ${noun}`}
          </button>
        </li>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function Header({ p, onRefresh, refreshing, stale, staleError, refreshError }) {
  const s = p.safety || {};
  return (
    <Card bodyClass="space-y-3 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-medium">{p.identity?.legalName || `USDOT ${p.dot}`}</h2>
          {p.identity?.dbaName && <p className="text-sm text-fg-2">DBA {p.identity.dbaName}</p>}
          <p className="mt-0.5 font-mono text-xs tabular text-muted">USDOT {p.dot}{p.mc ? ` · MC ${p.mc}` : ''}</p>
          {p.mc && <p className="mt-1 text-sm" data-testid="mc-age"><span className="text-muted">MC age </span>{mcAgeText(p.authority)}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <AuthorityStatusBadge authority={p.authority} />
            {s.allowedToOperate === true && <Badge color="green">Allowed to operate</Badge>}
            {s.allowedToOperate === false && <Badge color="red">Not allowed to operate</Badge>}
            {s.available !== false && <Badge color={RATING_TONE[s.rating] || 'gray'}>{s.rating ? `${s.rating} rating` : 'Not rated'}</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 flex-row items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={refreshing} onClick={onRefresh}>Refresh</Button>
          <p className="text-xs text-muted">Data as of <span className="tabular">{dateTime(p.fetchedAt)}</span></p>
        </div>
      </div>
      {p.flags?.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="FMCSA flags">
          {p.flags.map((f) => <li key={f.code}><Chip tone={f.level}>{f.text}</Chip></li>)}
        </ul>
      )}
      {(stale || refreshError) && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-[13px] text-fg-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-c-amber" aria-hidden />
          <span>{refreshError ? `Could not refresh: ${refreshError}` : `FMCSA did not answer just now${staleError ? ` (${staleError})` : ''}. Showing the copy from ${dateTime(p.fetchedAt)}.`}</span>
        </p>
      )}
      {!p.complete && !stale && <p className="text-xs text-muted">Some FMCSA sources did not answer. Their sections say so; Refresh tries again.</p>}
    </Card>
  );
}

function CompanySection({ p, carrierId }) {
  const id = p.identity || {};
  const c = p.contact || {};
  const lic = c.licensing;
  return (
    <Section title="Company and contact">
      {!c.available && !id.legalName ? <Unavailable /> : (
        <Rows>
          <Row k="Legal name">{id.legalName}</Row>
          {id.dbaName && <Row k="DBA">{id.dbaName}</Row>}
          <Row k="USDOT status">{id.usdotStatus ? <Badge color={id.usdotStatus === 'active' ? 'green' : id.usdotStatus === 'inactive' ? 'red' : 'amber'}>{id.usdotStatus === 'active' ? 'Active' : id.usdotStatus === 'inactive' ? 'Inactive' : 'Pending'}</Badge> : '—'}</Row>
          {id.registeredAt && <Row k="USDOT since"><Num>{day(id.registeredAt)}</Num></Row>}
          {id.businessType && <Row k="Business type">{id.businessType}</Row>}
          {id.officers?.length > 0 && <Row k="Officers">{id.officers.join(', ')}</Row>}
          {id.dunsNumber && <Row k="DUNS"><Num>{id.dunsNumber}</Num></Row>}
          {id.dockets?.length > 0 && <Row k="Dockets"><Num>{id.dockets.map((d) => d.docket).join(', ')}</Num></Row>}
          {c.available && <>
            <Row k="Phone">{c.phone ? <PhoneLink phone={c.phone} carrierId={carrierId} /> : '—'}</Row>
            {c.cellPhone && <Row k="Cell phone"><PhoneLink phone={c.cellPhone} carrierId={carrierId} /></Row>}
            {c.fax && <Row k="Fax"><Num>{phoneFmt(c.fax)}</Num></Row>}
            <Row k="Email">{c.email ? <a className="break-all text-brand-700 hover:underline dark:text-brand-300" href={`mailto:${c.email}`}>{c.email}</a> : '—'}</Row>
            <Row k="Physical address">
              {addressText(c.physicalAddress) || '—'}
              {c.physicalUndeliverable && <Chip tone="amber" className="ml-1.5">Undeliverable</Chip>}
            </Row>
            <Row k="Mailing address">
              {addressText(c.mailingAddress) || '—'}
              {c.mailingUndeliverableSince && <Chip tone="amber" className="ml-1.5">Undeliverable since {day(c.mailingUndeliverableSince)}</Chip>}
            </Row>
            {lic && (!lic.sameAsCensus || lic.undeliverable) && (
              <Row k="Licensing address">
                {addressText(lic.businessAddress) || '—'}{lic.phone && lic.phone !== c.phone ? <> · <PhoneLink phone={lic.phone} carrierId={carrierId} /></> : null}
                {lic.undeliverable && <Chip tone="amber" className="ml-1.5">Mail returned undeliverable</Chip>}
              </Row>
            )}
          </>}
        </Rows>
      )}
      {(id.partial || c.partial) && <p className="text-xs text-muted">The FMCSA census did not answer; shown from FMCSA licensing records.</p>}
    </Section>
  );
}

function AuthoritySection({ a }) {
  if (!a?.available) return <Section title="Authority"><Unavailable /></Section>;
  const history = a.history || [];
  return (
    <Section title="Authority">
      <Rows>
        <Row k="Status"><span className="inline-flex flex-wrap items-center gap-1.5"><AuthorityStatusBadge authority={a} /><span className="text-fg-2">{a.label}</span></span></Row>
        <Row k="MC age (authority since)">{a.since ? <Num>{day(a.since)} · {a.ageYears >= 1 ? `${num(a.ageYears, 1)} years` : `${num(a.ageDays)} days`}</Num> : (a.history ? 'No grant on record' : 'Not available right now')}</Row>
        <Row k="Revoked before">{a.revokedBefore == null ? '—' : a.revokedBefore ? <>Yes{a.lastRevokedAt && <>, last on <Num>{day(a.lastRevokedAt)}</Num></>}{a.revocations > 1 && <> ({a.revocations} times)</>}</> : 'No'}</Row>
      </Rows>
      {a.types?.length > 0 && (
        <ul className="space-y-1.5 text-sm">
          {a.types.map((t, i) => (
            <li key={`${t.docket}-${t.type}-${i}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="min-w-0"><span className="font-mono text-xs tabular text-muted">{t.docket}</span> {t.type}</span>
              <Badge color={t.status === 'active' ? 'green' : t.status === 'pending' ? 'amber' : 'gray'}>{t.status ? t.status.charAt(0).toUpperCase() + t.status.slice(1) : '—'}</Badge>
            </li>
          ))}
        </ul>
      )}
      {a.basis && BASIS[a.basis] && <p className="text-xs text-muted">{BASIS[a.basis]}{a.partial && a.basis !== 'qcmobile' ? ' One authority source did not answer.' : ''}</p>}
      <div>
        <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">History</h4>
        {!a.history ? <Unavailable /> : !history.length ? <p className="text-sm text-muted">No authority actions on record.</p> : (
          <ol className="space-y-1.5 border-l border-line pl-3 text-sm">
            <ShowMore items={history} initial={6} noun="actions" render={(e, i) => (
              <li key={`${e.date}-${e.action}-${i}`} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2">
                <span className="tabular text-muted">{day(e.date)}</span>
                <span className="min-w-0"><span className="font-medium">{e.action}</span>{e.type && <span className="text-muted"> · {e.type}</span>}</span>
              </li>
            )} />
          </ol>
        )}
        {a.historyPartial && a.history && <p className="mt-1 text-xs text-muted">One authority history source did not answer; the list may be incomplete.</p>}
      </div>
    </Section>
  );
}

function InsuranceSection({ ins, a }) {
  if (!ins?.available) return <Section title="Insurance"><Unavailable /></Section>;
  const req = ins.required;
  const filed = ins.filed;
  return (
    <Section title="Insurance">
      <Rows>
        <Row k="BIPD required"><Num>{req?.bipd != null ? usd(req.bipd) : '—'}</Num></Row>
        <Row k="BIPD on file">{filed?.bipd != null ? <Num>{filed.bipd > 0 ? usd(filed.bipd) : 'None'}</Num> : a?.insuranceOnFile != null ? yesNo(a.insuranceOnFile) : '—'}</Row>
        <Row k="Cargo">{req?.cargo == null ? '—' : `${req.cargo ? 'Required' : 'Not required'}${filed?.cargo != null ? `, ${filed.cargo ? 'on file' : 'none on file'}` : ''}`}</Row>
        <Row k="Bond">{req?.bond == null ? '—' : `${req.bond ? 'Required' : 'Not required'}${filed?.bond != null ? `, ${filed.bond ? 'on file' : 'none on file'}` : ''}`}</Row>
      </Rows>
      <div>
        <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Policies on file</h4>
        {ins.onFile == null ? <Unavailable /> : !ins.onFile.length ? <p className="text-sm text-muted">No policies on file.</p> : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {ins.onFile.map((x, i) => (
              <li key={`${x.policy}-${x.effective}-${i}`} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{x.type}</span>
                  <span className="tabular">{x.coverage != null ? usd(x.coverage) : ''}{x.underlying ? <span className="text-muted"> over {usd(x.underlying)}</span> : null}</span>
                </div>
                <p className="text-fg-2">{x.company || 'Insurer not listed'}</p>
                <p className="text-xs text-muted"><Num>Policy {x.policy || '—'} · effective {day(x.effective)}</Num></p>
                {x.cancelEffective && <Chip tone="amber" className="mt-1">Cancels {day(x.cancelEffective)}</Chip>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Cancellations and replacements</h4>
        {ins.history == null ? <Unavailable /> : !ins.history.length ? <p className="text-sm text-muted">No earlier policies on record.</p> : (
          <ul className="space-y-1.5 text-sm">
            <ShowMore items={ins.history} initial={4} noun="policies" render={(h, i) => (
              <li key={`${h.policy}-${h.effective}-${i}`}>
                <span className="font-medium">{h.reason || 'Ended'}</span> <span className="text-fg-2">· {h.type}{h.coverage != null ? ` ${usd(h.coverage)}` : ''}</span>
                <p className="text-xs text-muted"><Num>{day(h.effective)} to {day(h.cancelEffective)}</Num> · {h.company || 'Insurer not listed'}{h.policy ? ` · ${h.policy}` : ''}</p>
              </li>
            )} />
          </ul>
        )}
        {ins.historyCount > (ins.history?.length || 0) && <p className="mt-1 text-xs text-muted">Showing the latest {ins.history.length} of {ins.historyCount}.</p>}
      </div>
      {ins.lapses?.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Gaps in BIPD coverage</h4>
          <ul className="space-y-1 text-sm">
            {ins.lapses.map((l) => <li key={`${l.from}-${l.to}`}><Num>{day(l.from)} to {day(l.to)}</Num> <span className="text-muted">({num(l.days)} days)</span></li>)}
          </ul>
        </div>
      )}
      {ins.legacyAsOf && <p className="text-xs text-muted">Legacy insurance records were last updated by FMCSA on {day(ins.legacyAsOf)}.</p>}
    </Section>
  );
}

function OperationSection({ op, cargo }) {
  return (
    <Section title="Operation and cargo" defaultOpen={false}>
      {!op?.available ? <Unavailable /> : (
        <Rows>
          <Row k="Operation">{op.carrierOperation}</Row>
          <Row k="Classification">{op.classifications?.length ? op.classifications.join(', ') : '—'}</Row>
          {op.entityTypes?.length > 0 && <Row k="Entity type">{op.entityTypes.join(', ')}</Row>}
          <Row k="Hazmat">{yesNo(op.hazmat)}</Row>
        </Rows>
      )}
      <div>
        <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Cargo carried</h4>
        {cargo == null ? <Unavailable /> : !cargo.length ? <p className="text-sm text-muted">No cargo classes listed.</p> : (
          <ul className="flex flex-wrap gap-1.5">{cargo.map((c) => <li key={c}><Badge>{c}</Badge></li>)}</ul>
        )}
      </div>
    </Section>
  );
}

function FleetSection({ fleet, equipment }) {
  return (
    <Section title="Fleet and equipment" defaultOpen={false}>
      {!fleet?.available ? <Unavailable /> : (
        <Rows>
          <Row k="Power units"><Num>{num(fleet.powerUnits)}</Num></Row>
          {fleet.trucks != null && <Row k="Trucks"><Num>{num(fleet.trucks)}</Num></Row>}
          {fleet.buses ? <Row k="Buses"><Num>{num(fleet.buses)}</Num></Row> : null}
        </Rows>
      )}
      {!equipment?.available ? (fleet?.available ? <Unavailable>Equipment details not available right now</Unavailable> : null) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 pr-2 font-medium">Equipment</th>
                <th className="py-1 pr-2 text-right font-medium">Owned</th>
                <th className="py-1 pr-2 text-right font-medium">Term leased</th>
                <th className="py-1 text-right font-medium">Trip leased</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {equipment.rows.map((r) => (
                <tr key={r.kind}>
                  <td className="py-1.5 pr-2">{r.kind}</td>
                  <td className="py-1.5 pr-2 text-right tabular">{num(r.owned)}</td>
                  <td className="py-1.5 pr-2 text-right tabular">{num(r.termLeased)}</td>
                  <td className="py-1.5 text-right tabular">{num(r.tripLeased)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function DriversSection({ drivers: d, mileage: m }) {
  return (
    <Section title="Drivers and mileage" defaultOpen={false}>
      {!d?.available ? <Unavailable /> : (
        <Rows>
          <Row k="Drivers"><Num>{num(d.total)}</Num></Row>
          {d.cdl != null && <Row k="CDL holders"><Num>{num(d.cdl)}</Num></Row>}
          {d.interstate != null && <Row k="Interstate"><Num>{num(d.interstate)}</Num>{(d.interstateWithin100 != null || d.interstateBeyond100 != null) && <span className="text-muted"> · <Num>{num(d.interstateWithin100)}</Num> within, <Num>{num(d.interstateBeyond100)}</Num> beyond 100 miles</span>}</Row>}
          {d.intrastate != null && <Row k="Intrastate"><Num>{num(d.intrastate)}</Num>{(d.intrastateWithin100 != null || d.intrastateBeyond100 != null) && <span className="text-muted"> · <Num>{num(d.intrastateWithin100)}</Num> within, <Num>{num(d.intrastateBeyond100)}</Num> beyond 100 miles</span>}</Row>}
          {d.avgLeasedPerMonth != null && <Row k="Leased per month"><Num>{num(d.avgLeasedPerMonth)}</Num> <span className="text-muted">on average</span></Row>}
          {m?.available && <Row k="Mileage">{m.miles != null ? <Num>{num(m.miles)} miles{m.year ? ` in ${m.year}` : ''}</Num> : '—'}</Row>}
        </Rows>
      )}
    </Section>
  );
}

const LIVE_NOTE = {
  not_configured: 'Inspections, crashes and BASIC scores come from FMCSA QCMobile, which needs the free FMCSA web key. An admin can add it in Admin → Integrations.',
  failed: 'Live safety data (FMCSA QCMobile) is not available right now.',
  not_found: 'FMCSA QCMobile has no safety record for this USDOT number.',
};

function SafetySection({ s }) {
  if (!s?.available) return <Section title="Safety" defaultOpen={false}><Unavailable /></Section>;
  const rows = s.inspections ? [['Driver', s.inspections.driver], ['Vehicle', s.inspections.vehicle], ['Hazmat', s.inspections.hazmat]] : [];
  return (
    <Section title="Safety" defaultOpen={false}>
      <Rows>
        <Row k="Safety rating">{s.rating ? <><Badge color={RATING_TONE[s.rating]}>{s.rating}</Badge>{s.ratingDate && <span className="text-muted"> on <Num>{day(s.ratingDate)}</Num></span>}</> : 'Not rated'}</Row>
        {s.review && <Row k="Latest review">{s.review.type || '—'}{s.review.date && <span className="text-muted"> on <Num>{day(s.review.date)}</Num></span>}</Row>}
        {s.recordableCrashRate != null && s.recordableCrashRate > 0 && <Row k="Crash rate"><Num>{s.recordableCrashRate}</Num> <span className="text-muted">recordable per million miles (at the review)</span></Row>}
        {s.live && <Row k="Allowed to operate">{yesNo(s.allowedToOperate)}</Row>}
        {s.oosDate && <Row k="Out of service"><Chip tone="red">Since {day(s.oosDate)}</Chip></Row>}
      </Rows>
      {!s.live ? <p className="text-xs text-muted">{LIVE_NOTE[s.liveStatus] || LIVE_NOTE.failed}</p> : (
        <>
          {s.crashes && (
            <div>
              <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Crashes (last 24 months)</h4>
              <dl className="grid grid-cols-4 gap-2 text-center text-sm">
                {[['Fatal', s.crashes.fatal], ['Injury', s.crashes.injury], ['Tow-away', s.crashes.tow], ['Total', s.crashes.total]].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-line px-1 py-1.5">
                    <dt className="text-xs text-muted">{k}</dt>
                    <dd className={cx('font-medium tabular', k === 'Fatal' && v > 0 && 'text-c-red')}>{num(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">Inspections (last 24 months)</h4>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 pr-2 font-medium">Type</th>
                    <th className="py-1 pr-2 text-right font-medium">Inspections</th>
                    <th className="py-1 pr-2 text-right font-medium">Out of service</th>
                    <th className="py-1 pr-2 text-right font-medium">OOS rate</th>
                    <th className="py-1 text-right font-medium">National avg</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map(([k, i]) => {
                    const high = i.inspections >= 3 && i.oosRate != null && i.nationalAvg != null && i.oosRate > i.nationalAvg;
                    return (
                      <tr key={k}>
                        <td className="py-1.5 pr-2">{k}</td>
                        <td className="py-1.5 pr-2 text-right tabular">{num(i.inspections)}</td>
                        <td className="py-1.5 pr-2 text-right tabular">{num(i.oos)}</td>
                        <td className={cx('py-1.5 pr-2 text-right tabular', high && 'font-medium text-c-amber')}>{i.oosRate != null ? `${i.oosRate}%` : '—'}</td>
                        <td className="py-1.5 text-right tabular text-muted">{i.nationalAvg != null ? `${i.nationalAvg}%` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div>
            <h4 className="mb-1.5 text-[13px] font-medium text-fg-2">BASIC percentiles (SMS)</h4>
            {s.basics == null ? <Unavailable /> : !s.basics.length ? <p className="text-sm text-muted">No BASIC measures on record.</p> : (
              <ul className="space-y-1.5 text-sm">
                {s.basics.map((b) => (
                  <li key={b.name} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0">{b.name}</span>
                    <span className="inline-flex items-center gap-2">
                      <span className="tabular">{b.percentile != null ? `${b.percentile}%` : <span className="text-muted">Not public</span>}</span>
                      {b.threshold != null && <span className="text-xs tabular text-muted">threshold {b.threshold}%</span>}
                      {b.alert && <Badge color="amber">Alert</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function ComplianceSection({ c, a }) {
  return (
    <Section title="Compliance" defaultOpen={false}>
      {!c?.available ? <Unavailable /> : (
        <Rows>
          <Row k="MCS-150 updated">{c.mcs150Date ? <span className="inline-flex flex-wrap items-center gap-1.5"><Num>{day(c.mcs150Date)}</Num>{c.mcs150AgeMonths != null && <span className="text-muted">({num(c.mcs150AgeMonths)} months ago)</span>}{c.outdated && <Chip tone="amber">Outdated (over 24 months)</Chip>}</span> : '—'}</Row>
          <Row k="Prior USDOT revoked">{c.priorRevoke?.flag == null ? '—' : c.priorRevoke.flag ? <>Yes{c.priorRevoke.dot && <> (USDOT <Num>{c.priorRevoke.dot}</Num>)</>}</> : 'No'}</Row>
          <Row k="Authority revoked before">{a?.revokedBefore == null ? '—' : a.revokedBefore ? <>Yes{a.lastRevokedAt && <>, last on <Num>{day(a.lastRevokedAt)}</Num></>}</> : 'No'}</Row>
        </Rows>
      )}
    </Section>
  );
}

const SOURCE_STATUS = { ok: ['green', 'OK'], failed: ['amber', 'Not available right now'], skipped: ['gray', 'Not set up'] };
function SourcesSection({ p }) {
  return (
    <Section title="Sources" defaultOpen={false} className="lg:col-span-2">
      <ul className="divide-y divide-line text-sm">
        {(p.sources || []).map((s) => {
          const [tone, text] = SOURCE_STATUS[s.status] || SOURCE_STATUS.failed;
          return (
            <li key={s.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
              <span className="min-w-0">
                {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{s.name}</a> : s.name}
                {s.dataset && <span className="ml-1 font-mono text-xs text-muted">{s.dataset}</span>}
                {s.note && <span className="block text-xs text-muted">{s.note}</span>}
              </span>
              <span className="inline-flex items-center gap-2">
                {s.asOf && <span className="text-xs tabular text-muted">as of {date(s.asOf, UTC_DAY)}</span>}
                <Badge color={tone} title={s.error || undefined}>{text}</Badge>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" icon={ExternalLink} href={p.saferUrl} target="_blank" rel="noopener noreferrer">SAFER snapshot</Button>
        <p className="text-xs text-muted">FMCSA public data. Check the SAFER snapshot before booking a load.</p>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------

export default function FmcsaProfile({ carrierId, dot }) {
  const qc = useQueryClient();
  const { key, url } = target(carrierId, dot);
  const enabled = !!(carrierId || digits(dot));
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get(url, undefined, { signal, timeoutMs: TIMEOUT_MS }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      qc.setQueryData(key, await api.get(url, { refresh: 1 }, { timeoutMs: TIMEOUT_MS }));
    } catch (err) {
      setRefreshError(err?.message || 'FMCSA did not answer');
    } finally {
      setRefreshing(false);
    }
  };

  if (!enabled) return <EmptyState icon={ShieldCheck} title="No USDOT number">Add a USDOT number to see the FMCSA profile.</EmptyState>;
  if (q.isLoading) return <Loading label="Loading the FMCSA profile…" />;
  if (q.isError) {
    const missing = q.error?.status === 404;
    return <ErrorState title={missing ? 'No FMCSA record' : 'Could not load the FMCSA profile'} error={q.error} onRetry={missing ? undefined : () => q.refetch()} />;
  }
  const p = q.data?.profile;
  if (!p) return <Loading label="Loading the FMCSA profile…" />;
  return (
    <div className="space-y-4">
      <Header p={p} onRefresh={refresh} refreshing={refreshing} stale={q.data.stale} staleError={q.data.error} refreshError={refreshError} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <CompanySection p={p} carrierId={carrierId} />
          <OperationSection op={p.operation} cargo={p.cargo} />
          <FleetSection fleet={p.fleet} equipment={p.equipment} />
          <DriversSection drivers={p.drivers} mileage={p.mileage} />
        </div>
        <div className="min-w-0 space-y-4">
          <AuthoritySection a={p.authority} />
          <InsuranceSection ins={p.insurance} a={p.authority} />
          <SafetySection s={p.safety} />
          <ComplianceSection c={p.compliance} a={p.authority} />
        </div>
        <SourcesSection p={p} />
      </div>
    </div>
  );
}

/** The profile tab of a saved carrier: an empty state until the carrier has a USDOT number. */
export function FmcsaProfileTab({ carrier }) {
  if (!digits(carrier?.dotNumber)) {
    return (
      <Card>
        <EmptyState icon={ShieldCheck} title="No USDOT number">Add the carrier's USDOT number to see its full FMCSA profile: authority, insurance, fleet, drivers and safety.</EmptyState>
      </Card>
    );
  }
  return <FmcsaProfile carrierId={carrier.id} />;
}

/** Opens the FMCSA profile of any USDOT number in a wide dialog (lead lists, before saving). */
export function FmcsaProfileButton({ dot, label = 'FMCSA profile', size = 'sm', variant = 'secondary', className }) {
  const [open, setOpen] = useState(false);
  const d = digits(dot);
  if (!d) return null;
  return (
    <>
      <Button size={size} variant={variant} icon={ShieldCheck} className={className} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{label}</Button>
      {/* React events bubble through the portal: keep clicks in the dialog away from the row underneath. */}
      <span onClick={(e) => e.stopPropagation()} className="contents">
        <Modal open={open} onClose={() => setOpen(false)} title={`FMCSA profile · USDOT ${d}`} size="xl">
          {open && <FmcsaProfile dot={d} />}
        </Modal>
      </span>
    </>
  );
}
