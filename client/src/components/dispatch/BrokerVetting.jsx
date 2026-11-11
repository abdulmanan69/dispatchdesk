import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, ShieldQuestion, RefreshCw, Phone, Ban, Info } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, phoneFmt } from '../../lib/format.js';
import { Badge, Button, Card, Field, Input, Switch, cx } from '../ui.jsx';

/**
 * Broker vetting from FMCSA public data (census and the licensing dataset; QCMobile when configured and reachable). Every fact names its source
 * and date. Flags are levels of attention, never a verdict. The "Call back" button only opens the phone app.
 */
const LEVEL = {
  red: { color: 'red', icon: ShieldAlert, label: 'Needs attention' },
  amber: { color: 'amber', icon: ShieldAlert, label: 'Review before booking' },
  info: { color: 'blue', icon: ShieldCheck, label: 'Notes only' },
  none: { color: 'green', icon: ShieldCheck, label: 'No flags found' },
};
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : null);
const authority = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : null);

export function LevelBadge({ level, checked = true }) {
  if (!checked) return <Badge color="gray"><ShieldQuestion className="size-3" aria-hidden />Not checked</Badge>;
  const l = LEVEL[level || 'none'];
  return <Badge color={l.color}><l.icon className="size-3" aria-hidden />{l.label}</Badge>;
}

export function FlagList({ flags = [] }) {
  if (!flags.length) return null;
  const tone = { red: 'border-c-red/30 bg-c-red-soft', amber: 'border-c-amber/30 bg-c-amber-soft', info: 'border-c-blue/30 bg-c-blue-soft' };
  return (
    <ul className="space-y-1.5">
      {flags.map((f, i) => (
        <li key={`${f.code}-${i}`} className={cx('rounded-md border px-2.5 py-1.5 text-[13px] text-fg', tone[f.level] || tone.info)}>
          <span>{f.message}</span>
          <span className="ml-1 text-xs text-muted">{[f.source === 'team' ? `Your team${f.by ? ` · ${f.by}` : ''}` : f.source, f.asOf && date(f.asOf)].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}

function Fact({ k, children, source }) {
  if (children == null || children === '') return null;
  return (
    <div className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:justify-between sm:gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words sm:text-right">{children}{source && <span className="block text-xs text-muted">{source}</span>}</dd>
    </div>
  );
}

/** Facts from a snapshot with their sources. */
export function VettingFacts({ snapshot, qcConfigured }) {
  if (!snapshot) return null;
  if (!snapshot.found) return <p className="text-sm text-muted">No FMCSA census record was found for this number. Check the MC or USDOT number with the broker; this alone does not mean the broker has no authority.</p>;
  const census = `${snapshot.censusUnavailable ? 'FMCSA licensing' : 'FMCSA census'} · ${date(snapshot.checkedAt)}`;
  const qc = `${snapshot.qc ? 'FMCSA QCMobile' : 'FMCSA licensing'} · ${date((snapshot.qc ? snapshot.qcAsOf : snapshot.licensingAsOf) || snapshot.checkedAt)}`;
  const addr = snapshot.address ? [snapshot.address.street, snapshot.address.city, snapshot.address.state, snapshot.address.zip].filter(Boolean).join(', ') : null;
  return (
    <dl className="divide-y divide-line">
      {snapshot.censusUnavailable && <p className="py-2 text-xs text-muted">The FMCSA census is busy right now, so this shows the licensing record only. It is checked again in a few minutes.</p>}
      <Fact k="Legal name" source={census}>{[snapshot.legalName, snapshot.dbaName && `DBA ${snapshot.dbaName}`].filter(Boolean).join(' · ')}</Fact>
      <Fact k="USDOT / MC" source={census}>{[snapshot.dot && `USDOT ${snapshot.dot}`, snapshot.mc && `MC ${snapshot.mc}`].filter(Boolean).join(' · ')}</Fact>
      <Fact k="USDOT status" source={census}>{authority(snapshot.usdotStatus)}</Fact>
      <Fact k="Registered as a broker" source={census}>{yesNo(snapshot.registeredBroker)}</Fact>
      {snapshot.qc || snapshot.licensing ? (
        <>
          <Fact k="Broker authority" source={qc}>{authority(snapshot.brokerAuthority)}{snapshot.brokerRevocationPending ? ' · revocation pending' : ''}</Fact>
          <Fact k="Bond (BMC-84/85) on file" source={qc}>{snapshot.bondRequired === false && snapshot.bondOnFile === false ? 'Not required' : yesNo(snapshot.bondOnFile)}</Fact>
          {snapshot.qc && <Fact k="Allowed to operate" source={qc}>{yesNo(snapshot.allowedToOperate)}</Fact>}
          {snapshot.qc && <Fact k="Out-of-service order" source={qc}>{snapshot.oosDate ? date(snapshot.oosDate) : 'None'}</Fact>}
        </>
      ) : (
        <Fact k="Broker authority and bond">{qcConfigured ? 'Not available for this record' : 'No FMCSA licensing record was found for this number'}</Fact>
      )}
      <Fact k="Registered since" source={census}>{snapshot.addedAt ? date(snapshot.addedAt) : null}</Fact>
      <Fact k="FMCSA phone" source={census}>{snapshot.phones?.length ? snapshot.phones.map(phoneFmt).join(', ') : null}</Fact>
      <Fact k="FMCSA email" source={census}>{snapshot.email}</Fact>
      <Fact k="FMCSA address" source={census}>{addr}</Fact>
    </dl>
  );
}

export function CallBack({ phones = [] }) {
  if (!phones.length) return null;
  return (
    <Button size="sm" variant="secondary" icon={Phone} href={`tel:${phones[0]}`}>
      Call back on {phoneFmt(phones[0])}
    </Button>
  );
}

/** Full card on the broker page: check, flags, team "do not use" flag and the nightly watch switch. */
export default function BrokerVettingCard({ broker, vetting }) {
  const qc = useQueryClient();
  const inv = [['broker', broker.id], ['brokers']];
  const verify = useApiMutation(() => api.post(`/api/brokers/${broker.id}/verify`, {}), { success: 'FMCSA check updated', invalidate: inv });
  const watch = useApiMutation((on) => api.patch(`/api/brokers/${broker.id}`, { watch: on }), { success: (d) => (d.broker.watch ? 'Watching this broker for FMCSA changes' : 'Stopped watching'), invalidate: inv });
  const flag = useApiMutation((body) => api.patch(`/api/brokers/${broker.id}/flag`, body), { success: (d) => (d.vetting.teamFlag ? 'Marked do not use' : 'Flag removed'), invalidate: inv, onSuccess: () => setReason('') });
  const [reason, setReason] = useState('');
  const canCheck = !!(broker.mcNumber || broker.dotNumber);
  const autoRan = useRef(false);
  // A broker with a number that was never checked is checked once, when its page opens.
  useEffect(() => {
    if (canCheck && !vetting.checkedAt && !autoRan.current) {
      autoRan.current = true;
      api.post(`/api/brokers/${broker.id}/verify`, {}).then(() => qc.invalidateQueries({ queryKey: ['broker', broker.id] })).catch(() => {});
    }
  }, [broker.id, canCheck, vetting.checkedAt, qc]);
  const team = vetting.teamFlag;
  const fmcsaFlags = vetting.flags || [];

  return (
    <Card title={<span className="inline-flex items-center gap-2 text-sm font-medium">FMCSA check <LevelBadge level={vetting.level} checked={!!vetting.checkedAt} /></span>}
      actions={canCheck && <Button size="sm" variant="secondary" icon={RefreshCw} loading={verify.isPending} onClick={() => verify.mutate()}>Check again</Button>}>
      <div className="space-y-4">
        {!canCheck ? (
          <p className="flex items-start gap-2 text-sm text-muted"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />Add the broker’s MC or USDOT number (Edit) to check its FMCSA registration.</p>
        ) : !vetting.checkedAt ? (
          <p className="text-sm text-muted">Checking FMCSA…</p>
        ) : (
          <>
            <FlagList flags={fmcsaFlags} />
            <VettingFacts snapshot={vetting.snapshot} qcConfigured={vetting.qcConfigured} />
            <div className="flex flex-wrap items-center gap-2">
              <CallBack phones={vetting.snapshot?.phones} />
              <span className="text-xs text-muted">Checked {date(vetting.checkedAt)}. Flags come only from public FMCSA data and the contacts you saved.</span>
            </div>
          </>
        )}
        <div className="space-y-2 border-t border-line pt-3">
          <Switch checked={!!vetting.watch} disabled={watch.isPending || !canCheck} onChange={(on) => watch.mutate(on)} label="Watch for FMCSA changes (checked about daily)" />
          {team ? (
            <div className="rounded-md border border-c-red/30 bg-c-red-soft px-3 py-2 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-c-red"><Ban className="size-4" aria-hidden />Your team marked this broker do not use</p>
              <p className="mt-0.5">{team.message}</p>
              <p className="text-xs text-muted">{[team.by, team.asOf && date(team.asOf)].filter(Boolean).join(' · ')} · visible only to your team</p>
              <Button size="sm" variant="secondary" className="mt-2" loading={flag.isPending} onClick={() => flag.mutate({ doNotUse: false })}>Remove flag</Button>
            </div>
          ) : (
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); flag.mutate({ doNotUse: true, reason: reason.trim() || null }); }}>
              <Field label="Private team flag" hint="Only people in your workspace see it." className="min-w-0 flex-1">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. late payment on two loads" maxLength={500} />
              </Field>
              <Button type="submit" size="md" variant="secondary" icon={Ban} loading={flag.isPending}>Mark do not use</Button>
            </form>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Compact vetting for the rate-con flow: looks up the MC from the rate con (cached per MC for 10 minutes in the
 * page) and compares the rate con's phone and email with FMCSA-listed and saved contacts.
 */
export function RateConVetting({ mc, phone, email, brokerId, initial, className }) {
  const pending = !initial || initial.pending;
  const q = useQuery({
    queryKey: ['broker-verify', mc, phone || '', email || '', brokerId || ''],
    queryFn: ({ signal }) => api.get('/api/brokers/verify', { mc, phone, email, brokerId }, { signal }),
    enabled: !!mc && pending,
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (!mc) return null;
  const v = pending ? q.data?.vetting : initial;
  return (
    <div className={cx('rounded-lg border border-line p-3', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Broker check · MC {mc}</span>
        {v ? <LevelBadge level={v.level} /> : q.isError ? <Badge color="gray">FMCSA unavailable</Badge> : <Badge color="gray">Checking…</Badge>}
      </div>
      {q.isError && <p className="text-xs text-muted">{q.error.message} The load can still be saved; check the broker later from its page.</p>}
      {v?.snapshot && (
        <div className="space-y-2">
          {v.snapshot.found
            ? <p className="text-xs text-muted">{v.snapshot.legalName}{v.snapshot.dot ? ` · USDOT ${v.snapshot.dot}` : ''} · FMCSA census {date(v.snapshot.checkedAt)}</p>
            : null}
          <FlagList flags={v.flags} />
          {!v.flags?.length && v.snapshot.found && <p className="text-xs text-muted">No flags from FMCSA data or the rate con contact block.</p>}
          <CallBack phones={v.snapshot.phones} />
        </div>
      )}
    </div>
  );
}
