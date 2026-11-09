import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Users, UserPlus, Copy, Trash2, Crown, LogOut } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation, formData } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm, Modal } from '../../components/Modal.jsx';
import { date, relative, label } from '../../lib/format.js';
import {
  Card, PageHeader, Tabs, Button, Input, Select, Field, Switch, Badge, Avatar, Loading, ErrorState, EmptyState, QueryState, Pagination, IconButton,
} from '../../components/ui.jsx';
import Leaderboard, { MetricsTable } from '../../components/team/Leaderboard.jsx';

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
      <PageHeader title="Team" subtitle="Work with other dispatchers — everyone keeps their own pipeline, the board shows the team's week." />
      {data.invitationsForMe.length > 0 && (
        <Card title="Invitations for you" bodyClass="p-0">
          <ul className="divide-y divide-line">
            {data.invitationsForMe.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="font-medium">{i.team}</p>
                  <p className="text-xs text-muted">Invited by {i.invitedBy} as {label(i.role).toLowerCase()} · expires {date(i.expiresAt)}</p>
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
              <p className="text-xs text-muted">You become the owner. Invite dispatchers by email next. Teams plan billing is per user.</p>
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
  const [tab, setTab] = useState('members');
  const { team, me } = data;
  return (
    <div className="space-y-5">
      <PageHeader title={team.name} subtitle={`${data.members.length} member${data.members.length === 1 ? '' : 's'}${data.seats ? ` · ${data.seats} paid seats` : ''} · you are ${label(me.role).toLowerCase()}`} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'members', label: 'Members', count: data.members.length },
        { value: 'board', label: 'Team board' },
        { value: 'leaderboard', label: 'Leaderboard' },
        { value: 'activity', label: 'Activity' },
        { value: 'settings', label: 'Settings' },
      ]} />
      {tab === 'members' && <Members data={data} />}
      {tab === 'board' && <Board />}
      {tab === 'leaderboard' && <Leaderboard hasTeam />}
      {tab === 'activity' && <Activity />}
      {tab === 'settings' && <TeamSettings data={data} />}
    </div>
  );
}

function Members({ data }) {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [lastInvite, setLastInvite] = useState(null);
  const { me } = data;
  const inv = [['team']];
  const invite = useApiMutation((body) => api.post('/api/teams/invitations', body), {
    invalidate: inv,
    onSuccess: (d) => { setLastInvite(d); toast.success(d.emailSent ? `Invitation emailed to ${d.invitation.email}` : 'Invitation created — share the link below'); },
  });
  const revoke = useApiMutation((id) => api.del(`/api/teams/invitations/${id}`), { success: 'Invitation revoked', invalidate: inv });
  const update = useApiMutation(({ userId, ...body }) => api.patch(`/api/teams/members/${userId}`, body), { success: 'Member updated', invalidate: inv });
  const remove = useApiMutation((userId) => api.del(`/api/teams/members/${userId}`), { success: 'Member removed', invalidate: inv });
  const transfer = useApiMutation((userId) => api.post('/api/teams/transfer', { userId }), { success: 'Ownership transferred', invalidate: inv, onSuccess: refresh });
  const isOwner = me.role === 'owner';

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Link copied'); } catch { toast.error('Copy failed — select the link and copy it manually'); } };

  return (
    <div className="space-y-5">
      {me.canManage && (
        <Card title="Invite a dispatcher">
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; invite.mutate(formData(f), { onSuccess: () => f.reset() }); }}>
            <Field label="Email" className="flex-1" required><Input name="email" type="email" required placeholder="dispatcher@example.com" /></Field>
            <Field label="Role">
              <Select name="role" defaultValue="dispatcher">
                <option value="dispatcher">Dispatcher</option>
                {isOwner && <option value="manager">Manager</option>}
              </Select>
            </Field>
            <Button type="submit" icon={UserPlus} loading={invite.isPending}>Send invite</Button>
          </form>
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
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Role</th>
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
                      {isOwner && !locked ? (
                        <Select aria-label={`Role for ${m.name}`} value={m.role} className="h-8 w-32" onChange={(e) => update.mutate({ userId: m.userId, role: e.target.value })}>
                          <option value="manager">Manager</option>
                          <option value="dispatcher">Dispatcher</option>
                        </Select>
                      ) : <Badge color={locked ? 'amber' : m.role === 'manager' ? 'brand' : 'gray'}>{locked && <Crown className="size-3" />}{label(m.role)}</Badge>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Switch checked={locked || m.canViewTeamData} disabled={locked || !me.canManage || (self && !isOwner)} onChange={(v) => update.mutate({ userId: m.userId, canViewTeamData: v })} label={<span className="sr-only">Can view team data</span>} />
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
                        <IconButton icon={Trash2} label={`Remove ${m.name}`} onClick={async () => { if (await confirm({ title: `Remove ${m.name}?`, message: 'They lose access to team data. Their own pipeline stays with them.', confirmLabel: 'Remove', danger: true })) remove.mutate(m.userId); }} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-muted">Owners always see team data. Managers see it when the owner allows it in Settings, or when switched on here.</p>
      </Card>

      {me.canManage && (
        <Card title="Pending invitations" bodyClass="p-0">
          {!data.invitations.length ? <EmptyState icon={UserPlus} title="No pending invitations" /> : (
            <ul className="divide-y divide-line">
              {data.invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <div>
                    <p className="font-medium">{i.email}</p>
                    <p className="text-xs text-muted">{label(i.role)} · invited by {i.invitedBy} · {i.status === 'expired' ? 'expired' : `expires ${date(i.expiresAt)}`}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)}>Revoke</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
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
  const [form, setForm] = useState({ name: team.name, leaderboardEnabled: team.leaderboardEnabled, managersSeeAll: team.managersSeeAll });
  const isLead = me.role === 'owner' || me.role === 'manager';
  const save = useApiMutation((body) => api.patch('/api/teams/mine', body), { success: 'Team settings saved', invalidate: [['team']], onSuccess: refresh });
  const leave = useApiMutation(() => api.del('/api/teams/members/me'), { success: 'You left the team', invalidate: [['team']], onSuccess: async () => { await refresh(); navigate('/app/team'); } });
  const del = useApiMutation(() => api.del('/api/teams/mine', { confirm: confirmName }), { success: 'Team deleted', invalidate: [['team']], onSuccess: async () => { setDeleteOpen(false); await refresh(); } });

  const submit = (e) => {
    e.preventDefault();
    const body = { name: form.name, leaderboardEnabled: form.leaderboardEnabled };
    if (me.role === 'owner') body.managersSeeAll = form.managersSeeAll;
    save.mutate(body);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Team settings">
        {isLead ? (
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Team name" required><Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
            <Switch checked={form.leaderboardEnabled} onChange={(v) => setForm({ ...form, leaderboardEnabled: v })} label="Show team board and leaderboard to all members" />
            <Switch checked={form.managersSeeAll} disabled={me.role !== 'owner'} onChange={(v) => setForm({ ...form, managersSeeAll: v })} label="Managers can see every member's pipeline" />
            <Button type="submit" loading={save.isPending}>Save settings</Button>
          </form>
        ) : <p className="text-sm text-muted">Only the owner or a manager can change team settings.</p>}
      </Card>
      <Card title={me.role === 'owner' ? 'Danger zone' : 'Leave team'}>
        {me.role === 'owner' ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted">To leave, first make another member the owner (Members tab). Deleting the team removes memberships and invitations; each member keeps their own carriers and data.</p>
            <Button variant="danger" icon={Trash2} onClick={() => setDeleteOpen(true)}>Delete team</Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-muted">Your carriers and pipeline stay with your account after you leave.</p>
            <Button variant="secondary" icon={LogOut} loading={leave.isPending} onClick={async () => { if (await confirm({ title: `Leave ${team.name}?`, message: 'You will lose access to the team board and shared data.', confirmLabel: 'Leave team', danger: true })) leave.mutate(); }}>Leave team</Button>
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
