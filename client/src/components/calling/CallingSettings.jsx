import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Button, Card, Field, Input, Loading, ErrorState, Switch, cx } from '../ui.jsx';

/**
 * Calling setup: which app/service places calls, plus the automation around each click.
 * Self-contained; mounted in Settings and in the power dialer.
 */
export default function CallingSettings({ compact = false, onSaved }) {
  const providers = useQuery({ queryKey: ['telephony', 'providers'], queryFn: () => api.get('/api/telephony/providers'), staleTime: 3600000 });
  const settings = useQuery({ queryKey: ['telephony', 'settings'], queryFn: () => api.get('/api/telephony/settings') });
  const [f, setF] = useState(null);
  const [test, setTest] = useState(null);
  const [dirty, setDirty] = useState(false);
  const upd = (patch) => { setF((prev) => ({ ...prev, ...patch })); setDirty(true); };

  useEffect(() => {
    const s = settings.data?.settings;
    if (s) setF({ ...s, urlTemplate: s.urlTemplate || '', myNumber: s.myNumber || '', callerId: s.callerId || '', twilioAccountSid: s.twilioAccountSid || '', twilioAuthToken: '' });
    setDirty(false);
  }, [settings.data]);

  const save = useApiMutation((body) => api.put('/api/telephony/settings', body), {
    success: 'Calling settings saved', invalidate: [['telephony']], onSuccess: (d) => { setTest(null); onSaved?.(d.settings); },
  });
  const runTest = useApiMutation(() => api.post('/api/telephony/settings/test'), { onSuccess: setTest });

  if (providers.isLoading || settings.isLoading || !f) return <Loading />;
  if (providers.isError || settings.isError) return <ErrorState error={providers.error || settings.error} onRetry={() => { providers.refetch(); settings.refetch(); }} />;

  const list = providers.data.items;
  const current = list.find((p) => p.key === f.provider) || list[0];
  const set = (k) => (e) => upd({ [k]: e?.target ? e.target.value : e });
  const needsTemplate = ['custom', 'sip'].includes(f.provider);
  const isTwilio = f.provider === 'twilio';

  const submit = (e) => {
    e.preventDefault();
    save.mutate({
      provider: f.provider,
      urlTemplate: needsTemplate ? f.urlTemplate : null,
      myNumber: f.myNumber || null,
      callerId: f.callerId || null,
      twilioAccountSid: f.twilioAccountSid || null,
      twilioAuthToken: f.twilioAuthToken || '',
      autoOpenLog: f.autoOpenLog,
      autoAdvance: f.autoAdvance,
      enforceCallingHours: f.enforceCallingHours,
      autoLogUnanswered: f.autoLogUnanswered,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card title="How calls are placed" bodyClass="p-0">
        <div className={cx('grid gap-0 divide-line', compact ? '' : 'lg:grid-cols-[280px_1fr] lg:divide-x')}>
          <fieldset className="p-3">
            <legend className="sr-only">Calling provider</legend>
            <div className="space-y-0.5">
              {list.map((p) => (
                <label key={p.key} className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-ui', f.provider === p.key ? 'bg-surface-2 font-medium text-fg' : 'text-fg-2 hover:bg-surface-2/60')}>
                  <input type="radio" name="provider" value={p.key} checked={f.provider === p.key} onChange={() => upd({ provider: p.key })} className="accent-brand-600" />
                  <span className="flex-1">{p.label}</span>
                  {p.kind === 'bridge' && <span className="font-mono text-[11px] text-muted">auto-log</span>}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-4 border-t border-line p-5 lg:border-t-0">
            <div>
              <h3 className="text-sm font-medium">{current.label}</h3>
              <p className="mt-1 text-sm text-fg-2">{current.description}</p>
            </div>
            <ol className="space-y-1.5 text-sm text-fg-2">
              {current.setup.map((s, i) => (
                <li key={s} className="flex gap-3"><span className="w-5 shrink-0 font-mono text-xs leading-5 text-muted">{i + 1}.</span>{s}</li>
              ))}
            </ol>

            {needsTemplate && (
              <Field label="Link template" required hint="Use {number} for +15551234567 or {digits} for 5551234567">
                <Input value={f.urlTemplate} onChange={set('urlTemplate')} placeholder={f.provider === 'sip' ? 'sip:{number}@pbx.example.com' : 'https://dialer.example.com/call?to={number}'} />
              </Field>
            )}

            {isTwilio && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Account SID" required><Input value={f.twilioAccountSid} onChange={set('twilioAccountSid')} placeholder="AC…" autoComplete="off" /></Field>
                <Field label="Auth token" required hint={settings.data.settings.twilioAuthTokenSet ? 'Saved and encrypted. Leave empty to keep it' : 'Stored encrypted, never shown again'}>
                  <Input type="password" value={f.twilioAuthToken} onChange={set('twilioAuthToken')} autoComplete="new-password" placeholder={settings.data.settings.twilioAuthTokenSet ? '••••••••' : ''} />
                </Field>
                <Field label="Caller ID" required hint="A Twilio number you own or a verified number"><Input value={f.callerId} onChange={set('callerId')} placeholder="+1 214 555 0000" /></Field>
                <Field label="Your phone" required hint="Twilio rings this first, then connects the carrier"><Input value={f.myNumber} onChange={set('myNumber')} placeholder="+1 972 555 1111" /></Field>
                {!settings.data.settings.webhookPublic && (
                  <p className="text-xs text-fg-2 sm:col-span-2">
                    Status updates and automatic logging need Twilio to reach <span className="font-mono">{settings.data.settings.webhookBase}</span>. Set APP_URL to your public https address. Until then calls connect, but their status is not tracked.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" size="sm" loading={runTest.isPending} disabled={dirty} onClick={() => runTest.mutate()} title={dirty ? 'Save first' : undefined}>
                {isTwilio ? 'Check Twilio connection' : 'Show example link'}
              </Button>
              {dirty && <span className="text-xs text-muted">Save to test the new settings</span>}
            </div>
            {test && (
              <div role="status" className={cx('rounded-lg border px-3 py-2 text-sm', test.ok ? 'border-line bg-surface-2/60 text-fg' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300')}>
                {test.message}
                {test.example && <div className="mt-1 break-all font-mono text-xs text-fg-2">{test.example}</div>}
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card title="Automation around each call">
        <div className="space-y-4">
          <Toggle checked={f.autoOpenLog} onChange={(v) => upd({ autoOpenLog: v })} label="Open the log-call form as soon as a call starts" hint="A timer runs from your click, so call length is filled in for you." />
          <Toggle checked={f.autoAdvance} onChange={(v) => upd({ autoAdvance: v })} label="Power dialer: move to the next carrier after you save" />
          <Toggle checked={f.enforceCallingHours} onChange={(v) => upd({ enforceCallingHours: v })} label="Warn before calling outside 8 AM–7 PM on weekdays, carrier local time" hint="You can still call after confirming." />
          <Toggle checked={f.autoLogUnanswered} onChange={(v) => upd({ autoLogUnanswered: v })} disabled={!isTwilio} label="Log unanswered and busy calls automatically" hint={isTwilio ? 'A follow-up is scheduled for the next business day.' : 'Needs the Twilio bridge, which reports how each call ended.'} />
          <p className="text-xs text-muted">Calls are never placed without your click. Do-not-call carriers are always blocked.</p>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending}>Save calling settings</Button>
      </div>
    </form>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <div>
      <Switch checked={!!checked} onChange={onChange} label={label} disabled={disabled} />
      {hint && <p className="ml-[46px] mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
