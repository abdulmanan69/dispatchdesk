import { AlertTriangle, CalendarClock, ExternalLink, FileWarning, Link2, PhoneCall, Receipt, Timer, Truck, ClipboardList, Warehouse, MapPin } from 'lucide-react';
import { money, relative } from '../../lib/format.js';
import { Badge, Button, cx } from '../ui.jsx';
import CallButton from '../calling/CallButton.jsx';
import { RISK, timeIn, windowText, hoursText } from '../fleet/fleetApi.js';

export const SECTIONS = {
  appointments: { label: 'Appointments', icon: CalendarClock, tone: 'bg-c-blue-soft text-c-blue' },
  check_calls: { label: 'Check calls', icon: PhoneCall, tone: 'bg-c-purple-soft text-c-purple' },
  detention: { label: 'At the dock', icon: Timer, tone: 'bg-c-orange-soft text-c-orange' },
  available_trucks: { label: 'Empty trucks', icon: Truck, tone: 'bg-c-green-soft text-c-green' },
  missing_pod: { label: 'Missing POD', icon: FileWarning, tone: 'bg-c-amber-soft text-c-amber' },
  invoices: { label: 'Overdue invoices', icon: Receipt, tone: 'bg-c-red-soft text-c-red' },
  follow_ups: { label: 'Follow-ups', icon: ClipboardList, tone: 'bg-c-teal-soft text-c-teal' },
  documents: { label: 'Paperwork', icon: FileWarning, tone: 'bg-c-pink-soft text-c-pink' },
};

const lane = (l) => (l ? `${l.origin.city}, ${l.origin.state} → ${l.dest.city}, ${l.dest.state}` : '');
const fleetLink = (item) => (item.carrier ? `/app/fleet?truck=${item.carrier.id}${item.load ? `&trip=${item.load.id}` : ''}` : item.load ? `/app/loads?q=${encodeURIComponent(item.load.referenceNumber || item.load.origin.city)}` : null);
/** The load's detail on the Loads page, opened on a tab (stops for detention, documents for a missing POD). */
const loadLink = (item, tab) => (item.load ? `/app/loads?load=${item.load.id}${tab ? `&tab=${tab}` : ''}` : null);
/** Shape a board row's load into what the trip modals expect. */
export const tripFromItem = (item) => (item.load ? { ...item.load, broker: item.broker || null } : null);

function Detail({ item }) {
  switch (item.section) {
    case 'appointments':
      return (
        <>
          <span>{windowText(item.window)}</span>
          {(item.legalEta || item.eta) && <span> · ETA {timeIn(item.legalEta || item.eta, item.window?.tz)}</span>}
          <span className="block truncate text-muted">{item.carrier?.companyName || 'No truck assigned'} · {lane(item.load)}{item.load?.referenceNumber ? ` · ref ${item.load.referenceNumber}` : ''}</span>
        </>
      );
    case 'check_calls':
      return (
        <>
          <span>{item.lastContactAt ? `Last update ${relative(item.lastContactAt)}` : 'No update since it left'} · reminder every {item.everyHours} h</span>
          <span className="block truncate text-muted">{lane(item.load)}</span>
        </>
      );
    case 'detention':
      return (
        <>
          <span>{item.running ? `${hoursText(item.detentionMin)} past free time (${hoursText(item.freeMin)})` : `${hoursText(item.dwellMin)} at the dock · detention starts in ${hoursText(Math.max(0, item.freeMin - item.dwellMin))}`}</span>
          <span className="block truncate text-muted">{item.carrier?.companyName} · {lane(item.load)}</span>
        </>
      );
    case 'available_trucks':
      return <span>{item.location ? `In ${item.location}` : 'Location not set'}{item.availableAt ? ` · free ${relative(item.availableAt)}` : ''}</span>;
    case 'missing_pod':
      return <span className="block truncate">{item.carrier?.companyName || 'No carrier'} · delivered {relative(item.at)}</span>;
    case 'invoices':
      return <span>{money(item.invoice.balanceCents)} open · due {relative(item.invoice.dueAt)}</span>;
    case 'follow_ups':
      return <span>{item.followUp.overdue ? `Was due ${relative(item.at)}` : `Due ${timeIn(item.at)}`}{item.carrier ? ` · ${item.carrier.companyName}` : ''}</span>;
    case 'documents':
      return <span>{item.document ? `${item.document.name} · ${new Date(item.document.expiresAt).getTime() < Date.now() ? 'expired' : 'expires'} ${relative(item.document.expiresAt)}` : 'Upload the signed dispatch agreement'}</span>;
    default:
      return null;
  }
}

/** One row of the Today board with the next action for it. */
export default function TodayItem({ item, onCheckCall, onTrackingLink }) {
  const s = SECTIONS[item.section] || SECTIONS.appointments;
  const Icon = item.section === 'appointments' ? (item.kind === 'pickup' ? Warehouse : MapPin) : s.icon;
  const risk = item.risk ? RISK[item.risk] : null;
  const open = fleetLink(item);
  const active = item.load && ['planned', 'booked', 'in_transit'].includes(item.load.status);
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={cx('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg', s.tone)}><Icon className="size-4" aria-hidden /></span>
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{item.title}</span>
            {risk && <Badge color={risk.color}>{risk.label}</Badge>}
            {item.section === 'detention' && item.running && <Badge color="red">Detention</Badge>}
            {item.section === 'follow_ups' && item.followUp.overdue && <Badge color="amber">Overdue</Badge>}
            {item.priority === 0 && !risk && item.section !== 'detention' && <AlertTriangle className="size-3.5 text-c-red" aria-label="Needs action now" />}
          </div>
          <div className="text-fg-2"><Detail item={item} /></div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:justify-end">
        {(item.carrier?.phone || item.phone) && <CallButton variant="button" size="sm" phone={item.carrier?.phone || item.phone} carrierId={item.carrier?.id} label="Call" />}
        {(item.section === 'check_calls' || (item.section === 'appointments' && item.load?.status === 'in_transit')) && (
          <Button size="sm" variant="secondary" icon={PhoneCall} onClick={() => onCheckCall(item)}>Log check call</Button>
        )}
        {active && ['appointments', 'check_calls', 'detention'].includes(item.section) && (
          <Button size="sm" variant="secondary" icon={Link2} onClick={() => onTrackingLink(item)}>Tracking link</Button>
        )}
        {item.section === 'available_trucks' && <Button size="sm" variant="secondary" to={item.carrier ? `/app/truck-posts?truck=${item.carrier.id}` : '/app/truck-posts'}>Post truck</Button>}
        {item.section === 'detention' && item.load && <Button size="sm" variant="secondary" icon={Timer} to={loadLink(item, 'stops')}>Stop times</Button>}
        {item.section === 'missing_pod' && item.load && <Button size="sm" variant="secondary" icon={FileWarning} to={loadLink(item, 'documents')}>Add POD</Button>}
        {item.section === 'invoices' && <Button size="sm" variant="secondary" icon={ExternalLink} to={`/app/invoices?status=overdue&open=${item.invoice.id}`}>Open invoice</Button>}
        {item.section === 'follow_ups' && <Button size="sm" variant="secondary" icon={ExternalLink} to={item.followUp?.overdue ? '/app/follow-ups?view=overdue' : '/app/follow-ups'}>Open</Button>}
        {item.section === 'documents' && item.carrier && <Button size="sm" variant="secondary" icon={ExternalLink} to={`/app/carriers/${item.carrier.id}${item.document ? `?doc=${item.document.id}` : ''}`}>Open</Button>}
        {['appointments', 'check_calls', 'detention', 'available_trucks', 'missing_pod'].includes(item.section) && open && (
          <Button size="sm" variant="ghost" icon={ExternalLink} to={open}>{item.carrier ? 'Map' : 'Load'}</Button>
        )}
      </div>
    </li>
  );
}
