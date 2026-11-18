import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Copy, PlugZap } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { dateTime } from '../../lib/format.js';
import { Badge, Button, Field, Input, QueryState, Select, Switch, Textarea, cx } from '../ui.jsx';
import OAuthSetupGuide from './OAuthSetupGuide.jsx';
import AiUsage from './AiUsage.jsx';
import { HINTS, LABELS, settingsPage } from './settingsMeta.js';

const TEST_LABEL = { polar: 'Test Polar', paddle: 'Test Paddle', smtp: 'Test SMTP', ai: 'Test AI', fmcsa: 'Test FMCSA', search: 'Test search', stripe: 'Test Stripe', google: 'Check Google', microsoft: 'Check Microsoft' };
const NUMERIC = { 'smtp.port': { min: 1, max: 65535 }, 'smtp.dailyLimit': { min: 1, max: 9999999 }, 'app.trialDays': { min: 0, max: 365 } };
const MULTILINE = ['manual.bank', 'manual.usdt', 'manual.taptapsend', 'manual.note'];
const WIDE = [...MULTILINE, 'announcement.text', 'polar.products', 'billing.provider'];

// `id` comes from the surrounding Field, so its label names the control.
function SettingInput({ s, value, onChange, id }) {
  if (s.type === 'bool') return <Switch checked={value === 'true'} onChange={(v) => onChange(String(v))} label={LABELS[s.key] || s.key} />;
  if (s.key === 'ai.provider') {
    return <Select id={id} value={value || 'openai'} onChange={(e) => onChange(e.target.value)}><option value="openai">OpenAI-compatible</option><option value="anthropic">Claude by Anthropic</option></Select>;
  }
  if (s.key === 'billing.provider') {
    return <Select id={id} value={value || 'stripe'} onChange={(e) => onChange(e.target.value)}><option value="manual">Manual: bank wire, USDT, Taptap Send (you approve)</option><option value="paddle">Paddle (merchant of record)</option><option value="polar">Polar (merchant of record)</option><option value="stripe">Stripe</option></Select>;
  }
  if (MULTILINE.includes(s.key)) {
    return <Textarea id={id} rows={Math.min(10, Math.max(3, String(value || '').split('\n').length + 1))} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={s.key === 'manual.note' ? 'For example: payments are checked Monday to Friday.' : 'Leave empty to not offer this method'} />;
  }
  if (s.key === 'polar.environment') {
    return <Select id={id} value={value || 'production'} onChange={(e) => onChange(e.target.value)}><option value="production">Production</option><option value="sandbox">Sandbox (test)</option></Select>;
  }
  if (s.key === 'paddle.environment') {
    return <Select id={id} value={value || 'live'} onChange={(e) => onChange(e.target.value)}><option value="live">Live</option><option value="sandbox">Sandbox (test)</option></Select>;
  }
  if (s.key === 'announcement.tone') {
    return <Select id={id} value={value || 'info'} onChange={(e) => onChange(e.target.value)}><option value="info">Teal (news)</option><option value="success">Green (good news)</option><option value="warning">Amber (warning)</option></Select>;
  }
  if (s.key === 'announcement.audience') {
    return <Select id={id} value={value || 'everyone'} onChange={(e) => onChange(e.target.value)}><option value="everyone">Everyone (app and website)</option><option value="app">Signed-in users (app only)</option><option value="public">Visitors (website only)</option></Select>;
  }
  if (s.key === 'search.provider') {
    return <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Disabled</option><option value="tavily">Tavily</option><option value="brave">Brave Search</option></Select>;
  }
  const numeric = NUMERIC[s.key];
  return <Input id={id} type={s.secret ? 'password' : numeric ? 'number' : 'text'} inputMode={numeric ? 'numeric' : undefined} min={numeric?.min} max={numeric?.max} step={numeric ? 1 : undefined}
    // Chrome ignores "off" on password fields and fills the admin's saved login into SMTP user/password;
    // "new-password" stops that, and data-*-ignore covers common password managers.
    autoComplete={s.secret ? 'new-password' : 'off'} data-1p-ignore="" data-lpignore="true" value={value} onChange={(e) => onChange(e.target.value)}
    placeholder={s.secret ? (s.isSet ? `${s.preview} — leave blank to keep` : 'Not set') : ''} />;
}

/** One setting: its control, its explanation, where its value comes from, and "Remove saved value" for secrets. */
function SettingRow({ s, value, onChange, onClear, flash }) {
  const label = LABELS[s.key] || s.key;
  const fromServer = s.source === 'environment' && <span className="text-[11px] font-normal text-muted" title="Set on the server. Saving a value here replaces it.">server default</span>;
  return (
    <div id={`setting-${s.key}`}
      className={cx('scroll-mt-24 rounded-lg transition-shadow duration-500', (s.type === 'bool' || WIDE.includes(s.key)) && 'sm:col-span-2',
        flash && 'ring-2 ring-brand-500/60 ring-offset-4 ring-offset-surface')}>
      {s.type === 'bool' ? (
        <>
          <div className="flex flex-wrap items-center gap-2"><SettingInput s={s} value={value} onChange={onChange} />{fromServer}</div>
          {HINTS[s.key] && <p className="mt-1 pl-[2.875rem] text-xs text-muted">{HINTS[s.key]}</p>}
        </>
      ) : (
        <Field label={<span className="flex flex-wrap items-center gap-2">{label}{fromServer}</span>} hint={HINTS[s.key]}>
          <SettingInput s={s} value={value} onChange={onChange} />
        </Field>
      )}
      {s.secret && s.source === 'database' && (
        <button type="button" className="mt-1 text-xs text-red-600 hover:underline dark:text-red-400" onClick={onClear}>Remove saved value</button>
      )}
    </div>
  );
}

/** A titled block of settings; with `collapsed` set it shows only its header until opened. */
function SettingsSection({ section, badge, collapsed, onToggle, tests, children }) {
  const head = (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <h3 className="text-sm font-medium">{section.title}</h3>
      {badge}
    </span>
  );
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className={cx('flex min-h-12 items-center justify-between gap-3 px-5 py-2', !collapsed && 'border-b border-line')}>
        {onToggle ? (
          <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform', collapsed && '-rotate-90')} aria-hidden />
            {head}
          </button>
        ) : head}
        {!collapsed && tests}
      </header>
      {!collapsed && <div className="space-y-4 p-5">{children}</div>}
    </section>
  );
}

/**
 * Admin → Settings → one page (`group`): its settings in sections, saved together with the bar that appears once
 * something changes. On Payment settings only the active provider is open; the others fold away. `focus` (a setting
 * key from the admin search) scrolls to that setting and highlights it.
 */
export default function SystemSettings({ group = 'app', focus = null }) {
  const toast = useToast();
  const page = settingsPage(group);
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get('/api/admin/settings') });
  const [values, setValues] = useState({});
  const [initial, setInitial] = useState({});
  const initialRef = useRef({});
  const [results, setResults] = useState({});
  const [opened, setOpened] = useState({});
  const [flash, setFlash] = useState(null);

  // Fresh values from the server; anything being edited stays as typed.
  useEffect(() => {
    if (!q.data) return;
    const fresh = Object.fromEntries(q.data.settings.map((s) => [s.key, s.secret ? '' : s.value]));
    setValues((cur) => {
      const next = { ...fresh };
      for (const k of Object.keys(cur)) if (cur[k] !== initialRef.current[k]) next[k] = cur[k];
      return next;
    });
    initialRef.current = fresh;
    setInitial(fresh);
  }, [q.data]);

  const save = useApiMutation((body) => api.put('/api/admin/settings', body), {
    success: 'Settings saved', invalidate: [['admin', 'settings'], ['admin', 'setup'], ['admin', 'attention']],
    // Typed secrets are not kept in the page once saved.
    onSuccess: (_d, body) => {
      const secrets = (q.data?.settings || []).filter((s) => s.secret && body?.values && s.key in body.values).map((s) => s.key);
      if (secrets.length) setValues((v) => ({ ...v, ...Object.fromEntries(secrets.map((k) => [k, ''])) }));
    },
  });
  const test = useApiMutation((service) => api.post(`/api/admin/settings/test/${service}`), {
    onSuccess: (d) => { setResults((r) => ({ ...r, [d.service]: d })); d.ok ? toast.success(d.message) : toast.error(d.message); },
  });
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast.success('Copied'); } catch { toast.error('Copy failed'); } };

  const settings = (q.data?.settings || []).filter((s) => s.group === page.group);
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
  const placed = new Set(page.sections.flatMap((s) => s.keys));
  const sections = [
    ...page.sections.map((sec) => ({ ...sec, items: sec.keys.map((k) => byKey[k]).filter(Boolean) })),
    { key: 'other', title: 'Other', items: settings.filter((s) => !placed.has(s.key)) },
  ].filter((sec) => sec.items.length);
  const provider = values['billing.provider'] || initial['billing.provider'] || 'stripe';
  const isOpen = (sec) => !sec.provider || sec.provider === provider || opened[sec.key];
  const dirtyKeys = settings.filter((s) => (values[s.key] ?? '') !== (initial[s.key] ?? '')).map((s) => s.key);

  // A setting picked in the search: open its section, then scroll to it and highlight it for a moment.
  useEffect(() => {
    if (!focus || !q.data) return undefined;
    const sec = page.sections.find((s) => s.keys.includes(focus));
    if (sec?.provider) setOpened((o) => ({ ...o, [sec.key]: true }));
    setFlash(focus);
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [focus, q.data, page]);
  useEffect(() => {
    if (!flash) return;
    const el = document.getElementById(`setting-${flash}`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    el?.querySelector('input, textarea, button[role="switch"], button[aria-haspopup]')?.focus({ preventScroll: true });
  }, [flash]);

  const setValue = (k) => (v) => setValues((cur) => ({ ...cur, [k]: v }));
  const onSave = () => save.mutate({ values: Object.fromEntries(dirtyKeys.map((k) => [k, values[k] ?? ''])) });

  const renderSection = (sec) => {
    const collapsed = !isOpen(sec);
    const tests = sec.test?.length ? (
      <div className="flex flex-wrap items-center gap-2">
        {sec.test.map((svc) => (
          <Button key={svc} variant="secondary" size="sm" icon={PlugZap} loading={test.isPending && test.variables === svc} onClick={() => test.mutate(svc)}>{TEST_LABEL[svc] || svc}</Button>
        ))}
      </div>
    ) : null;
    return (
      <SettingsSection key={sec.key} section={sec} collapsed={collapsed} tests={tests}
        onToggle={sec.provider && sec.provider !== provider ? () => setOpened((o) => ({ ...o, [sec.key]: !o[sec.key] })) : undefined}
        badge={sec.provider && sec.provider === provider ? <Badge color="green">In use</Badge> : null}>
        {sec.desc && <p className="text-sm text-fg-2">{sec.desc}</p>}
        {sec.key === 'stripe' && q.data && (
          <div className="rounded-md bg-surface-2 p-3 text-xs">
            <p className="text-muted">Webhook endpoint to add in Stripe (events: checkout.session.completed, customer.subscription.created, .updated and .deleted, invoice.paid, invoice.payment_failed):</p>
            <div className="mt-1 flex items-center gap-2"><code className="break-all font-mono">{q.data.webhookUrl}</code><button type="button" aria-label="Copy webhook URL" onClick={() => copy(q.data.webhookUrl)} className="text-muted hover:text-fg"><Copy className="size-3.5" /></button></div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {sec.items.map((s) => (
            <SettingRow key={s.key} s={s} value={values[s.key] ?? ''} onChange={setValue(s.key)} flash={flash === s.key}
              onClear={() => save.mutate({ clear: [s.key] })} />
          ))}
        </div>
        {sec.test?.some((svc) => results[svc]) && (
          <div className="space-y-0.5 text-xs">
            {sec.test.map((svc) => results[svc] && (
              <p key={svc} className={results[svc].ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>{TEST_LABEL[svc] || svc}: {results[svc].message} <span className="text-muted">({dateTime(results[svc].testedAt)})</span></p>
            ))}
          </div>
        )}
      </SettingsSection>
    );
  };

  const main = sections.filter((sec) => !sec.provider || sec.provider === provider);
  const others = sections.filter((sec) => sec.provider && sec.provider !== provider);

  return (
    <QueryState query={q}>
      {(d) => (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (dirtyKeys.length) onSave(); }}>
          {page.group === 'integrations' && <OAuthSetupGuide oauth={d.oauth} appUrl={d.appUrl} />}
          {main.map(renderSection)}
          {others.length > 0 && (
            <div className="space-y-3 pt-2">
              <div>
                <h3 className="text-sm font-medium">Other payment providers</h3>
                <p className="text-sm text-fg-2">Not in use now. Open one to fill it in before you switch.</p>
              </div>
              {others.map(renderSection)}
            </div>
          )}
          {page.group === 'ai' && <AiUsage />}
          <p className="text-xs text-muted">Values saved here replace the server defaults. Secrets are encrypted at rest and never sent back to the browser.</p>
          {dirtyKeys.length > 0 && (
            <div role="region" aria-label="Unsaved changes" className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
              <span className="text-sm">{dirtyKeys.length === 1 ? '1 unsaved change' : `${dirtyKeys.length} unsaved changes`}</span>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => setValues(initial)}>Discard</Button>
                <Button type="submit" loading={save.isPending}>Save changes</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </QueryState>
  );
}
