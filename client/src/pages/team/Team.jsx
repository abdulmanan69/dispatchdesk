import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Users, UserPlus, Copy, Trash2, Crown, LogOut, Inbox, ArrowRight, PhoneCall, Truck, BadgeCheck, Package, DollarSign, UserRoundPlus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation, formData } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm, Modal } from '../../components/Modal.jsx';
import { date, relative, label, money, num } from '../../lib/format.js';
import { AREAS, AREA_HELP, AREA_LABEL } from '../../lib/teamAreas.js';
import {
  Card, PageHeader, Tabs, Button, Input, Select, Field, Switch, Badge, Avatar, Loading, ErrorState, EmptyState, QueryState, Pagination, IconButton, StatCard, cx,
} from '../../components/ui.jsx';
import Leaderboard, { MetricsTable } from '../../components/team/Leaderboard.jsx';

const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', sales: 'Sales', dispatcher: 'Dispatcher' };
const ROLE_COLOR = { owner: 'amber', manager: 'brand', sales: 'blue', dispatcher: 'green' };
const ROLE_HELP = {
  sales: 'Finds and signs carriers. Starts with the Leads & sales tools.',
  dispatcher: 'Dispatches signed carriers. Starts with the Dispatch tools.',
  manager: 'Sees the team, assigns carriers, and sets roles and tools.',
};

export default function Team() {
  const q = useQuery({ queryKey: ['team', 'mine'], queryFn: () => api.get('/api/teams/mine') });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  return q.data.team ? <TeamView data={q.data} /> : <NoTeam data={q.data} />;
}

function NoTeam({ data }) {
  const { refresh } = useAuth();
  const create = useApiMutation((body) => api.post('/api/teams', body), { success: 'Team created', invalidate: [['team']], onSuccess: refresh });
  const accept = useApiMutation((id) => api.post(`/api/teams/invitations/${id}/accept-by-id`), { success: (d) => `You joined ${d.team.name}`, invalidate: [['team']], onSuccess: refresh });
  return (
    <div className="space-y-5">
      <PageHeader title="Team" subtitle="Salespeople sign carriers, the manager hands them to dispatchers, and everything stays in one team CRM." />
      {data.invitationsForMe.length > 0 && (
        <Card title="Invitations for you" bodyClass="p-0">
          <ul className="divide-y divide-line">
            {data.invitationsForMe.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="font-medium">{i.team}</p>
                  <p className="text-xs text-muted">Invited by {i.invitedBy} as {(ROLE_LABEL[i.role] || label(i.role)).toLowerCase()} · expires {date(i.expiresAt)}</p>
                </div>
                <Button size="sm" loading={accept.isPending && accept.variables === i.id} onClick={() => accept.mutate(i.id)}>Accept</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Create a team" className="lg:col-span-1">
          {data.canCreate ? (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(formData(e.currentTarget)); }}>
              <Field label="Team name" required><Input name="name" maxLength={80} placeholder="e.g. Fleet Co Dispatch" required /></Field>
              <ul className="space-y-1.5 text-xs text-muted">
                <li>You become the owner and manage the team.</li>
                <li>Invite salespeople and dispatchers by email.</li>
                <li>Carriers sales signs wait for you to hand them to a dispatcher.</li>
              </ul>
              <Button type="submit" icon={Users} loading={create.isPending}>Create team</Button>
            </form>
          ) : <p className="text-sm text-muted">Your role cannot create teams. Ask a team owner to invite you.</p>}
        </Card>
        <div className="lg:col-span-2"><Leaderboard hasTeam={false} /></div>
      </div>
    </div>
  );
}

function TeamView({ data }) {
  const [params, setParams] = useSearchParams();
  const { team, me } = data;
  const tabs = [
    { value: 'members', label: 'Members', count: data.members.length },
    ...(me.isLead ? [{ value: 'assign', label: 'To assign', count: me.toAssign || undefined }, { value: 'overview', label: 'Overview' }] : []),
    { value: 'board', label: 'Team board' },
    { value: 'leaderboard', label: 'Leaderboard' },
    { value: 'activity', label: 'Activity' },
    { value: 'settings', label: 'Settings' },
  ];
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'members';
  const setTab = (v) => setParams(v === 'members' ? {} : { tab: v });
  return (
    <div className="space-y-5">
      <PageHeader title={team.name} subtitle={`${data.members.length} member${data.members.length === 1 ? '' : 's'}${data.seats ? ` · ${data.seats} paid seats` : ''} · you are ${(ROLE_LABEL[me.role] || label(me.role)).toLowerCase()}`} />
      {me.isLead && me.toAssign > 0 && tab !== 'assign' && (
        <button type="button" onClick={() => setTab('assign')}
          className="flex w-full items-center gap-3 rounded-xl border border-c-amber/30 bg-c-amber-soft px-4 py-3 text-left text-sm transition-ui hover:brightness-[0.98]">
          <Inbox className="size-4 shrink-0 text-c-amber" aria-hidden />
          <span className="flex-1"><span className="font-medium">{me.toAssign} signed carrier{me.toAssign === 1 ? '' : 's'}</span> waiting for a dispatcher</span>
          <span className="inline-flex items-center gap-1 font-medium text-c-amber">Assign<ArrowRight className="size-4" aria-hidden /></span>
        </button>
      )}
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'members' && <Members data={data} />}
      {tab === 'assign' && <ToAssign />}
      {tab === 'overview' && <Overview />}
      {tab === 'board' && <Board />}
      {tab === 'leaderboard' && <Leaderboard hasTeam />}
      {tab === 'activity' && <Activity />}
      {tab === 'settings' && <TeamSettings data={data} />}
    </div>
  );
}

/** The two work areas as toggle chips; owners and managers always have both. */
function AreaChips({ member, editable, onChange }) {
  if (member.role === 'owner' || member.role === 'manager') return <span className="text-xs text-muted">All tools</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {AREAS.map((a) => {
        const on = member.areas.includes(a);
        return (
          <button key={a} type="button" disabled={!editable} aria-pressed={on} title={AREA_HELP[a]}
            onClick={() => onChange(on ? member.areas.filter((x) => x !== a) : [...member.areas, a])}
            className={cx('rounded-full border px-2.5 py-0.5 text-xs transition-ui disabled:cursor-default',
              on ? 'border-brand-600/40 bg-brand-600/10 font-medium text-fg' : 'border-line text-muted',
              editable && (on ? 'hover:bg-brand-600/15' : 'hover:bg-surface-2 hover:text-fg'))}>
            {AREA_LABEL[a]}
          </button>
        );
      })}
    </div>
  );
}

function Members({ data }) {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [lastInvite, setLastInvite] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [inviteRole, setInviteRole] = useState('sales');
  const { me, team } = data;
  const inv = [['team']];
  const invite = useApiMutation((body) => api.post('/api/teams/invitations', body), {
    invalidate: inv,
    onSuccess: (d) => { setLastInvite(d); toast.success(d.emailSent ? `Invitation emailed to ${d.invitation.email}` : 'Invitation created — share the link below'); },
  });
  const revoke = useApiMutation((id) => api.del(`/api/teams/invitations/${id}`), { success: 'Invitation revoked', invalidate: inv });
  const update = useApiMutation(({ userId, ...body }) => api.patch(`/api/teams/members/${userId}`, body), { success: 'Member updated', invalidate: inv });
  const transfer = useApiMutation((userId) => api.post('/api/teams/transfer', { userId }), { success: 'Ownership transferred', invalidate: inv, onSuccess: refresh });
  const isOwner = me.role === 'owner';

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Link copied'); } catch { toast.error('Copy failed — select the link and copy it manually'); } };

  return (
    <div className="space-y-5">
      {me.canManage && (
        <Card title="Invite someone">
          <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; invite.mutate({ ...formData(f), role: inviteRole }, { onSuccess: () => f.reset() }); }}>
            <Field label="Email" required><Input name="email" type="email" required placeholder="name@example.com" /></Field>
            <Field label="Role">
              <Select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                <option value="sales">Sales</option>
                <option value="dispatcher">Dispatcher</option>
                {isOwner && <option value="manager">Manager</option>}
              </Select>
            </Field>
            <Button type="submit" icon={UserPlus} loading={invite.isPending}>Send invite</Button>
          </form>
          <p className="mt-2 text-xs text-muted">{ROLE_HELP[inviteRole]} You can change roles and tools any time.</p>
          {lastInvite && (
            <div className="mt-3 rounded-md border border-line bg-surface-2 p-3 text-sm">
              <p>{lastInvite.emailSent ? `Email sent to ${lastInvite.invitation.email}. You can also share this link:` : `Email could not be sent (${lastInvite.emailError || 'platform email not configured'}). Share this link with ${lastInvite.invitation.email}:`}</p>
              <div className="mt-2 flex gap-2">
                <Input readOnly value={lastInvite.inviteLink} onFocus={(e) => e.target.select()} aria-label="Invitation link" className="font-mono text-xs" />
                <Button variant="secondary" icon={Copy} onClick={() => copy(lastInvite.inviteLink)}>Copy</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card title="Members" bodyClass="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Tools</th>
                <th className="px-3 py-2 font-medium">Sees team data</th>
                <th className="px-3 py-2 font-medium">Manages members</th>
                <th className="px-3 py-2 font-medium">Last login</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => {
                const self = m.userId === user.id;
                const locked = m.role === 'owner';
                const canEditRole = me.isLead && !locked && !self && (isOwner || m.role !== 'manager');
                return (
                  <tr key={m.id} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={m.name} src={m.avatarUrl} size={30} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{m.name}{self && <span className="text-muted"> (you)</span>}</p>
                          <p className="truncate text-xs text-muted">{m.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {canEditRole ? (
                        <Select aria-label={`Role for ${m.name}`} value={m.role} className="h-8 w-32" onChange={(e) => update.mutate({ userId: m.userId, role: e.target.value })}>
                          <option value="sales">Sales</option>
                          <option value="dispatcher">Dispatcher</option>
                          {isOwner && <option value="manager">Manager</option>}
                        </Select>
                      ) : <Badge color={ROLE_COLOR[m.role] || 'gray'}>{locked && <Crown className="size-3" />}{ROLE_LABEL[m.role] || label(m.role)}</Badge>}
                    </td>
                    <td className="px-3 py-2.5">
                      <AreaChips member={m} editable={me.isLead && !self} onChange={(areas) => update.mutate({ userId: m.userId, areas })} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Switch checked={locked || m.canViewTeamData || team.membersSeeAll} disabled={locked || team.membersSeeAll || !me.canManage || (self && !isOwner)} onChange={(v) => update.mutate({ userId: m.userId, canViewTeamData: v })} label={<span className="sr-only">Can view team data</span>} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Switch checked={locked || m.canManageMembers} disabled={locked || !isOwner} onChange={(v) => update.mutate({ userId: m.userId, canManageMembers: v })} label={<span className="sr-only">Can manage members</span>} />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">{m.lastLoginAt ? relative(m.lastLoginAt) : 'never'}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {isOwner && !self && (
                        <Button variant="ghost" size="sm" onClick={async () => { if (await confirm({ title: `Make ${m.name} the owner?`, message: 'You will become a manager. The new owner controls billing and roles.', confirmLabel: 'Transfer ownership' })) transfer.mutate(m.userId); }}>Make owner</Button>
                      )}
                      {me.canManage && !self && !locked && (m.role !== 'manager' || isOwner) && (
                        <IconButton icon={Trash2} label={`Remove ${m.name}`} onClick={() => setRemoving(m)} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-1 border-t border-line px-4 py-2 text-xs text-muted">
          <p><span className="font-medium text-fg-2">Tools:</span> {AREA_LABEL.sales} is {AREA_HELP.sales.toLowerCase()}. {AREA_LABEL.dispatch} is {AREA_HELP.dispatch.toLowerCase()}. Everyone keeps carrier pages, calling, notes, files, follow-ups and email.</p>
          <p>Owners always see team data. {team.membersSeeAll ? 'Everyone sees all team carriers (Settings).' : 'Members see their own carriers and the ones assigned to them.'}</p>
        </div>
      </Card>

      {me.canManage && (
        <Card title="Pending invitations" bodyClass="p-0">
          {!data.invitations.length ? <EmptyState icon={UserPlus} title="No pending invitations" /> : (
            <ul className="divide-y divide-line">
              {data.invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <div>
                    <p className="font-medium">{i.email}</p>
                    <p className="text-xs text-muted">{ROLE_LABEL[i.role] || label(i.role)} · invited by {i.invitedBy} · {i.status === 'expired' ? 'expired' : `expires ${date(i.expiresAt)}`}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)}>Revoke</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {removing && <RemoveMember member={removing} data={data} onClose={() => setRemoving(null)} />}
    </div>
  );
}

/** Remove a member; when the team keeps work, pick who receives the carriers they added while in the team. */
function RemoveMember({ member, data, onClose }) {
  const { team } = data;
  const others = data.members.filter((x) => x.userId !== member.userId);
  const [to, setTo] = useState(team.ownerId);
  const remove = useApiMutation(() => api.del(`/api/teams/members/${member.userId}${team.keepWorkOnLeave ? `?transferTo=${encodeURIComponent(to)}` : ''}`), {
    invalidate: [['team'], ['carriers']],
    success: (d) => (d.kept?.carriers ? `${member.name} removed. ${d.kept.carriers} carrier${d.kept.carriers === 1 ? '' : 's'} moved to ${others.find((x) => x.userId === d.receiver)?.name || 'the team'}.` : `${member.name} removed`),
    onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} title={`Remove ${member.name}?`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-fg-2">They lose access to the team and its data right away.</p>
        {team.keepWorkOnLeave ? (
          <>
            <Field label="Give the carriers they added to">
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                {others.map((x) => <option key={x.userId} value={x.userId}>{x.name}{x.userId === team.ownerId ? ' (owner)' : ''}</option>)}
              </Select>
            </Field>
            <p className="text-xs text-muted">Carriers they added while in the team move with their loads, documents, deals and open follow-ups. Carriers they had before joining, their mailbox and their sequences stay with them.</p>
          </>
        ) : <p className="text-xs text-muted">Their carriers stay with them (Settings → Work stays with the team is off).</p>}
      </div>
    </Modal>
  );
}

/** Team leads: signed carriers waiting for a dispatcher, and the ones handed over lately. */
function ToAssign() {
  const q = useQuery({ queryKey: ['team', 'handoffs'], queryFn: () => api.get('/api/teams/handoffs') });
  const [choice, setChoice] = useState({});
  const assign = useApiMutation(({ carrierId, userId }) => api.post(`/api/teams/handoffs/${carrierId}/assign`, { userId }), {
    invalidate: [['team']], success: 'Carrier assigned',
  });
  return (
    <QueryState query={q}>
      {(d) => (
        <div className="space-y-5">
          <Card title="Waiting for a dispatcher" bodyClass="p-0"
            actions={<span className="text-xs text-muted">{d.handoffMode === 'round_robin' ? 'New ones go to dispatchers in turn' : 'You pick a dispatcher for each one'}</span>}>
            {!d.pending.length ? (
              <EmptyState icon={Inbox} title="Nothing to assign">Carriers your salespeople sign show up here for you to hand to a dispatcher.</EmptyState>
            ) : !d.dispatchers.length ? (
              <p className="px-5 py-4 text-sm text-fg-2">Nobody in the team has the Dispatch tools yet. Invite a dispatcher, or turn on Dispatch for a member in Members.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.pending.map((c) => {
                  const pick = choice[c.id] || d.dispatchers[0]?.userId || '';
                  return (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <Link to={`/app/carriers/${c.id}`} className="font-medium hover:underline">{c.companyName}</Link>
                        <p className="text-xs text-muted">
                          {[c.dotNumber && `DOT ${c.dotNumber}`, c.mcNumber && `MC ${c.mcNumber}`, [c.city, c.state].filter(Boolean).join(', '), c.equipment, c.fleetSize ? `${c.fleetSize} truck${c.fleetSize === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}
                        </p>
                        <p className="text-xs text-muted">Signed by {c.soldBy?.name || 'a team member'}{c.signedAt ? ` ${relative(c.signedAt)}` : ''}{c.dispatchFeePercent != null ? ` · ${c.dispatchFeePercent}% fee` : ''}</p>
                      </div>
                      <Select aria-label={`Dispatcher for ${c.companyName}`} value={pick} className="h-9 w-48" onChange={(e) => setChoice({ ...choice, [c.id]: e.target.value })}>
                        {d.dispatchers.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}
                      </Select>
                      <Button size="sm" icon={UserRoundPlus} loading={assign.isPending && assign.variables?.carrierId === c.id} onClick={() => assign.mutate({ carrierId: c.id, userId: pick })}>Assign</Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Handed over in the last 30 days" bodyClass="p-0">
            {!d.assigned.length ? <EmptyState title="None yet" /> : (
              <ul className="divide-y divide-line text-sm">
                {d.assigned.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                    <Link to={`/app/carriers/${c.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{c.companyName}</Link>
                    <span className="text-xs text-muted">{c.soldBy?.name || '—'} <ArrowRight className="inline size-3" aria-label="to" /> {c.assignedTo?.name || '—'}</span>
                    <span className="w-24 text-right text-xs text-muted">{relative(c.handoffAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </QueryState>
  );
}

/** Team leads: each member's sales and dispatch numbers for the week or month. */
function Overview() {
  const [range, setRange] = useState('week');
  const q = useQuery({ queryKey: ['team', 'overview', range], queryFn: () => api.get('/api/teams/overview', { range }) });
  return (
    <QueryState query={q}>
      {(d) => (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-fg-2">Since {date(d.since)}</p>
            <Tabs value={range} onChange={setRange} tabs={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'Last 30 days' }]} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Calls" value={num(d.totals.dials)} icon={PhoneCall} />
            <StatCard label="Carriers added" value={num(d.totals.added)} icon={Truck} />
            <StatCard label="Carriers signed" value={num(d.totals.signed)} icon={BadgeCheck} tone="green" />
            <StatCard label="Waiting to assign" value={num(d.toAssign)} icon={Inbox} tone={d.toAssign ? 'amber' : 'muted'} />
            <StatCard label="Loads booked" value={num(d.totals.loads)} icon={Package} />
            <StatCard label="Delivered revenue" value={money(d.totals.revenueCents, { digits: 0 })} icon={DollarSign} tone="green" />
          </div>
          <Card title="By member" bodyClass="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-line text-[12px] text-muted">
                    <th className="px-4 py-2 text-left font-medium">Member</th>
                    <th className="px-3 py-2 text-right font-medium">Calls</th>
                    <th className="px-3 py-2 text-right font-medium">Added</th>
                    <th className="px-3 py-2 text-right font-medium">In touch</th>
                    <th className="px-3 py-2 text-right font-medium">Signed</th>
                    <th className="border-l border-line px-3 py-2 text-right font-medium">Carriers dispatched</th>
                    <th className="px-3 py-2 text-right font-medium">Loads</th>
                    <th className="px-3 py-2 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.userId} className="border-b border-line/70 last:border-0">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={r.name} src={r.avatarUrl} size={28} />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{r.name}</p>
                            <p className="text-xs text-muted">{ROLE_LABEL[r.role] || label(r.role)} · {r.lastLoginAt ? `seen ${relative(r.lastLoginAt)}` : 'never signed in'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular">{num(r.sales.dials)}</td>
                      <td className="px-3 py-2.5 text-right tabular">{num(r.sales.added)}</td>
                      <td className="px-3 py-2.5 text-right tabular">{num(r.sales.inTouch)}</td>
                      <td className="px-3 py-2.5 text-right tabular font-medium">{num(r.sales.signed)}</td>
                      <td className="border-l border-line px-3 py-2.5 text-right tabular">{num(r.dispatch.carriers)}</td>
                      <td className="px-3 py-2.5 text-right tabular">{num(r.dispatch.loads)}</td>
                      <td className="px-3 py-2.5 text-right tabular">{money(r.dispatch.revenueCents, { digits: 0 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-line px-4 py-2 text-xs text-muted">Signed counts carriers each person signed in the period. Carriers dispatched counts active customers assigned to them now. Revenue is delivered, invoiced and paid loads they booked in the period.</p>
          </Card>
        </div>
      )}
    </QueryState>
  );
}

function Board() {
  const q = useQuery({ queryKey: ['team', 'board'], queryFn: () => api.get('/api/teams/board') });
  return (
    <Card title="This week" actions={q.data && <span className="text-xs text-muted">since {date(q.data.since)}</span>} bodyClass="p-0">
      <QueryState query={q}>{(d) => <MetricsTable rows={d.rows} totals={d.totals} />}</QueryState>
    </Card>
  );
}

function Activity() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['team', 'activity', page], queryFn: () => api.get('/api/teams/activity', { page, pageSize: 25 }) });
  return (
    <Card title="Team activity" bodyClass="p-0" actions={q.data?.scope === 'mine' && <span className="text-xs text-muted">Showing your own activity only</span>}>
      <QueryState query={q} isEmpty={(d) => !d.items.length} empty={<EmptyState title="No activity yet" />}>
        {(d) => (
          <>
            <ul className="divide-y divide-line">
              {d.items.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <Badge className="mt-0.5 w-24 justify-center">{label(a.type)}</Badge>
                  <div className="min-w-0 flex-1">
                    <p>{a.summary}</p>
                    <p className="text-xs text-muted">{a.user.name} · {relative(a.createdAt)}{a.carrier && <> · <Link to={`/app/carriers/${a.carrier.id}`} className="hover:underline">{a.carrier.companyName}</Link></>}</p>
                  </div>
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
          </>
        )}
      </QueryState>
    </Card>
  );
}

function TeamSettings({ data }) {
  const { team, me } = data;
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [form, setForm] = useState({
    name: team.name, leaderboardEnabled: team.leaderboardEnabled, managersSeeAll: team.managersSeeAll,
    membersSeeAll: team.membersSeeAll, handoffMode: team.handoffMode, keepWorkOnLeave: team.keepWorkOnLeave,
  });
  const isOwner = me.role === 'owner';
  const save = useApiMutation((body) => api.patch('/api/teams/mine', body), { success: 'Team settings saved', invalidate: [['team']], onSuccess: refresh });
  const leave = useApiMutation(() => api.del('/api/teams/members/me'), { success: 'You left the team', invalidate: [['team']], onSuccess: async () => { await refresh(); navigate('/app/team'); } });
  const del = useApiMutation(() => api.del('/api/teams/mine', { confirm: confirmName }), { success: 'Team deleted', invalidate: [['team']], onSuccess: async () => { setDeleteOpen(false); await refresh(); } });

  const submit = (e) => {
    e.preventDefault();
    const body = { name: form.name, leaderboardEnabled: form.leaderboardEnabled, handoffMode: form.handoffMode };
    if (isOwner) Object.assign(body, { managersSeeAll: form.managersSeeAll, membersSeeAll: form.membersSeeAll, keepWorkOnLeave: form.keepWorkOnLeave });
    save.mutate(body);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Team settings">
        {me.isLead ? (
          <form className="space-y-5" onSubmit={submit}>
            <Field label="Team name" required><Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
            <Field label="Carriers sales signs go to" hint={form.handoffMode === 'round_robin' ? 'Each signed carrier goes to the next dispatcher in turn, and they get a notice.' : 'Each signed carrier waits in To assign until you pick a dispatcher.'}>
              <Select value={form.handoffMode} onChange={(e) => setForm({ ...form, handoffMode: e.target.value })}>
                <option value="manager">The dispatcher I pick (To assign)</option>
                <option value="round_robin">The next dispatcher in turn</option>
              </Select>
            </Field>
            <div className="space-y-3">
              <p className="text-[13px] font-medium">Who sees what {!isOwner && <span className="font-normal text-muted">(the owner decides)</span>}</p>
              <Switch checked={form.membersSeeAll} disabled={!isOwner} onChange={(v) => setForm({ ...form, membersSeeAll: v })} label="Everyone sees all team carriers" />
              <Switch checked={form.managersSeeAll} disabled={!isOwner} onChange={(v) => setForm({ ...form, managersSeeAll: v })} label="Managers see every member's carriers" />
              <Switch checked={form.leaderboardEnabled} onChange={(v) => setForm({ ...form, leaderboardEnabled: v })} label="Show team board and leaderboard to all members" />
            </div>
            <div className="space-y-1">
              <Switch checked={form.keepWorkOnLeave} disabled={!isOwner} onChange={(v) => setForm({ ...form, keepWorkOnLeave: v })} label="Work stays with the team when someone leaves" />
              <p className="pl-[2.875rem] text-xs text-muted">Carriers a member added while in the team, with their loads, documents and deals, go to the owner or a member you pick. Their mailbox and anything from before they joined stay with them.</p>
            </div>
            <Button type="submit" loading={save.isPending}>Save settings</Button>
          </form>
        ) : <p className="text-sm text-muted">Only the owner or a manager can change team settings.</p>}
      </Card>
      <Card title={isOwner ? 'Danger zone' : 'Leave team'}>
        {isOwner ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted">To leave, first make another member the owner (Members tab). Deleting the team removes memberships and invitations; each member keeps the carriers they own.</p>
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>Delete team</Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted">{team.keepWorkOnLeave
              ? 'Carriers you added while in the team stay with the team (the owner gets them). Carriers you had before joining, your mailbox and your settings stay with you.'
              : 'Your carriers and pipeline stay with your account after you leave.'}</p>
            <Button variant="secondary" icon={LogOut} loading={leave.isPending} onClick={async () => {
              if (await confirm({ title: `Leave ${team.name}?`, message: team.keepWorkOnLeave ? 'You lose access to the team, and the carriers you added while in it stay with the team.' : 'You will lose access to the team board and shared data.', confirmLabel: 'Leave team', danger: true })) leave.mutate();
            }}>Leave team</Button>
          </div>
        )}
      </Card>
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete team" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" disabled={confirmName !== team.name} loading={del.isPending} onClick={() => del.mutate()}>Delete team</Button></>}>
        <p className="text-sm text-muted">Type <span className="font-medium text-fg">{team.name}</span> to confirm. Cancel any team subscription in Billing first.</p>
        <Input className="mt-3" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} aria-label="Team name confirmation" />
      </Modal>
    </div>
  );
}
