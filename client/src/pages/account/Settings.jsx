import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload, Trash2, Sun, Moon, Monitor, Mail, Bot, Radar, BellRing, Smartphone, Send, Copy, CalendarDays, RefreshCw, ExternalLink, Share, ShieldAlert } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation, errorToast } from '../../lib/hooks.js';
import { dateTime, relative } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { applyTheme } from '../../context/theme.js';
import { Card, PageHeader, Tabs, Field, Input, Textarea, Select, Button, Switch, Checkbox, Avatar, Badge, QueryState, IconButton, cx } from '../../components/ui.jsx';
import { pushSupport, enablePush, disablePush, currentSubscription, thisDeviceId, deviceLabel } from '../../context/push.js';
import SecurityPanel from '../../components/settings/SecurityPanel.jsx';
import CallingSettings from '../../components/calling/CallingSettings.jsx';

const TABS = [
  { value: 'profile', label: 'Profile' },
  { value: 'security', label: 'Security' },
  { value: 'appearance', label: 'Appearance' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'calendar', label: 'Calendar' },
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
      {tab === 'notifications' && <><NotificationPrefs /><PushSettings /></>}
      {tab === 'calendar' && <CalendarFeed />}
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
    ['notifyFollowUps', 'Follow-up reminders', 'Remind me in the app, and by push on devices where push is on, when follow-ups are due. By email, only in the daily digest.'],
    ['notifyDigest', 'Daily digest email', "One email at 7 AM your time listing overdue and today's follow-ups, sequence steps and loads that need attention. Nothing is sent on days with nothing due."],
    ['notifyCommunity', 'Community replies', 'When someone replies to my posts or comments'],
  ];
  const digestNote = user.notifyDigest && !user.notifyFollowUps
    ? 'The digest is sent only while follow-up reminders are on.'
    : user.notifyDigest && (!user.notifyEmail || !user.emailVerified)
      ? 'The digest is sent from your connected mailbox. Without one, it comes from platform email, which needs email notifications on and a verified address.'
      : null;
  return (
    <Card title="Notification preferences">
      <ul className="divide-y divide-line">
        {items.map(([key, name, desc]) => (
          <li key={key} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{name}</p><p className="text-xs text-muted">{desc}</p>
              {key === 'notifyDigest' && digestNote && <p className="mt-1 text-xs text-c-amber">{digestNote}</p>}
            </div>
            <Switch checked={!!user[key]} disabled={save.isPending} onChange={(v) => save.mutate({ [key]: v })} label={<span className="sr-only">{name}</span>} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Push notifications: the account-wide switch, this browser's state, and the list of devices. */
function PushSettings() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [support, setSupport] = useState(() => pushSupport());
  const [local, setLocal] = useState(undefined); // this browser's subscription: undefined = checking
  const [busy, setBusy] = useState(null); // 'enable' | 'disable'
  const devices = useQuery({ queryKey: ['push', 'devices'], queryFn: ({ signal }) => api.get('/api/push/subscriptions', undefined, { signal }) });
  const refreshLocal = () => currentSubscription().then((s) => setLocal(s || null)).catch(() => setLocal(null));
  useEffect(() => { refreshLocal(); }, []);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['push', 'devices'] });

  // Saved on the profile (like the other notification switches), so the signed-in user and the device list agree.
  const pref = useApiMutation((notifyPush) => api.patch('/api/profile', { notifyPush }), {
    onSuccess: (d) => {
      if (d?.user) setUser(d.user);
      qc.setQueryData(['push', 'devices'], (old) => (old ? { ...old, notifyPush: !!d?.user?.notifyPush } : old));
    },
  });
  const test = useApiMutation((id) => api.post('/api/push/test', id ? { id } : {}), {
    success: (r) => (r.sent ? `Test sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'}` : 'The test could not be delivered'),
    onSuccess: invalidate,
  });
  const remove = useApiMutation((id) => api.del(`/api/push/subscriptions/${id}`), { success: 'Device removed', invalidate: [['push', 'devices']] });

  const myId = thisDeviceId();
  const items = devices.data?.items || [];
  const thisDevice = local ? items.find((d) => d.id === myId) : null;

  const turnOn = async () => {
    setBusy('enable');
    try {
      await enablePush(user.id);
      toast.success('Push notifications are on for this device');
      await refreshLocal();
      invalidate();
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setSupport(pushSupport());
      setBusy(null);
    }
  };
  const turnOff = async () => {
    setBusy('disable');
    try {
      await disablePush();
      toast.success('Push notifications are off for this device');
      await refreshLocal();
      invalidate();
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={<div className="flex items-center gap-2"><BellRing className="size-4 text-c-purple" aria-hidden /><h2 className="text-sm font-medium">Push notifications</h2></div>}
      actions={devices.data && <Badge color={devices.data.notifyPush ? 'green' : 'gray'}>{devices.data.notifyPush ? 'On' : 'Off'}</Badge>}>
      <p className="text-sm text-fg-2">Driver check-ins and issues, follow-ups that are due and other alerts arrive on your phone or computer, even when DispatchDesk is closed. Each alert also stays in the bell menu.</p>
      <QueryState query={devices}>
        {(d) => (
          <div className="mt-4 space-y-5">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-line px-4 py-3">
              <div><p className="text-sm font-medium">Send push notifications</p><p className="text-xs text-muted">Applies to every device below</p></div>
              <Switch checked={!!d.notifyPush} disabled={pref.isPending} onChange={(v) => pref.mutate(v)} label={<span className="sr-only">Send push notifications</span>} />
            </div>

            <div>
              <h3 className="text-[13px] font-medium">This device</h3>
              {support.needsInstall ? (
                <div className="mt-2 rounded-lg bg-c-blue-soft px-4 py-3 text-sm text-fg-2">
                  <p className="font-medium text-fg">On iPhone and iPad, add DispatchDesk to your Home Screen first</p>
                  <p className="mt-1">In Safari, tap Share <Share className="inline size-3.5 align-text-bottom" aria-label="Share" />, then Add to Home Screen. Open DispatchDesk from the Home Screen and turn push on here. Needs iOS 16.4 or later.</p>
                </div>
              ) : !support.supported ? (
                <p className="mt-2 text-sm text-muted">This browser does not support push notifications. Recent Chrome, Edge, Firefox and Safari do.</p>
              ) : support.permission === 'denied' ? (
                <p className="mt-2 flex items-start gap-2 text-sm text-fg-2"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-c-amber" aria-hidden />Notifications are blocked for this site. Allow them in your browser's site settings, then reload this page.</p>
              ) : local === undefined ? (
                <p className="mt-2 text-sm text-muted">Checking this browser…</p>
              ) : local && thisDevice ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge color="green">On for this device</Badge>
                  <Button size="sm" variant="secondary" icon={Send} loading={test.isPending && test.variables === thisDevice.id} onClick={() => test.mutate(thisDevice.id)}>Send a test</Button>
                  <Button size="sm" variant="ghost" loading={busy === 'disable'} onClick={turnOff}>Turn off on this device</Button>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button icon={Smartphone} loading={busy === 'enable'} onClick={turnOn}>Turn on for this device</Button>
                  <span className="text-xs text-muted">Your browser asks for permission first.</span>
                </div>
              )}
            </div>

            <div>
              <h3 className="text-[13px] font-medium">Devices <span className="font-normal text-muted">({items.length} of {d.max})</span></h3>
              {!items.length ? <p className="mt-2 text-sm text-muted">No devices yet.</p> : (
                <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                  {items.map((dev) => (
                    <li key={dev.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <Smartphone className="size-4 shrink-0 text-muted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {deviceLabel(dev.userAgent)}
                          {local && dev.id === myId && <Badge color="teal">This device</Badge>}
                          {dev.failures > 0 && <Badge color="amber">{dev.failures} failed {dev.failures === 1 ? 'delivery' : 'deliveries'}</Badge>}
                        </p>
                        <p className="text-xs text-muted" title={dateTime(dev.createdAt)}>Added {relative(dev.createdAt)}{dev.lastUsedAt ? ` · last push ${relative(dev.lastUsedAt)}` : ''}</p>
                      </div>
                      <Button size="sm" variant="ghost" icon={Send} loading={test.isPending && test.variables === dev.id} onClick={() => test.mutate(dev.id)}>Test</Button>
                      <IconButton icon={Trash2} label={`Remove ${deviceLabel(dev.userAgent)}`}
                        onClick={async () => { if (await confirm({ title: 'Remove this device?', message: 'It stops receiving push notifications until push is turned on there again.', danger: true, confirmLabel: 'Remove' })) remove.mutate(dev.id); }} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted">Up to {d.max} devices; adding another replaces the one used least recently. Signing out turns push off on that device.</p>
            </div>
          </div>
        )}
      </QueryState>
    </Card>
  );
}

/** Private iCalendar link: create, copy, replace, turn off. The link is shown once, when created. */
function CalendarFeed() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['calendar', 'feed'], queryFn: ({ signal }) => api.get('/api/calendar', undefined, { signal }) });
  const [link, setLink] = useState(null); // { url, webcalUrl, googleUrl } right after creating
  const [hideNames, setHideNames] = useState(false);
  const create = useApiMutation(() => api.post('/api/calendar/token', {}), {
    onSuccess: (d) => { setLink(d); qc.setQueryData(['calendar', 'feed'], { enabled: true }); toast.success(d.replaced ? 'New link created. The old link no longer works.' : 'Calendar link created'); },
  });
  const off = useApiMutation(() => api.del('/api/calendar/token'), {
    success: 'Calendar link turned off',
    onSuccess: () => { setLink(null); qc.setQueryData(['calendar', 'feed'], { enabled: false }); },
  });
  const suffix = hideNames ? '?names=0' : '';
  const url = link ? `${link.url}${suffix}` : '';
  const webcal = link ? `${link.webcalUrl}${suffix}` : '';
  const google = link ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast.success('Link copied'); } catch { toast.error('Copy failed. Select the link and copy it.'); }
  };
  const rotate = async () => {
    if (await confirm({ title: 'Create a new link?', message: 'The current link stops working right away. Calendars that use it stop updating until you add the new link.', confirmLabel: 'Create new link' })) create.mutate();
  };
  return (
    <Card title={<div className="flex items-center gap-2"><CalendarDays className="size-4 text-c-blue" aria-hidden /><h2 className="text-sm font-medium">Calendar feed</h2></div>}
      actions={status.data && <Badge color={status.data.enabled ? 'green' : 'gray'}>{status.data.enabled ? 'On' : 'Off'}</Badge>}>
      <p className="max-w-2xl text-sm text-fg-2">See pickups and deliveries (with appointment times when set), pending follow-ups, invoice due dates and document expirations in Google Calendar, Apple Calendar or Outlook, from two weeks back to 60 days ahead. Calendar apps check for changes every few hours.</p>
      <QueryState query={status}>
        {(d) => (
          <div className="mt-4 space-y-4">
            {link ? (
              <>
                <Field label="Your private calendar link" hint="Shown only now. To see a link again later, create a new one.">
                  {(id) => (
                    <div className="flex gap-2">
                      <Input id={id} readOnly value={url} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 font-mono text-xs" />
                      <Button variant="secondary" icon={Copy} onClick={copy}>Copy</Button>
                    </div>
                  )}
                </Field>
                <Checkbox label="Leave out carrier, broker and customer names" checked={hideNames} onChange={(e) => setHideNames(e.target.checked)} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" icon={ExternalLink} href={google} target="_blank" rel="noopener noreferrer">Add to Google Calendar</Button>
                  <Button variant="secondary" icon={CalendarDays} href={webcal}>Open in Apple Calendar or Outlook</Button>
                </div>
                <p className="flex items-start gap-2 text-xs text-muted"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />Anyone with this link can see these events. Keep it private, and create a new link if it was shared by mistake.</p>
              </>
            ) : d.enabled ? (
              <p className="text-sm text-fg-2">Your calendar link is on. For your privacy it is shown only once, when it is created.</p>
            ) : (
              <Button icon={CalendarDays} loading={create.isPending} onClick={() => create.mutate()}>Create calendar link</Button>
            )}
            {d.enabled && (
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <Button variant="secondary" icon={RefreshCw} loading={create.isPending} onClick={rotate}>Create a new link</Button>
                <Button variant="ghost" loading={off.isPending}
                  onClick={async () => { if (await confirm({ title: 'Turn off the calendar link?', message: 'Calendars that use it stop updating. Events already shown there may stay until the calendar app removes them.', confirmLabel: 'Turn off', danger: true })) off.mutate(); }}>Turn off</Button>
              </div>
            )}
          </div>
        )}
      </QueryState>
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
