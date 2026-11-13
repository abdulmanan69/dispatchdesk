import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Phone, Mail, Pencil, Trash2, RefreshCw, CalendarPlus, ListOrdered, Plus, Pin, PinOff, ShieldCheck, X, ArrowLeft, ChevronLeft, ChevronRight, MessageSquare, Copy, Reply, FileSignature, Archive, AlertTriangle, CheckCircle2, OctagonX } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, dateTime, label, relative, money, PRESETS } from '../../lib/format.js';
import { Badge, Button, Card, ComboInput, EmptyState, ErrorState, Field, IconButton, Input, Loading, Pagination, RefreshError, Select, Switch, Tabs, Textarea, Checkbox, LocalClock, cx } from '../../components/ui.jsx';
import { AiBadge } from '../../components/email/ReviewQueue.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import CarrierForm from '../../components/carriers/CarrierForm.jsx';
import LogCallModal from '../../components/carriers/LogCallModal.jsx';
import FollowUpModal from '../../components/carriers/FollowUpModal.jsx';
import EnrollModal from '../../components/carriers/EnrollModal.jsx';
import { AuthorityBadge, OUTCOME_COLORS, PhoneLink, ResourceLinks, STAGES, authorityProblem, equipmentLabel, readCarrierNav, useAssignees, useTags } from '../../components/carriers/shared.jsx';
import CopyField, { copyText } from '../../components/carriers/CopyField.jsx';
import EnrichModal from '../../components/carriers/EnrichModal.jsx';
import TextLogModal from '../../components/carriers/TextLogModal.jsx';
import DieselCard from '../../components/carriers/DieselCard.jsx';
import ActivityRail from '../../components/carriers/ActivityRail.jsx';
import CallButton from '../../components/calling/CallButton.jsx';
import { useToast } from '../../components/Toast.jsx';
import DocumentsPanel from '../../components/documents/DocumentsPanel.jsx';
import ComposeModal from '../../components/email/ComposeModal.jsx';
import ContactConsentCard, { ConsentBadge } from '../../components/consent/ContactConsentCard.jsx';
import { FmcsaProfileTab } from '../../components/carriers/FmcsaProfile.jsx';
import { TierBadge, topReasons } from '../../components/carriers/LeadScore.jsx';
import { MenuButton } from '../../components/Menu.jsx';
import { NextStepBar, StageBar } from '../../components/carriers/NextStep.jsx';
import { nextStepFor } from '../../components/carriers/nextStep.js';
import OnboardingLinkModal from '../../components/onboarding/OnboardingLinkModal.jsx';
import OnboardingPanel from '../../components/onboarding/OnboardingPanel.jsx';

const CARRIER_TABS = ['overview', 'fmcsa', 'contacts', 'notes', 'calls', 'emails', 'followups', 'documents', 'sequences', 'activity'];

export default function CarrierDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  // ?tab=<tab> opens that tab; ?doc=<id> (document expiry notices, Today board) opens Documents.
  const [sp] = useSearchParams();
  const urlTab = sp.get('doc') ? 'documents' : CARRIER_TABS.includes(sp.get('tab')) ? sp.get('tab') : null;
  const [tab, setTab] = useState(urlTab || 'overview');
  useEffect(() => { if (urlTab) setTab(urlTab); }, [urlTab, id]);
  const [modal, setModal] = useState(null); // edit | call | followup | enroll | compose | text | enrich | onboarding
  const toast = useToast();
  const q = useQuery({ queryKey: ['carrier', id], queryFn: () => api.get(`/api/carriers/${id}`) });
  const inv = [['carrier', id], ['carriers'], ['pipeline']];
  const nav = readCarrierNav(id);

  // [ and ] step through the list this carrier was opened from (ignored while typing or with a dialog open).
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || modal) return;
      if (e.target.closest?.('input,textarea,[contenteditable=true],[role=dialog],[role=listbox]')) return;
      if (e.key === '[' && nav?.prev) navigate(`/app/carriers/${nav.prev}`);
      if (e.key === ']' && nav?.next) navigate(`/app/carriers/${nav.next}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav?.prev, nav?.next, modal, navigate]);

  const stage = useApiMutation((s) => api.post(`/api/carriers/${id}/stage`, { stage: s }), { success: (d) => `Moved to ${d.stage.name}`, invalidate: [...inv, ['dashboard']] });
  const patch = useApiMutation((body) => api.patch(`/api/carriers/${id}`, body), { success: 'Saved', invalidate: inv });
  const del = useApiMutation(() => api.del(`/api/carriers/${id}`), { success: 'Carrier deleted', invalidate: [['carriers'], ['pipeline']], onSuccess: () => navigate('/app/carriers') });

  if (q.isLoading) return <Loading />;
  // A failed refresh (after a call, note or stage change) keeps the profile on screen with a notice; a carrier that
  // was deleted meanwhile (404) shows "not found".
  if (q.isError && (!q.data || q.error?.status === 404)) return <ErrorState error={q.error} onRetry={q.refetch} title={q.error.status === 404 ? 'Carrier not found' : 'Could not load carrier'} />;
  const { carrier: c, callWindow, canWrite } = q.data;

  // Real totals from the server (the lists below are the latest rows only).
  const totals = {
    contacts: c._count?.contacts ?? c.contacts.length,
    notes: c._count?.notes ?? c.notes.length,
    calls: c._count?.calls ?? c.calls.length,
    pendingFollowUps: c.followUpCounts?.pending ?? c.followUps.filter((f) => f.status === 'pending').length,
  };
  const tabs = [
    { value: 'overview', label: 'Overview' },
    { value: 'fmcsa', label: 'FMCSA profile' },
    { value: 'contacts', label: 'Contacts', count: totals.contacts },
    { value: 'notes', label: 'Notes', count: totals.notes },
    { value: 'calls', label: 'Calls', count: totals.calls },
    { value: 'emails', label: 'Emails', count: c._count.emails },
    { value: 'followups', label: 'Follow-ups', count: totals.pendingFollowUps },
    { value: 'documents', label: 'Documents', count: c._count.documents },
    { value: 'sequences', label: 'Sequences', count: c.enrollments.length },
    { value: 'activity', label: 'Activity' },
  ];

  return (
    <div>
      <RefreshError query={q} />
      <CarrierHeader carrier={c} callWindow={callWindow} canWrite={canWrite} nav={nav} navigate={navigate}
        onStage={(k) => stage.mutate(k)} stagePending={stage.isPending} onModal={setModal} toast={toast} onTab={setTab}
        onDelete={async () => { if (await confirm({ title: 'Delete carrier?', message: `${c.companyName} and all its notes, calls, follow-ups and documents will be permanently deleted.`, danger: true })) del.mutate(); }} />

      {!canWrite && <p className="mb-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-muted">Read-only: this carrier belongs to {c.owner?.name}.</p>}

      <div className="mb-5 space-y-3">
        <StageBar stage={c.stage.key} canWrite={canWrite} pending={stage.isPending} onStage={(k) => stage.mutate(k)} />
        <NextStepBar step={nextStepFor(c, { callWindow })} carrier={c} canWrite={canWrite} onAction={(kind) => {
          if (kind === 'check') setTab('fmcsa');
          else if (kind === 'email') setModal('compose');
          else if (kind === 'followup') setModal('followup');
          else if (kind === 'onboarding') setModal('onboarding');
          else if (kind === 'agreement') { setTab('overview'); setTimeout(() => document.getElementById('agreement-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); }
          else if (kind === 'convert') stage.mutate('customer');
          else if (kind === 'customer' && c.customer) navigate(`/app/customers/${c.customer.id}`);
          else if (kind === 'sequence') setTab('sequences');
        }} />
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} className="mb-4" />

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <ContactCard carrier={c} canWrite={canWrite} save={(body) => patch.mutateAsync(body)} onEmail={() => setModal('compose')} />
            <Card title="Company" actions={canWrite && (c.dotNumber || c.mcNumber) && <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => setModal('enrich')}>Enrich from FMCSA</Button>}>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Item k="Equipment">{equipmentLabel(c.equipment)}</Item>
                <Item k="Authority"><AuthorityBadge status={c.authorityStatus} detail={c.operatingStatus} /> {c.authorityDate && <span className="ml-1 text-muted">since {date(c.authorityDate)}</span>}</Item>
                <Item k="Operating status">{c.operatingStatus || '—'}</Item>
                <Item k="Classification">{c.classification || '—'}</Item>
                <Item k="Carrier operation">{c.carrierOperation || '—'}</Item>
                <Item k="Source">{label(c.source)}{c.verifiedAt && <span className="ml-1 inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-400"><ShieldCheck className="size-3.5" />FMCSA checked {relative(c.verifiedAt)}</span>}</Item>
                <Item k="Added">{date(c.createdAt)}</Item>
                <Item k="Owner">{c.owner?.name || '—'}</Item>
              </dl>
            </Card>
            {(c.opportunity || c.customer) && (
              <Card title={c.customer ? 'Customer' : 'Opportunity'} actions={<Button size="sm" variant="secondary" to={c.customer ? `/app/customers/${c.customer.id}` : '/app/opportunities'}>Open</Button>}>
                {c.customer ? <p className="text-sm">Signed {date(c.customer.signedAt)} · status {label(c.customer.status)}{c.customer.dispatchFeePercent != null && ` · ${c.customer.dispatchFeePercent}% fee`}</p>
                  : <p className="text-sm">Status {label(c.opportunity.status)} · est. {money(c.opportunity.estimatedValueCents, { digits: 0 })}/mo · {c.opportunity.probability}% likely</p>}
              </Card>
            )}
            <TagsCard carrier={c} canWrite={canWrite} />
          </div>
          <div className="min-w-0 space-y-4">
            <DieselCard state={c.state} />
            <ActivityRail carrier={c} canWrite={canWrite} onLogCall={() => setModal('call')} onEmail={() => setModal('compose')} onText={() => setModal('text')} />
            <Card title="Resources"><ResourceLinks carrier={c} /></Card>
            <Card title="Call window">
              <div className="flex items-start gap-3">
                <span className={cx('mt-2 size-1.5 shrink-0 rounded-full', callWindow.callable ? 'bg-brand-600' : 'bg-line-strong')} aria-hidden />
                <div className="text-sm">
                  {callWindow.localTime ? <p className="font-mono text-sm font-medium tabular">{callWindow.localTime} local · {callWindow.localWeekday}</p> : <p className="font-medium">Local time unknown</p>}
                  <p className="text-xs text-muted">{callWindow.timezone || 'Add a state to detect the time zone'}</p>
                  <p className="mt-1.5">{callWindow.recommendation}</p>
                </div>
              </div>
            </Card>
            <Card title="Pipeline">
              <div className="space-y-3">
                <AssigneeField carrier={c} canWrite={canWrite} onSave={(v) => patch.mutate({ assignedToId: v || null })} />
                <Field label="Priority">
                  <Select value={c.priority} disabled={!canWrite} onChange={(e) => patch.mutate({ priority: Number(e.target.value) })}>
                    <option value={0}>Normal</option><option value={1}>High</option><option value={2}>Hot</option>
                  </Select>
                </Field>
                <div className="space-y-2 pt-1">
                  <Switch label="Do not call" checked={c.doNotCall} disabled={!canWrite} onChange={(v) => patch.mutate({ doNotCall: v })} />
                  <Switch label="Do not email" checked={c.doNotEmail} disabled={!canWrite} onChange={(v) => patch.mutate({ doNotEmail: v })} />
                </div>
                <p className="text-xs text-muted">Last contact {c.lastContactedAt ? relative(c.lastContactedAt) : 'never'} · next follow-up {c.nextFollowUpAt ? dateTime(c.nextFollowUpAt) : 'none'}</p>
              </div>
            </Card>
            {(['opportunity', 'trial', 'customer'].includes(c.stage.key) || c.onboarding) && (
              <div id="agreement-panel" className="scroll-mt-20">
                <OnboardingPanel carrier={{ id: c.id, companyName: c.companyName, email: c.email }} feePercent={c.customer?.dispatchFeePercent} showCreate={canWrite} />
              </div>
            )}
            <ContactConsentCard carrier={c} canWrite={canWrite} />
            {c.lists.length > 0 && <Card title="Prospect lists"><ul className="space-y-1 text-sm">{c.lists.map((l) => <li key={l.id}>{l.name}</li>)}</ul></Card>}
          </div>
        </div>
      )}

      {tab === 'contacts' && <ContactsTab carrier={c} canWrite={canWrite} />}
      {tab === 'notes' && <NotesTab carrier={c} canWrite={canWrite} total={totals.notes} />}
      {tab === 'calls' && (
        <Card title="Call history" actions={canWrite && <Button size="sm" icon={Phone} onClick={() => setModal('call')}>Log call</Button>} bodyClass="p-0">
          {!c.calls.length ? <EmptyState title="No calls logged yet" /> : (
            <>
              <ul className="divide-y divide-line">
                {c.calls.map((call) => (
                  <li key={call.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                    <div className="w-40 shrink-0 text-xs text-muted">{dateTime(call.calledAt)}<br />{call.user.name}</div>
                    <div className="flex-1 text-sm">
                      <Badge color={OUTCOME_COLORS[call.outcome]}>{label(call.outcome)}</Badge>
                      {call.durationSec ? <span className="ml-2 text-xs text-muted">{Math.round(call.durationSec / 60)} min</span> : null}
                      {call.notes && <p className="mt-1 whitespace-pre-wrap">{call.notes}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              <ShownOf shown={c.calls.length} total={totals.calls} what="calls" />
            </>
          )}
        </Card>
      )}
      {tab === 'emails' && <EmailsTab carrier={c} onCompose={() => setModal('compose')} canWrite={canWrite} />}
      {tab === 'followups' && <FollowUpsTab carrier={c} canWrite={canWrite} onNew={() => setModal('followup')} />}
      {tab === 'documents' && <DocumentsPanel carrierId={c.id} />}
      {tab === 'sequences' && <SequencesTab carrier={c} canWrite={canWrite} onEnroll={() => setModal('enroll')} />}
      {tab === 'activity' && <RecentActivity carrierId={c.id} />}
      {tab === 'fmcsa' && <FmcsaProfileTab carrier={c} />}

      {modal === 'edit' && <CarrierForm open carrier={c} onClose={() => setModal(null)} />}
      <LogCallModal open={modal === 'call'} carrier={c} onClose={() => setModal(null)} />
      <FollowUpModal open={modal === 'followup'} carrierId={c.id} carrierName={c.companyName} onClose={() => setModal(null)} />
      <EnrollModal open={modal === 'enroll'} carrierIds={[c.id]} onClose={() => setModal(null)} />
      {modal === 'compose' && <ComposeModal open carrierId={c.id} toEmail={c.email} onClose={() => setModal(null)} />}
      {modal === 'text' && <TextLogModal carrier={c} onClose={() => setModal(null)} />}
      {modal === 'enrich' && <EnrichModal carrier={c} onClose={() => setModal(null)} />}
      <OnboardingLinkModal open={modal === 'onboarding'} onClose={() => setModal(null)} carrier={c} feePercent={c.customer?.dispatchFeePercent} />
    </div>
  );
}

const prettyPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(p || '');
};
const tzShort = (tz) => ({ 'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii' }[tz] || tz?.split('/').pop()?.replace(/_/g, ' '));

function CopyBadge({ label: text, value, toast }) {
  return (
    <button type="button" title="Click to copy" onClick={async () => { if (await copyText(value)) toast.success(`${text} copied`); }}
      className="group inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs text-fg transition-ui hover:border-line-strong">
      {text}<Copy className="size-3 text-muted opacity-60 group-hover:opacity-100" aria-hidden />
    </button>
  );
}

const VERDICT = {
  fail: { icon: OctagonX, cls: 'border-c-red/30 bg-c-red-soft text-c-red' },
  warn: { icon: AlertTriangle, cls: 'border-c-amber/30 bg-c-amber-soft text-c-amber' },
  pass: { icon: CheckCircle2, cls: 'border-c-green/30 bg-c-green-soft text-c-green' },
};

/** FMCSA verdict chip (from the stored profile): opens the carrier check tab. */
function VerdictChip({ verdict, onOpen }) {
  const v = verdict && VERDICT[verdict.level];
  if (!v) {
    return (
      <button type="button" onClick={onOpen} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg-2 transition-ui hover:border-line-strong">
        <ShieldCheck className="size-3.5" aria-hidden />Run carrier check
      </button>
    );
  }
  const Icon = v.icon;
  return (
    <button type="button" onClick={onOpen} title={`${verdict.text}. Open the carrier check.`}
      className={cx('inline-flex max-w-[22rem] items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-ui hover:opacity-90', v.cls)}>
      <Icon className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{verdict.label}{verdict.level !== 'pass' ? `: ${verdict.text}` : ''}</span>
    </button>
  );
}

/**
 * Profile header: who this is, where they are, their local time and FMCSA verdict, and the actions of a call. Call is
 * the primary action; Email and Log call sit next to it; everything else is in More, so the header stays one row.
 */
function CarrierHeader({ carrier: c, callWindow, canWrite, nav, navigate, onStage, onModal, onDelete, onTab, toast }) {
  const primary = c.contacts.find((ct) => ct.isPrimary) || c.contacts[0];
  const place = [c.city, c.state].filter(Boolean).join(', ');
  const tz = callWindow?.timezone;
  const more = [
    { label: 'Log a text', icon: MessageSquare, onClick: () => onModal('text'), disabled: !c.phone },
    { label: 'Schedule follow-up', icon: CalendarPlus, onClick: () => onModal('followup') },
    { label: 'Enroll in sequence', icon: ListOrdered, onClick: () => onModal('enroll') },
    { label: 'Send agreement link', icon: FileSignature, onClick: () => onModal('onboarding') },
    { divider: true },
    { label: 'Carrier check', icon: ShieldCheck, onClick: () => onTab('fmcsa'), hidden: !c.dotNumber },
    { label: 'Update from FMCSA', icon: RefreshCw, onClick: () => onModal('enrich'), hidden: !(c.dotNumber || c.mcNumber) },
    { label: 'Edit details', icon: Pencil, onClick: () => onModal('edit') },
    { label: c.stage.key === 'archived' ? 'Move back to leads' : 'Archive', icon: Archive, onClick: () => onStage(c.stage.key === 'archived' ? 'lead' : 'archived') },
    { divider: true },
    { label: 'Delete carrier', icon: Trash2, onClick: onDelete, danger: true },
  ];
  return (
    <div className="mb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <Link to={nav?.back || '/app/carriers'} className="inline-flex items-center gap-1.5 text-fg-2 transition-ui hover:text-fg"><ArrowLeft className="size-4" aria-hidden />Carrier list</Link>
        {nav && (
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-muted tabular">{nav.index + 1} of {nav.total}</span>
            <Button size="sm" variant="secondary" icon={ChevronLeft} disabled={!nav.prev} title="Previous carrier ( [ )" onClick={() => navigate(`/app/carriers/${nav.prev}`)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={!nav.next} title="Next carrier ( ] )" onClick={() => navigate(`/app/carriers/${nav.next}`)}>Next<ChevronRight className="size-4" aria-hidden /></Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium tracking-[-0.01em]">{c.companyName}</h1>
          <p className="mt-1 text-sm text-fg-2">
            {[primary?.name, c.dbaName && `DBA ${c.dbaName}`, place, c.equipment && equipmentLabel(c.equipment)].filter(Boolean).join(' · ') || 'No location or equipment yet'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {c.mcNumber && <CopyBadge label={`MC-${c.mcNumber}`} value={c.mcNumber} toast={toast} />}
            {c.dotNumber && <CopyBadge label={`USDOT ${c.dotNumber}`} value={c.dotNumber} toast={toast} />}
            {tz && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg-2">
                <span className={cx('size-1.5 rounded-full', callWindow.callable ? 'bg-brand-600' : 'bg-line-strong')} aria-hidden />
                {tzShort(tz)} <LocalClock timezone={tz} />
              </span>
            )}
            {(c.dotNumber || c.fmcsaVerdict) && <VerdictChip verdict={c.fmcsaVerdict} onOpen={() => onTab('fmcsa')} />}
            {authorityProblem(c.authorityStatus) && c.fmcsaVerdict?.level !== 'fail' && <AuthorityBadge status={c.authorityStatus} detail={c.operatingStatus} />}
            {c.customer?.factoringCompany && (
              <span className="inline-flex max-w-[16rem] items-center rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted" title="Factoring company, from the customer profile">
                <span className="truncate">Factors with {c.customer.factoringCompany.name}</span>
              </span>
            )}
            {c.priority > 0 && <Badge color="amber">{c.priority === 2 ? 'Hot' : 'High priority'}</Badge>}
            {c.doNotCall && <Badge color="red">Do not call</Badge>}
            {c.doNotEmail && <Badge color="red">Do not email</Badge>}
            {c.stage.key === 'archived' && <Badge color="gray">Archived</Badge>}
            <ConsentBadge carrierId={c.id} />
          </div>
          {c.leadTier && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-2" aria-label="Lead score">
              <TierBadge tier={c.leadTier} score={c.leadScore} />
              {topReasons(c.leadSignals).map((s) => s.label).join(' · ') || 'Lead score from FMCSA data'}
            </p>
          )}
        </div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            {c.phone && !c.doNotCall && <CallButton variant="button" phone={c.phone} carrierId={c.id} label={`Call ${prettyPhone(c.phone)}`} />}
            <Button variant="secondary" icon={Mail} disabled={!c.email || c.doNotEmail} title={!c.email ? 'No email on file' : c.doNotEmail ? 'Do-not-email is on' : undefined} onClick={() => onModal('compose')}>Email</Button>
            <Button variant="secondary" icon={Phone} onClick={() => onModal('call')}>Log call</Button>
            <MenuButton label="More" items={more} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Contact and location fields: click to copy, pencil to edit in place. Extra phones live on contacts. */
function ContactCard({ carrier: c, canWrite, save, onEmail }) {
  const [adding, setAdding] = useState(false);
  const [phone2, setPhone2] = useState({ name: '', phone: '' });
  const addPhone = useApiMutation((body) => api.post(`/api/carriers/${c.id}/contacts`, body), {
    success: 'Phone added', invalidate: [['carrier', c.id]], onSuccess: () => { setAdding(false); setPhone2({ name: '', phone: '' }); },
  });
  const extraPhones = c.contacts.filter((ct) => ct.phone && ct.phone !== c.phone);
  const edit = canWrite ? save : undefined;
  const num = (k) => (v) => save({ [k]: v == null ? null : Number(String(v).replace(/[^\d]/g, '')) || null });
  return (
    <Card title="Contact">
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 text-[13px] font-medium text-fg-2">Phone and email</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <CopyField label="Phone" value={c.phone} display={prettyPhone(c.phone)} onSave={edit && ((v) => save({ phone: v }))} type="tel"
              action={c.phone && !c.doNotCall && <CallButton variant="button" size="sm" phone={c.phone} carrierId={c.id} label="Call" />} />
            <CopyField label="Email" value={c.email} onSave={edit && ((v) => save({ email: v }))} type="email"
              action={c.email && !c.doNotEmail && canWrite && <Button size="sm" variant="ghost" icon={Mail} onClick={onEmail}>Email</Button>} />
            {extraPhones.map((ct) => (
              <CopyField key={ct.id} label={ct.title || ct.name || 'Second phone'} value={ct.phone} display={prettyPhone(ct.phone)} editable={false}
                action={!c.doNotCall && <CallButton variant="button" size="sm" phone={ct.phone} carrierId={c.id} label="Call" />} />
            ))}
          </div>
          {canWrite && (adding ? (
            <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (phone2.phone.trim()) addPhone.mutate({ name: phone2.name.trim() || 'Second phone', title: phone2.name.trim() ? undefined : 'Second phone', phone: phone2.phone.trim() }); }}>
              <Field label="Who"><Input value={phone2.name} onChange={(e) => setPhone2({ ...phone2, name: e.target.value })} placeholder="Owner, dispatcher…" className="w-44" /></Field>
              <Field label="Phone" required><Input type="tel" value={phone2.phone} onChange={(e) => setPhone2({ ...phone2, phone: e.target.value })} required className="w-44" autoFocus /></Field>
              <Button type="submit" size="md" loading={addPhone.isPending}>Add</Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </form>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="mt-2 inline-flex items-center gap-1 text-[13px] text-fg-2 hover:text-fg"><Plus className="size-3.5" aria-hidden />Add second phone</button>
          ))}
        </section>
        <section>
          <h3 className="mb-2 text-[13px] font-medium text-fg-2">Company</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CopyField label="Company name" value={c.companyName} onSave={edit && ((v) => v && save({ companyName: v }))} />
            <CopyField label="USDOT" value={c.dotNumber} mono onSave={edit && ((v) => save({ dotNumber: v }))} />
            <CopyField label="MC" value={c.mcNumber} mono onSave={edit && ((v) => save({ mcNumber: v }))} />
            <CopyField label="Trucks" value={c.fleetSize == null ? '' : String(c.fleetSize)} onSave={edit && num('fleetSize')} type="number" />
            <CopyField label="Drivers" value={c.drivers == null ? '' : String(c.drivers)} onSave={edit && num('drivers')} type="number" />
            <CopyField label="DBA" value={c.dbaName} onSave={edit && ((v) => save({ dbaName: v }))} />
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-[13px] font-medium text-fg-2">Location</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CopyField label="Address" value={c.address} onSave={edit && ((v) => save({ address: v }))} className="sm:col-span-2 lg:col-span-1" />
            <CopyField label="City" value={c.city} onSave={edit && ((v) => save({ city: v }))} />
            <CopyField label="State" value={c.state} onSave={edit && ((v) => save({ state: v ? v.toUpperCase().slice(0, 2) : null }))} inputProps={{ maxLength: 2 }} />
            <CopyField label="ZIP code" value={c.zip} onSave={edit && ((v) => save({ zip: v }))} />
            <CopyField label="Time zone" value={c.timezone ? `${tzShort(c.timezone)} (${c.timezone})` : ''} editable={false} />
          </div>
        </section>
      </div>
    </Card>
  );
}

function Item({ k, children }) {
  return <div><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5">{children}</dd></div>;
}

function AssigneeField({ carrier, canWrite, onSave }) {
  const assignees = useAssignees();
  const items = assignees.data?.items || [];
  return (
    <Field label="Assigned dispatcher">
      <Select value={carrier.assignedTo?.id || ''} disabled={!canWrite || items.length < 1} onChange={(e) => onSave(e.target.value)}>
        <option value="">Unassigned</option>
        {items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        {carrier.assignedTo && !items.some((u) => u.id === carrier.assignedTo.id) && <option value={carrier.assignedTo.id}>{carrier.assignedTo.name}</option>}
      </Select>
    </Field>
  );
}

function TagsCard({ carrier, canWrite }) {
  const tags = useTags();
  const [name, setName] = useState('');
  const inv = [['carrier', carrier.id], ['carriers'], ['tags']];
  const add = useApiMutation((n) => api.post(`/api/carriers/${carrier.id}/tags`, { name: n }), { invalidate: inv, onSuccess: () => setName('') });
  const remove = useApiMutation((tagId) => api.del(`/api/carriers/${carrier.id}/tags/${tagId}`), { invalidate: inv });
  return (
    <Card title="Tags">
      <div className="flex flex-wrap gap-1.5">
        {carrier.tags.length ? carrier.tags.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1 rounded border border-line py-0.5 pl-1.5 pr-0.5 text-xs">
            <span className="size-1.5 rounded-full" style={{ background: t.color }} />{t.name}
            {canWrite && <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => remove.mutate(t.id)} className="rounded p-0.5 text-muted hover:text-fg"><X className="size-3" /></button>}
          </span>
        )) : <span className="text-sm text-muted">No tags</span>}
      </div>
      {canWrite && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(name.trim()); }}>
          <ComboInput aria-label="Add tag" placeholder="Add tag" value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
            options={[...new Set([...(tags.data?.items || []).map((t) => t.name), ...PRESETS.tagNames])].filter((n) => !carrier.tags.some((t) => t.name === n))} />
          <Button type="submit" size="md" variant="secondary" loading={add.isPending}>Add</Button>
        </form>
      )}
    </Card>
  );
}

function ContactsTab({ carrier, canWrite }) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const inv = [['carrier', carrier.id]];
  const save = useApiMutation(
    (body) => (editing?.id ? api.patch(`/api/carriers/${carrier.id}/contacts/${editing.id}`, body) : api.post(`/api/carriers/${carrier.id}/contacts`, body)),
    { success: 'Contact saved', invalidate: inv, onSuccess: () => setEditing(null) },
  );
  const del = useApiMutation((cid) => api.del(`/api/carriers/${carrier.id}/contacts/${cid}`), { success: 'Contact removed', invalidate: inv });
  return (
    <Card title="Contacts" actions={canWrite && <Button size="sm" icon={Plus} onClick={() => setEditing({})}>Add contact</Button>} bodyClass="p-0">
      {!carrier.contacts.length ? <EmptyState title="No contacts yet">Add the owner, dispatcher or safety manager you talk to.</EmptyState> : (
        <ul className="divide-y divide-line">
          {carrier.contacts.map((ct) => (
            <li key={ct.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="flex-1">
                <p className="font-medium">{ct.name} {ct.isPrimary && <Badge color="brand">Primary</Badge>}</p>
                <p className="text-xs text-muted">{[ct.title, ct.email].filter(Boolean).join(' · ')}</p>
              </div>
              <PhoneLink phone={ct.phone} />
              {canWrite && <>
                <IconButton icon={Pencil} label="Edit contact" onClick={() => setEditing(ct)} />
                <IconButton icon={Trash2} label="Delete contact" onClick={async () => { if (await confirm({ title: 'Remove contact?', message: ct.name, danger: true })) del.mutate(ct.id); }} />
              </>}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit contact' : 'Add contact'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="contact-form" loading={save.isPending}>Save</Button></>}>
        {editing && (
          <form id="contact-form" className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            save.mutate({ name: f.get('name'), title: f.get('title'), phone: f.get('phone'), email: f.get('email'), isPrimary: f.get('isPrimary') === 'on' });
          }}>
            <Field label="Name" required><Input name="name" defaultValue={editing.name} required /></Field>
            <Field label="Title"><Input name="title" defaultValue={editing.title || ''} placeholder="Owner, dispatcher, safety…" /></Field>
            <Field label="Phone"><Input name="phone" type="tel" defaultValue={editing.phone || ''} /></Field>
            <Field label="Email"><Input name="email" type="email" defaultValue={editing.email || ''} /></Field>
            <Checkbox name="isPrimary" label="Primary contact" defaultChecked={editing.isPrimary} />
          </form>
        )}
      </Modal>
    </Card>
  );
}

/** "Showing the latest 50 of 312 calls" when a profile list is shorter than the real total. */
function ShownOf({ shown, total, what }) {
  if (!total || total <= shown) return null;
  return <p className="border-t border-line px-4 py-2 text-center text-xs text-muted">Showing the latest {shown} of {total.toLocaleString('en-US')} {what}.</p>;
}

function NotesTab({ carrier, canWrite, total }) {
  const confirm = useConfirm();
  const [body, setBody] = useState('');
  const inv = [['carrier', carrier.id]];
  const add = useApiMutation((b) => api.post(`/api/carriers/${carrier.id}/notes`, { body: b }), { success: 'Note added', invalidate: inv, onSuccess: () => setBody('') });
  const pin = useApiMutation(({ id, pinned }) => api.patch(`/api/carriers/${carrier.id}/notes/${id}`, { pinned }), { invalidate: inv });
  const del = useApiMutation((nid) => api.del(`/api/carriers/${carrier.id}/notes/${nid}`), { success: 'Note deleted', invalidate: inv });
  return (
    <Card title="Notes">
      {canWrite && (
        <form className="mb-4 space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(body.trim()); }}>
          <Textarea aria-label="New note" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Lanes they like, rate expectations, best time to call…" />
          <div className="flex justify-end"><Button type="submit" size="sm" loading={add.isPending} disabled={!body.trim()}>Add note</Button></div>
        </form>
      )}
      {!carrier.notes.length ? <p className="text-sm text-muted">No notes yet.</p> : (
        <ul className="space-y-3">
          {carrier.notes.map((n) => (
            <li key={n.id} className={cx('rounded-md border border-line p-3', n.pinned && 'border-signal-400/60 bg-amber-50/40 dark:bg-amber-950/10')}>
              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span>{n.author.name} · {dateTime(n.createdAt)}{n.pinned && ' · pinned'}</span>
                {canWrite && <span className="flex">
                  <IconButton icon={n.pinned ? PinOff : Pin} label={n.pinned ? 'Unpin note' : 'Pin note'} onClick={() => pin.mutate({ id: n.id, pinned: !n.pinned })} />
                  <IconButton icon={Trash2} label="Delete note" onClick={async () => { if (await confirm({ title: 'Delete note?', message: 'This cannot be undone.', danger: true })) del.mutate(n.id); }} />
                </span>}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
      {total > carrier.notes.length && <p className="mt-3 text-center text-xs text-muted">Showing the pinned and latest {carrier.notes.length} of {total.toLocaleString('en-US')} notes.</p>}
    </Card>
  );
}

function EmailsTab({ carrier, onCompose, canWrite }) {
  const q = useQuery({ queryKey: ['emails', 'carrier', carrier.id], queryFn: () => api.get('/api/email/messages', { carrierId: carrier.id, pageSize: 50 }) });
  const color = { sent: 'green', failed: 'red', scheduled: 'blue', draft: 'gray', sending: 'amber', canceled: 'gray', review: 'amber' };
  return (
    <Card title="Emails" bodyClass="p-0" actions={canWrite && <div className="flex flex-wrap gap-2"><MarkRepliedButton carrier={carrier} /><Button size="sm" icon={Mail} disabled={!carrier.email || carrier.doNotEmail} onClick={onCompose}>Compose</Button></div>}>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data.items?.length ? <EmptyState title="No emails with this carrier yet" /> : (
        <ul className="divide-y divide-line">
          {q.data.items.map((m) => (
            <li key={m.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge color={color[m.status] || 'gray'}>{m.status === 'review' ? 'Needs approval' : label(m.status)}</Badge>
                {m.aiGenerated && <AiBadge />}
                {m.repliedAt && <Badge color="teal">Replied</Badge>}
                {m.bouncedAt && <Badge color="red">Bounced</Badge>}
                <span className="font-medium">{m.subject}</span>
                <span className="ml-auto text-xs text-muted">{dateTime(m.sentAt || m.scheduledAt || m.createdAt)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-muted">{String(m.body || '').replace(/<[^>]+>/g, ' ').slice(0, 300)}</p>
              {m.error && <p className="mt-1 text-xs text-red-600">{m.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function FollowUpsTab({ carrier, canWrite, onNew }) {
  const confirm = useConfirm();
  const [edit, setEdit] = useState(null);
  const inv = [['carrier', carrier.id], ['follow-ups'], ['queue']];
  const complete = useApiMutation((fid) => api.post(`/api/follow-ups/${fid}/complete`), { success: 'Follow-up completed', invalidate: inv });
  const del = useApiMutation((fid) => api.del(`/api/follow-ups/${fid}`), { success: 'Follow-up deleted', invalidate: inv });
  return (
    <Card title="Follow-ups" bodyClass="p-0" actions={canWrite && <Button size="sm" icon={CalendarPlus} onClick={onNew}>Schedule</Button>}>
      {!carrier.followUps.length ? <EmptyState title="No follow-ups scheduled" /> : (
        // Pending follow-ups (soonest first), then the most recently completed ones.
        <ul className="divide-y divide-line">
          {carrier.followUps.map((f) => {
            const overdue = f.status === 'pending' && new Date(f.dueAt) < new Date();
            return (
              <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <Badge color={f.status === 'done' ? 'green' : overdue ? 'red' : 'blue'}>{f.status === 'done' ? 'Done' : overdue ? 'Overdue' : label(f.type)}</Badge>
                <span className={cx('tabular', f.status === 'done' && 'text-muted line-through')}>{dateTime(f.dueAt)}</span>
                <span className="flex-1 text-muted">{f.note}</span>
                <span className="text-xs text-muted">{f.user.name}</span>
                {canWrite && f.status === 'pending' && <>
                  <Button size="sm" variant="secondary" onClick={() => complete.mutate(f.id)}>Done</Button>
                  <IconButton icon={Pencil} label="Edit follow-up" onClick={() => setEdit(f)} />
                  <IconButton icon={Trash2} label="Delete follow-up" onClick={async () => { if (await confirm({ title: 'Delete follow-up?', danger: true })) del.mutate(f.id); }} />
                </>}
              </li>
            );
          })}
        </ul>
      )}
      <FollowUpModal open={!!edit} followUp={edit} onClose={() => setEdit(null)} />
    </Card>
  );
}

/** The carrier answered (email, phone or text) outside reply detection: stops its sequences and logs the reply. */
function MarkRepliedButton({ carrier, size = 'sm' }) {
  const confirm = useConfirm();
  const mark = useApiMutation(() => api.post(`/api/carriers/${carrier.id}/replied`), {
    success: (d) => (d.stopped ? `Reply logged and ${d.stopped} sequence${d.stopped === 1 ? '' : 's'} stopped` : 'Reply logged'),
    invalidate: [['carrier', carrier.id], ['queue'], ['emails'], ['follow-ups']],
  });
  const onClick = async () => {
    const live = (carrier.enrollments || []).filter((e) => e.status === 'active' || e.status === 'paused').length;
    if (live && !(await confirm({
      title: `Mark ${carrier.companyName} as replied?`,
      message: `This stops ${live === 1 ? 'its running sequence' : `its ${live} running sequences`}, logs the reply and adds a "Reply from" follow-up.`,
      confirmLabel: 'Mark replied',
    }))) return;
    mark.mutate();
  };
  return <Button size={size} variant="secondary" icon={Reply} loading={mark.isPending} onClick={onClick}>Mark replied</Button>;
}

function SequencesTab({ carrier, canWrite, onEnroll }) {
  const inv = [['carrier', carrier.id], ['queue']];
  // stepIndex = the step on screen: a stale click (the scheduler or another tab already moved on) gets 409 instead of
  // acting on the next step.
  const act = useApiMutation(({ id, action, stepIndex }) => api.post(`/api/sequences/enrollments/${id}/${action}`, stepIndex != null ? { stepIndex } : undefined), {
    success: 'Updated', invalidate: inv,
  });
  const color = { active: 'green', paused: 'amber', completed: 'brand', stopped: 'gray' };
  const live = carrier.enrollments.some((e) => e.status === 'active' || e.status === 'paused');
  return (
    <Card title="Sequences" bodyClass="p-0" actions={canWrite && <div className="flex flex-wrap gap-2">{live && <MarkRepliedButton carrier={carrier} />}<Button size="sm" icon={ListOrdered} onClick={onEnroll}>Enroll</Button></div>}>
      {!carrier.enrollments.length ? <EmptyState title="Not in any sequence" /> : (
        <ul className="divide-y divide-line">
          {carrier.enrollments.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <Link to={`/app/sequences/${e.sequence.id}`} className="font-medium hover:underline">{e.sequence.name}</Link>
              <Badge color={color[e.status]}>{label(e.status)}</Badge>
              <span className="flex-1 text-muted">
                {e.status === 'active' && e.step ? `Step ${e.step.order}/${e.sequence.stepCount}: ${label(e.step.type)} · due ${dateTime(e.nextStepAt)}` : e.stopReason ? label(e.stopReason) : ''}
              </span>
              {canWrite && e.status === 'active' && <>
                {e.step?.type !== 'email' && <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: e.id, action: 'complete-step', stepIndex: e.currentStep })}>Mark step done</Button>}
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: e.id, action: 'skip-step', stepIndex: e.currentStep })}>Skip step</Button>
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: e.id, action: 'pause' })}>Pause</Button>
              </>}
              {canWrite && e.status === 'paused' && <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: e.id, action: 'resume' })}>Resume</Button>}
              {canWrite && ['active', 'paused'].includes(e.status) && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: e.id, action: 'stop' })}>Stop</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentActivity({ carrierId, compact }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['carrier', carrierId, 'activities', page, compact], queryFn: () => api.get(`/api/carriers/${carrierId}/activities`, { page, pageSize: compact ? 8 : 25 }) });
  return (
    <Card title={compact ? 'Recent activity' : 'Activity'} bodyClass="p-0">
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : !q.data.items.length ? <EmptyState title="No activity yet" /> : (
        <>
          <ul className="divide-y divide-line">
            {q.data.items.map((a) => (
              <li key={a.id} className="flex gap-3 px-4 py-2.5 text-sm">
                <span className="w-28 shrink-0 text-xs text-muted">{relative(a.createdAt)}</span>
                <span className="flex-1">{a.summary}</span>
                <span className="hidden text-xs text-muted sm:block">{a.user?.name}</span>
              </li>
            ))}
          </ul>
          {!compact && <div className="px-3"><Pagination page={q.data.page} pages={q.data.pages} total={q.data.total} onPage={setPage} /></div>}
        </>
      )}
    </Card>
  );
}
