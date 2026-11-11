import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlugZap, Copy } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { dateTime } from '../../lib/format.js';
import { Card, QueryState, Badge, Button, Field, Input, Select, Switch, cx } from '../ui.jsx';
import OAuthSetupGuide from './OAuthSetupGuide.jsx';

const GROUPS = [
  { key: 'app', title: 'Application', test: null },
  { key: 'ai', title: 'AI dispatcher & web research', test: ['ai', 'search'] },
  { key: 'email', title: 'Platform email (SMTP or Brevo)', test: ['smtp'], help: 'Used for verification, password reset, team invitations and notifications. Either fill in SMTP (Hostinger: smtp.hostinger.com, port 465, secure on), or paste a Brevo API key and a From address on your authenticated domain.' },
  { key: 'integrations', title: 'Integrations (OAuth & carrier data)', test: ['google', 'microsoft', 'fmcsa'], help: 'Google and Microsoft OAuth apps let users connect Gmail and Outlook mailboxes with one click. FMCSA Census works without a key; a QCMobile webKey adds authority-status lookups. A free EIA API key turns on weekly diesel prices on the Market page.' },
  { key: 'billing', title: 'Billing (Stripe)', test: ['stripe'] },
];

const LABELS = {
  'app.name': 'Application name', 'app.registrationOpen': 'Allow new registrations', 'app.requireEmailVerification': 'Require verified email',
  'ai.baseUrl': 'API base URL (OpenAI-compatible)', 'ai.apiKey': 'API key', 'ai.model': 'Chat model', 'ai.embeddingModel': 'Embedding model (optional)',
  'search.provider': 'Web search provider', 'search.apiKey': 'Search API key',
  'smtp.host': 'SMTP host', 'smtp.port': 'Port', 'smtp.secure': 'Use TLS (port 465)', 'smtp.user': 'Username', 'smtp.pass': 'Password', 'smtp.from': 'From address',
  'smtp.dailyLimit': 'Platform emails per day', 'brevo.apiKey': 'Brevo API key (optional, replaces SMTP)',
  'google.clientId': 'Google OAuth client ID', 'google.clientSecret': 'Google OAuth client secret',
  'microsoft.clientId': 'Microsoft OAuth client ID', 'microsoft.clientSecret': 'Microsoft OAuth client secret', 'microsoft.tenant': 'Microsoft tenant',
  'fmcsa.webKey': 'FMCSA QCMobile webKey', 'fmcsa.socrataAppToken': 'data.transportation.gov app token', 'eia.apiKey': 'EIA API key (diesel and gasoline prices, free at eia.gov/opendata)', 'fred.apiKey': 'FRED API key (truck tonnage index, free at fred.stlouisfed.org)', 'usda.marsApiKey': 'USDA My Market News API key (produce truck rates, free at mymarketnews.ams.usda.gov)',
  'stripe.secretKey': 'Stripe secret key', 'stripe.webhookSecret': 'Stripe webhook signing secret',
};
// Short explanations shown under a setting.
const HINTS = {
  'app.requireEmailVerification': 'Applies once platform email (SMTP) works. Unverified accounts can sign in and look around, but cannot save changes until they open the verification link. Admins are never blocked.',
  'app.registrationOpen': 'When off, nobody can create a new account. Existing users can still sign in.',
  'smtp.dailyLimit': 'Most messages platform email sends per day (UTC), counted across all servers. Part of it is kept for verification and password reset mail. Match it to the daily quota of your SMTP provider.',
};
const TEST_LABEL = { smtp: 'Test SMTP', ai: 'Test AI', fmcsa: 'Test FMCSA', search: 'Test search', stripe: 'Test Stripe', google: 'Check Google', microsoft: 'Check Microsoft' };
const SOURCE = { database: 'brand', environment: 'blue', unset: 'gray' };

const NUMERIC = { 'smtp.port': { min: 1, max: 65535 }, 'smtp.dailyLimit': { min: 1, max: 9999999 } };

// `id` comes from the surrounding Field, so its label names the control.
function SettingInput({ s, value, onChange, id }) {
  if (s.type === 'bool') return <Switch checked={value === 'true'} onChange={(v) => onChange(String(v))} label={LABELS[s.key] || s.key} />;
  if (s.key === 'search.provider') {
    return <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Disabled</option><option value="tavily">Tavily</option><option value="brave">Brave Search</option></Select>;
  }
  const numeric = NUMERIC[s.key];
  return <Input id={id} type={s.secret ? 'password' : numeric ? 'number' : 'text'} inputMode={numeric ? 'numeric' : undefined} min={numeric?.min} max={numeric?.max} step={numeric ? 1 : undefined}
    autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)}
    placeholder={s.secret ? (s.isSet ? `${s.preview} — leave blank to keep` : 'Not set') : ''} />;
}

export default function SystemSettings() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get('/api/admin/settings') });
  const [values, setValues] = useState({});
  const [results, setResults] = useState({});
  useEffect(() => {
    if (q.data) setValues(Object.fromEntries(q.data.settings.map((s) => [s.key, s.secret ? '' : s.value])));
  }, [q.data]);
  const save = useApiMutation((body) => api.put('/api/admin/settings', body), { success: 'Settings saved', invalidate: [['admin', 'settings']] });
  const test = useApiMutation((service) => api.post(`/api/admin/settings/test/${service}`), {
    onSuccess: (d) => { setResults((r) => ({ ...r, [d.service]: d })); d.ok ? toast.success(d.message) : toast.error(d.message); },
  });

  const saveGroup = (group, clear = []) => {
    const keys = q.data.settings.filter((s) => s.group === group).map((s) => s.key);
    save.mutate({ values: Object.fromEntries(keys.map((k) => [k, values[k] ?? ''])), clear });
  };
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast.success('Copied'); } catch { toast.error('Copy failed'); } };

  return (
    <QueryState query={q}>
      {(d) => (
        <div className="space-y-4">
          <p className="text-sm text-muted">Values saved here override environment variables. Secrets are encrypted at rest and never sent back to the browser.</p>
          {GROUPS.map((g) => {
            const items = d.settings.filter((s) => s.group === g.key);
            return (
              <Card key={g.key} title={g.title} actions={<>
                {g.test?.map((svc) => (
                  <Button key={svc} variant="secondary" size="sm" icon={PlugZap} loading={test.isPending && test.variables === svc} onClick={() => test.mutate(svc)}>{TEST_LABEL[svc] || svc}</Button>
                ))}
              </>}>
                {g.help && <p className="mb-3 text-xs text-muted">{g.help}</p>}
                {g.key === 'billing' && (
                  <div className="mb-3 rounded-md bg-surface-2 p-3 text-xs">
                    <p className="text-muted">Webhook endpoint to add in Stripe (events: checkout.session.completed, customer.subscription.created, .updated and .deleted, invoice.paid, invoice.payment_failed):</p>
                    <div className="mt-1 flex items-center gap-2"><code className="font-mono">{d.webhookUrl}</code><button type="button" aria-label="Copy webhook URL" onClick={() => copy(d.webhookUrl)} className="text-muted hover:text-fg"><Copy className="size-3.5" /></button></div>
                  </div>
                )}
                {g.key === 'integrations' && <OAuthSetupGuide oauth={d.oauth} appUrl={d.appUrl} />}
                <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); saveGroup(g.key); }}>
                  {items.map((s) => (
                    <div key={s.key} className={cx(s.type === 'bool' && 'sm:col-span-2')}>
                      {s.type === 'bool' ? (
                        <>
                          <SettingInput s={s} value={values[s.key] ?? ''} onChange={(v) => setValues({ ...values, [s.key]: v })} />
                          {HINTS[s.key] && <p className="mt-1 pl-[2.875rem] text-xs text-muted">{HINTS[s.key]}</p>}
                        </>
                      ) : (
                        <Field label={<span className="flex items-center gap-2">{LABELS[s.key] || s.key}<Badge color={SOURCE[s.source]}>{s.source}</Badge></span>} hint={HINTS[s.key]}>
                          <SettingInput s={s} value={values[s.key] ?? ''} onChange={(v) => setValues({ ...values, [s.key]: v })} />
                        </Field>
                      )}
                      {s.secret && s.source === 'database' && (
                        <button type="button" className="mt-1 text-xs text-red-600 hover:underline" onClick={() => save.mutate({ clear: [s.key] })}>Remove saved value</button>
                      )}
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                    <div className="text-xs">
                      {g.test?.map((svc) => results[svc] && (
                        <p key={svc} className={results[svc].ok ? 'text-green-700 dark:text-green-400' : 'text-red-600'}>{svc}: {results[svc].message} <span className="text-muted">({dateTime(results[svc].testedAt)})</span></p>
                      ))}
                    </div>
                    <Button type="submit" loading={save.isPending}>Save {g.title.split(' ')[0].toLowerCase()} settings</Button>
                  </div>
                </form>
              </Card>
            );
          })}
        </div>
      )}
    </QueryState>
  );
}
