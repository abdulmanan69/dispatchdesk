import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Download, Upload, Trash2, Sun, Moon, Monitor, Mail, Bot, Radar } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Modal } from '../../components/Modal.jsx';
import { applyTheme } from '../../context/theme.js';
import { Card, PageHeader, Tabs, Field, Input, Textarea, Select, Button, Switch, Avatar, Badge, QueryState, cx } from '../../components/ui.jsx';
import SecurityPanel from '../../components/settings/SecurityPanel.jsx';
import CallingSettings from '../../components/calling/CallingSettings.jsx';

const TABS = [
  { value: 'profile', label: 'Profile' },
  { value: 'security', label: 'Security' },
  { value: 'appearance', label: 'Appearance' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'calling', label: 'Calling' },
  { value: 'integrations', label: 'Email & integrations' },
  { value: 'data', label: 'Data & account' },
];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'profile';
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Your profile, security, preferences and data" />
      <Tabs tabs={TABS} value={tab} onChange={(v) => setParams({ tab: v })} />
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <SecurityPanel />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'notifications' && <NotificationPrefs />}
      {tab === 'calling' && <CallingSettings />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'data' && <DataAccount />}
    </div>
  );
}

function useSaveProfile(success = 'Saved') {
  const { setUser } = useAuth();
  return useApiMutation((body) => api.patch('/api/profile', body), { success, onSuccess: (d) => setUser(d.user) });
}

function Profile() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const fileRef = useRef(null);
  const [form, setForm] = useState({ name: user.name, phone: user.phone || '', bio: user.bio || '', timezone: user.timezone });
  const save = useSaveProfile('Profile saved');
  const zones = useMemo(() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC']; }
  }, []);
  const upload = useApiMutation((file) => { const fd = new FormData(); fd.append('file', file); return api.upload('/api/profile/avatar', fd); }, { success: 'Photo updated', onSuccess: (d) => setUser(d.user) });
  const removeAvatar = useApiMutation(() => api.del('/api/profile/avatar'), { success: 'Photo removed', onSuccess: () => setUser({ ...user, avatarUrl: null }) });

  const onFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) return toast.error('Choose an image under 3 MB');
    upload.mutate(f);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title="Photo">
        <div className="flex flex-col items-center gap-3 text-center">
          <Avatar name={user.name} src={user.avatarUrl} size={88} />
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={onFile} />
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" icon={Upload} loading={upload.isPending} onClick={() => fileRef.current?.click()}>Upload</Button>
            {user.avatarUrl && <Button variant="ghost" size="sm" loading={removeAvatar.isPending} onClick={() => removeAvatar.mutate()}>Remove</Button>}
          </div>
          <p className="text-xs text-muted">PNG, JPG, WebP or GIF up to 3 MB. Shown on community posts and your team.</p>
        </div>
      </Card>
      <Card title="Profile" className="lg:col-span-2">
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>
          <Field label="Full name" required><Input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          <Field label="Email" hint={user.emailVerified ? 'Verified' : 'Not verified yet'}><Input value={user.email} disabled /></Field>
          <Field label="Phone"><Input type="tel" value={form.phone} maxLength={40} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Time zone" hint="Used for dashboards, reminders and scheduling">
            <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
          <Field label="Bio" className="sm:col-span-2" hint="Visible on your community profile"><Textarea rows={3} maxLength={1000} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></Field>
          <div className="sm:col-span-2 flex items-center justify-between">
            <p className="text-xs text-muted">Role: {user.roleName}</p>
            <Button type="submit" loading={save.isPending}>Save profile</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Appearance() {
  const { user } = useAuth();
  const save = useSaveProfile('Theme saved');
  const options = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'Match system', icon: Monitor },
  ];
  return (
    <Card title="Theme">
      <div className="grid max-w-xl gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={user.theme === o.value}
            onClick={() => { applyTheme(o.value); save.mutate({ theme: o.value }); }}
            className={cx('flex flex-col items-center gap-2 rounded-lg border p-4 text-sm', user.theme === o.value ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line hover:bg-surface-2')}>
            <o.icon className="size-5" aria-hidden />{o.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

function NotificationPrefs() {
  const { user } = useAuth();
  const save = useSaveProfile('Preferences saved');
  const items = [
    ['notifyInApp', 'In-app notifications', 'Bell notifications inside the app'],
    ['notifyEmail', 'Email notifications', 'Important account and team messages by email (requires platform email)'],
    ['notifyFollowUps', 'Follow-up reminders', 'Remind me when follow-ups and sequence steps are due'],
    ['notifyCommunity', 'Community replies', 'When someone replies to my posts or comments'],
  ];
  return (
    <Card title="Notification preferences">
      <ul className="divide-y divide-line">
        {items.map(([key, name, desc]) => (
          <li key={key} className="flex items-center justify-between gap-4 py-3">
            <div><p className="text-sm font-medium">{name}</p><p className="text-xs text-muted">{desc}</p></div>
            <Switch checked={!!user[key]} disabled={save.isPending} onChange={(v) => save.mutate({ [key]: v })} label={<span className="sr-only">{name}</span>} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StatusRow({ icon: Icon, name, ok, detail, action }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Icon className="size-5 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{name} <Badge color={ok ? 'green' : 'gray'} className="ml-1">{ok ? 'Available' : 'Not configured'}</Badge></p>
        {detail && <p className="text-xs text-muted">{detail}</p>}
      </div>
      {action}
    </li>
  );
}

function Integrations() {
  const { user } = useAuth();
  const [sig, setSig] = useState(user.emailSignature || '');
  const save = useSaveProfile('Signature saved');
  const ai = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api.get('/api/ai/status') });
  const providers = useQuery({ queryKey: ['discovery', 'providers'], queryFn: () => api.get('/api/discovery/providers') });
  const list = (d) => (Array.isArray(d) ? d : d?.providers || d?.items || []);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Email signature" actions={<Button variant="secondary" size="sm" icon={Mail} to="/app/email?tab=mailboxes">Manage mailboxes</Button>}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ emailSignature: sig }); }}>
          <Field label="Signature" hint="Appended to emails you send from the app"><Textarea rows={5} maxLength={2000} value={sig} onChange={(e) => setSig(e.target.value)} placeholder={`${user.name}\nDispatcher · ${user.phone || 'phone'}`} /></Field>
          <Button type="submit" loading={save.isPending}>Save signature</Button>
        </form>
      </Card>
      <Card title="Connected services">
        <ul className="divide-y divide-line">
          <QueryState query={ai}>
            {(d) => <StatusRow icon={Bot} name="AI dispatcher" ok={!!(d.configured ?? d.enabled ?? d.available)}
              detail={[d.model && `Model ${d.model}`, d.webSearch != null && (d.webSearch ? 'web research on' : 'web research off'), d.message].filter(Boolean).join(' · ') || 'Configured by your administrator'}
              action={<Button variant="ghost" size="sm" to="/app/ai">Open</Button>} />}
          </QueryState>
          <QueryState query={providers}>
            {(d) => list(d).map((p) => (
              <StatusRow key={p.key || p.id || p.name} icon={Radar} name={p.name || p.label || p.key}
                ok={!!(p.available ?? p.configured ?? p.enabled)} detail={p.description || p.note || p.message} />
            ))}
          </QueryState>
        </ul>
        <p className="mt-2 text-xs text-muted">Platform-wide API keys (AI, Stripe, FMCSA, OAuth) are managed by administrators and never shown in the browser.</p>
      </Card>
    </div>
  );
}

function DataAccount() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [exporting, setExporting] = useState(false);
  const del = useApiMutation((body) => api.del('/api/settings/account', body), {
    onSuccess: () => { setUser(null); toast.success('Your account was deleted'); navigate('/'); },
  });
  const doExport = async () => {
    setExporting(true);
    try { await api.download('/api/settings/export', 'dispatchdesk-export.json'); } catch (e) { toast.error(e); } finally { setExporting(false); }
  };
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Export your data">
        <p className="text-sm text-muted">Download a JSON file with your profile, carriers, notes, calls, follow-ups, brokers, loads, templates, sequences, email history and activity. Passwords and mailbox credentials are never included.</p>
        <Button className="mt-4" variant="secondary" icon={Download} loading={exporting} onClick={doExport}>Download export</Button>
      </Card>
      <Card title="Delete account">
        <p className="text-sm text-muted">Permanently deletes your account, pipeline, documents and uploads. This cannot be undone. Cancel any paid subscription and transfer team ownership first.</p>
        <Button className="mt-4" variant="danger" icon={Trash2} onClick={() => setOpen(true)}>Delete my account</Button>
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete account permanently" size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" disabled={form.confirm !== 'DELETE' || !form.password} loading={del.isPending} onClick={() => del.mutate(form)}>Delete account</Button>
        </>}>
        <div className="space-y-3">
          <p className="text-sm text-muted">All data for <span className="font-medium text-fg">{user.email}</span> will be removed.</p>
          <Field label="Password" required><Input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label='Type "DELETE" to confirm' required><Input value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
