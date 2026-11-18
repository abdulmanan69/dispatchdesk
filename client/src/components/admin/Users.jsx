import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Trash2, Gift, Mail, MailCheck, KeyRound, Ban, UserCheck, BadgePlus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import GrantPlanModal from './GrantPlanModal.jsx';
import GiftPlanModal from './GiftPlanModal.jsx';
import EmailUsersModal from './EmailUsersModal.jsx';
import { date, relative } from '../../lib/format.js';
import { Card, Input, Select, DataTable, Pagination, QueryState, Badge, IconButton, Button } from '../ui.jsx';

export default function AdminUsers() {
  const { user: me, can } = useAuth();
  const confirm = useConfirm();
  const [filters, setFilters] = useState({ q: '', role: '', status: '' });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.get('/api/admin/roles') });
  const q = useQuery({ queryKey: ['admin', 'users', filters, page], queryFn: () => api.get('/api/admin/users', { ...filters, page, pageSize: 25 }) });
  const inv = [['admin', 'users']];
  const update = useApiMutation(({ id, ...body }) => api.patch(`/api/admin/users/${id}`, body), { success: 'User updated', invalidate: inv });
  const remove = useApiMutation((id) => api.del(`/api/admin/users/${id}`), { success: 'User deleted', invalidate: inv });
  const [temp, setTemp] = useState(null); // { name, password }
  const [grantFor, setGrantFor] = useState(null);
  // Selected users across pages (id -> { id, name, email }) for "Gift a plan".
  const [picked, setPicked] = useState(() => new Map());
  const [gifting, setGifting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const onSelect = (rows) => (ids) => setPicked((prev) => {
    const next = new Map(prev);
    for (const u of rows) {
      if (ids.has(u.id)) next.set(u.id, { id: u.id, name: u.name, email: u.email });
      else next.delete(u.id);
    }
    return next;
  });
  const resetPw = useApiMutation(({ id }) => api.post(`/api/admin/users/${id}/temp-password`), { onSuccess: (d, v) => setTemp({ name: v.name, password: d.password }) });
  const canAssignAdmin = can('admin.roles');
  const isAdminRole = (k) => k === 'admin' || k === 'super_admin';

  return (
    <Card bodyClass="p-0">
      <form className="flex flex-wrap gap-2 border-b border-line p-3" onSubmit={(e) => { e.preventDefault(); setPage(1); setFilters({ ...filters, q: search }); }}>
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" className="pl-8" aria-label="Search users" />
        </div>
        <Select aria-label="Role filter" value={filters.role} onChange={(e) => { setPage(1); setFilters({ ...filters, role: e.target.value }); }} className="w-40">
          <option value="">All roles</option>
          {roles.data?.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </Select>
        <Select aria-label="Status filter" value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }} className="w-36">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </Select>
        <Button type="submit" variant="secondary">Search</Button>
        {picked.size > 0 && (
          <span className="ml-auto inline-flex items-center gap-2">
            <span className="text-xs text-muted">{picked.size} selected</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(new Map())}>Clear</Button>
            <Button type="button" variant="secondary" icon={Mail} onClick={() => setEmailing(true)}>Email</Button>
            <Button type="button" icon={Gift} onClick={() => setGifting(true)}>Gift a plan</Button>
          </span>
        )}
      </form>
      <QueryState query={q}>
        {(d) => (
          <>
            <DataTable rows={d.items} selected={new Set(picked.keys())} onSelect={onSelect(d.items)} columns={[
              { key: 'name', header: 'User', render: (u) => (<div><p className="font-medium">{u.name}</p><p className="text-xs text-muted">{u.email}{!u.emailVerified && ' · unverified'}</p></div>) },
              { key: 'role', header: 'Role', render: (u) => {
                const locked = u.id === me.id || (!canAssignAdmin && isAdminRole(u.role));
                return locked ? <Badge color={isAdminRole(u.role) ? 'violet' : 'gray'}>{u.roleName}</Badge> : (
                  <Select aria-label={`Role for ${u.name}`} value={u.role} className="h-8 w-40" onChange={async (e) => {
                    const role = e.target.value;
                    if (isAdminRole(role) && !(await confirm({ title: 'Grant administrator access?', message: `${u.name} will be able to manage users and platform settings.`, confirmLabel: 'Grant access' }))) return;
                    update.mutate({ id: u.id, role });
                  }}>
                    {roles.data?.roles.filter((r) => canAssignAdmin || !isAdminRole(r.key)).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                  </Select>
                );
              } },
              { key: 'team', header: 'Team', render: (u) => u.team || '—' },
              { key: 'carriers', header: 'Carriers', className: 'text-right tabular' },
              { key: 'status', header: 'Status', render: (u) => <Badge color={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge> },
              { key: 'activity', header: 'Activity', render: (u) => (
                <div className="whitespace-nowrap text-xs">
                  <p>Last login {u.lastLoginAt ? relative(u.lastLoginAt) : 'never'}</p>
                  <p className="text-muted">Joined {date(u.createdAt)}</p>
                </div>
              ) },
              { key: 'actions', header: '', className: 'text-right whitespace-nowrap', render: (u) => u.id === me.id ? null : (
                <div className="inline-flex items-center gap-0.5">
                  {!u.emailVerified && <IconButton icon={MailCheck} label={`Mark ${u.name}'s email as verified`} onClick={() => update.mutate({ id: u.id, emailVerified: true })} />}
                  <IconButton icon={BadgePlus} label={`Give ${u.name} a plan`} onClick={() => setGrantFor(u)} />
                  <IconButton icon={KeyRound} label={`Reset ${u.name}'s password`} onClick={async () => {
                    if (await confirm({ title: `Reset password for ${u.name}?`, message: 'A temporary password is generated and shown once. They are signed out everywhere.', confirmLabel: 'Reset password' })) resetPw.mutate({ id: u.id, name: u.name });
                  }} />
                  <IconButton icon={u.status === 'active' ? Ban : UserCheck} label={u.status === 'active' ? `Suspend ${u.name}` : `Reactivate ${u.name}`} onClick={async () => {
                    const suspend = u.status === 'active';
                    if (await confirm({ title: suspend ? `Suspend ${u.name}?` : `Reactivate ${u.name}?`, message: suspend ? 'They are signed out everywhere and cannot log in.' : 'They will be able to log in again.', confirmLabel: suspend ? 'Suspend' : 'Reactivate', danger: suspend })) update.mutate({ id: u.id, status: suspend ? 'suspended' : 'active' });
                  }} />
                  <IconButton icon={Trash2} label={`Delete ${u.name}`} className="hover:text-c-red" onClick={async () => {
                    if (await confirm({ title: `Delete ${u.name}?`, message: 'This permanently deletes the account and all of its data. This cannot be undone.', danger: true })) remove.mutate(u.id);
                  }} />
                </div>
              ) },
            ]} />
            <div className="border-t border-line px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
          </>
        )}
      </QueryState>
      {grantFor && <GrantPlanModal user={grantFor} onClose={() => setGrantFor(null)} />}
      {emailing && <EmailUsersModal users={[...picked.values()]} onClose={() => setEmailing(false)} />}
      {gifting && <GiftPlanModal users={[...picked.values()]} onClose={() => setGifting(false)} onDone={() => setPicked(new Map())} />}
      {temp && (
        <Modal open onClose={() => setTemp(null)} title={`Temporary password for ${temp.name}`} size="sm"
          footer={<><Button variant="secondary" onClick={() => navigator.clipboard?.writeText(temp.password)}>Copy</Button><Button onClick={() => setTemp(null)}>Done</Button></>}>
          <p className="text-sm text-fg-2">Share it with the user once. It is not shown again. Ask them to change it in Settings → Security.</p>
          <p className="mt-3 select-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm">{temp.password}</p>
        </Modal>
      )}
    </Card>
  );
}
