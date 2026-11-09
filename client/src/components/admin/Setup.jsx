import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, ExternalLink, FlaskConical, Settings2, Wand2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { Badge, Button, Card, Markdown, QueryState, Switch, cx } from '../ui.jsx';

const STATUS = {
  done: { color: 'green', label: 'Done', bar: 'bg-green-500' },
  partial: { color: 'amber', label: 'Partly set up', bar: 'bg-amber-500' },
  todo: { color: 'red', label: 'To do', bar: 'bg-red-500' },
  optional: { color: 'gray', label: 'Optional', bar: 'bg-line-strong' },
};

function CopyValue({ v }) {
  const toast = useToast();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted">{v.label}</p>
        <p className="break-all font-mono text-[13px] text-fg">{v.value}</p>
        {v.note && <p className="mt-1 text-xs text-muted">{v.note}</p>}
      </div>
      {v.copy && (
        <button type="button" aria-label={`Copy ${v.label}`} className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-fg"
          onClick={() => { navigator.clipboard?.writeText(v.value); toast.success('Copied'); }}>
          <Copy className="size-4" />
        </button>
      )}
    </div>
  );
}

function StripeReport({ report, onClose }) {
  return (
    <Modal open onClose={onClose} title={`Stripe set up (${report.mode} mode)`} size="md" footer={<Button onClick={onClose}>Done</Button>}>
      <ul className="space-y-2 text-sm">
        {report.plans.map((p) => (
          <li key={p.plan} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
            <span className="font-medium capitalize">{p.plan}</span>
            <span className="text-fg-2">{p.action}{p.reason ? ` (${p.reason})` : ''}</span>
            {p.priceId && <span className="w-full font-mono text-xs text-muted">{p.priceId}</span>}
          </li>
        ))}
        {report.webhook && (
          <li className="pt-1">
            <span className="font-medium">Webhook</span> <span className="text-fg-2">{report.webhook.action.replace('_', ' ')}</span>
            <p className="font-mono text-xs text-muted">{report.webhook.url}</p>
            {report.webhook.message && <p className="mt-1 text-amber-700 dark:text-amber-300">{report.webhook.message}</p>}
          </li>
        )}
      </ul>
    </Modal>
  );
}

function SetupCard({ it, onOpenSettings, open, onToggle }) {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [report, setReport] = useState(null);
  const [recreate, setRecreate] = useState(false);
  const st = STATUS[it.status] || STATUS.optional;
  const test = useApiMutation(() => api.post(`/api/admin/settings/test/${it.testService}`), {
    onSuccess: (d) => (d.ok ? toast.success(d.message) : toast.error(d.message)),
  });
  const provision = useApiMutation((body) => api.post('/api/admin/setup/stripe/provision', body), {
    invalidate: [['admin', 'setup'], ['admin', 'plans'], ['plans']],
    onSuccess: (d) => { setReport(d); qc.invalidateQueries({ queryKey: ['admin', 'settings'] }); },
  });
  return (
    <Card className="overflow-hidden" bodyClass="p-0">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-start gap-3 px-5 py-4 text-left transition-ui hover:bg-surface-2">
        <span className={cx('mt-1.5 size-2.5 shrink-0 rounded-full', st.bar)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{it.title}</span>
            <Badge color={st.color}>{st.label}</Badge>
            {it.required && <span className="text-xs text-muted">Required</span>}
          </span>
          <span className="mt-1 block text-sm text-fg-2">{it.summary}</span>
        </span>
        <ChevronDown className={cx('mt-1 size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-5 py-4">
          {it.steps.length > 0 && (
            <ol className="space-y-2">
              {it.steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs tabular text-fg-2">{i + 1}</span>
                  <Markdown text={s} className="min-w-0 flex-1 text-fg-2" />
                </li>
              ))}
            </ol>
          )}
          {it.values.length > 0 && <div className="grid gap-2 md:grid-cols-2">{it.values.map((v) => <CopyValue key={v.label} v={v} />)}</div>}
          <div className="flex flex-wrap items-center gap-2">
            {it.testService && <Button size="sm" variant="secondary" icon={FlaskConical} loading={test.isPending} onClick={() => test.mutate()}>Test</Button>}
            {it.settingsGroup && <Button size="sm" variant="secondary" icon={Settings2} onClick={onOpenSettings}>Open settings</Button>}
            {it.key === 'stripe' && (
              <>
                <Button size="sm" icon={Wand2} loading={provision.isPending} disabled={!it.canProvision}
                  title={it.canProvision ? undefined : 'Needs a saved Stripe secret key and an https APP_URL'}
                  onClick={async () => {
                    if (await confirm({ title: 'Create Stripe products, prices and webhook?', message: 'For each paid plan without a Stripe price, a product and recurring price are created from the plan’s price, and a webhook endpoint is registered for this site. Existing ones are reused.', confirmLabel: 'Create in Stripe' })) provision.mutate({ recreateWebhook: recreate });
                  }}>Create products, prices and webhook</Button>
                <Switch checked={recreate} onChange={setRecreate} label={<span className="text-xs text-fg-2">Replace existing webhook</span>} />
              </>
            )}
            {it.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-brand-700 hover:underline dark:text-brand-300">
                {l.label}<ExternalLink className="size-3.5" aria-hidden />
              </a>
            ))}
          </div>
        </div>
      )}
      {report && <StripeReport report={report} onClose={() => setReport(null)} />}
    </Card>
  );
}

export default function AdminSetup({ onTab }) {
  const q = useQuery({ queryKey: ['admin', 'setup'], queryFn: () => api.get('/api/admin/setup') });
  const [openKey, setOpenKey] = useState(null);
  return (
    <QueryState query={q}>
      {(d) => {
        const pct = d.progress.total ? Math.round((d.progress.done / d.progress.total) * 100) : 100;
        const firstOpen = openKey ?? d.items.find((i) => i.required && i.status !== 'done')?.key ?? null;
        return (
          <div className="space-y-4">
            <Card>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="font-medium">Setup checklist</h2>
                  <p className="mt-1 text-sm text-fg-2">Everything this site needs, checked against its real configuration. Full written guide: docs/SETUP_GUIDE.md in the repository.</p>
                </div>
                <p className="text-sm tabular text-fg-2">{d.progress.done} of {d.progress.total} required done</p>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Setup progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className={cx('h-full rounded-full transition-all', pct === 100 ? 'bg-green-500' : 'bg-brand-500')} style={{ width: `${pct}%` }} />
              </div>
              {pct === 100 && <p className="mt-2 flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400"><Check className="size-4" />All required setup is done. The rest is optional.</p>}
            </Card>
            {d.items.map((it) => (
              <SetupCard key={it.key} it={it} open={firstOpen === it.key} onToggle={() => setOpenKey(firstOpen === it.key ? '' : it.key)} onOpenSettings={() => onTab('settings')} />
            ))}
          </div>
        );
      }}
    </QueryState>
  );
}
