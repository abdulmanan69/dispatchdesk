import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Copy, FileText, MessageSquare, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { relative } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { errorToast } from '../../lib/hooks.js';
import { useConfirm } from '../../components/Modal.jsx';
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Loading, PageHeader, Select, Tabs, cx } from '../../components/ui.jsx';
import {
  TEMPLATE_CATEGORIES, byUse, categoryMeta, installStarter, invalidateFor, useStarterInfo, useTemplates, usesLabel,
} from '../../components/templates/templateApi.js';
import TemplateEditor from './TemplateEditor.jsx';

const SORTS = [
  ['used', 'Most used'],
  ['recent', 'Recently used'],
  ['name', 'Name'],
];
const time = (d) => (d ? new Date(d).getTime() : 0);
const SORTERS = {
  used: byUse,
  recent: (a, b) => time(b.lastUsedAt) - time(a.lastUsedAt) || byUse(a, b),
  name: (a, b) => a.name.localeCompare(b.name),
};

/** Email and text-message template library. */
export default function Templates() {
  const { can } = useAuth();
  const canEmail = can('email.use');
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = requested === 'sms' || !canEmail ? 'sms' : 'email';
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t); return n; }, { replace: true });
  const email = useTemplates('email', { enabled: canEmail });
  const sms = useTemplates('sms');

  return (
    <div>
      <PageHeader title="Templates" subtitle="Reusable emails and text messages. Merge fields fill in the carrier, broker, load and your own details when you use one." />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[
        ...(canEmail ? [{ value: 'email', label: 'Email', count: email.data?.items?.length }] : []),
        { value: 'sms', label: 'Text messages', count: sms.data?.items?.length },
      ]} />
      <Library key={tab} channel={tab} query={tab === 'email' ? email : sms} />
    </div>
  );
}

function Library({ channel, query }) {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const isEmail = channel === 'email';
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('used');
  const [editing, setEditing] = useState(null); // null | 'new' | template
  const [busy, setBusy] = useState(null);
  const starter = useStarterInfo(channel);
  const items = useMemo(() => query.data?.items || [], [query.data]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((t) => (!category || t.category === category)
        && (!q || t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q) || String(t.subject || '').toLowerCase().includes(q)))
      .sort(SORTERS[sort]);
  }, [items, search, category, sort]);

  const refresh = () => Promise.all(invalidateFor(channel).map((k) => qc.invalidateQueries({ queryKey: k })));
  const missing = starter.data ? starter.data.total - starter.data.installed : null;

  const addStarters = async () => {
    setBusy('starter');
    try {
      const res = await installStarter(channel);
      await refresh();
      if (res.created) toast.success(`Added ${res.created} starter ${res.created === 1 ? 'template' : 'templates'}`);
      else if (res.limited) toast.info('You have reached the template limit. Delete some templates to add more.');
      else toast.info('All starter templates are already in your library');
    } catch (err) { errorToast(toast, err); } finally { setBusy(null); }
  };

  const duplicate = async (t) => {
    setBusy(`dup:${t.id}`);
    try {
      await api.post('/api/templates/duplicate', { channel, id: t.id });
      await refresh();
      toast.success(`Duplicated "${t.name}"`);
    } catch (err) { errorToast(toast, err); } finally { setBusy(null); }
  };

  const remove = async (t) => {
    let message = 'It is removed from your library. Messages already sent are not affected.';
    if (isEmail) {
      try {
        const { sequenceSteps } = await api.get(`/api/templates/email/${t.id}/usage`);
        if (sequenceSteps) message = `${sequenceSteps} sequence ${sequenceSteps === 1 ? 'step uses' : 'steps use'} this template. A step without its own subject and message will have nothing to send.`;
      } catch { /* the delete itself still checks access */ }
    }
    if (!(await confirm({ title: `Delete "${t.name}"?`, message, danger: true }))) return;
    setBusy(`del:${t.id}`);
    try {
      await api.del(isEmail ? `/api/email/templates/${t.id}` : `/api/templates/text/${t.id}`);
      await refresh();
      toast.success('Template deleted');
    } catch (err) { errorToast(toast, err); } finally { setBusy(null); }
  };

  const Icon = isEmail ? FileText : MessageSquare;
  const noun = isEmail ? 'email' : 'text';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-fg-2">
          {isEmail
            ? 'Emails go out from your own connected mailbox. Your signature and an unsubscribe link are added automatically.'
            : 'DispatchDesk never sends texts. A template is copied and opened in Google Voice or your messaging app, and you press Send.'}
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" icon={BookOpen} loading={busy === 'starter'} disabled={missing === 0} onClick={addStarters}
            title={missing === 0 ? 'Every starter template is already in your library' : undefined}>
            {missing === 0 ? 'Starter pack added' : starter.data?.installed ? `Add ${missing} missing starters` : 'Add starter templates'}
          </Button>
          <Button icon={Plus} onClick={() => setEditing('new')}>New {noun} template</Button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
            <Input aria-label={`Search ${noun} templates`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or wording" className="pl-8" />
          </div>
          <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-[calc(50%-4px)] sm:w-44">
            <option value="">All categories</option>
            {TEMPLATE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className="w-[calc(50%-4px)] sm:w-44">
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </div>
      )}

      {query.isLoading ? <Loading label="Loading templates…" /> : query.isError ? <ErrorState error={query.error} onRetry={query.refetch} /> : !items.length ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState icon={Icon} title={`No ${noun} templates yet`}
            action={<div className="flex flex-wrap justify-center gap-2"><Button icon={BookOpen} loading={busy === 'starter'} onClick={addStarters}>Add starter templates</Button><Button variant="secondary" icon={Plus} onClick={() => setEditing('new')}>Write your own</Button></div>}>
            {isEmail
              ? 'The starter pack covers carrier outreach, follow-ups, onboarding, broker requests, detention, TONU, POD and invoices. Edit any of them to sound like you.'
              : 'The starter pack covers first touch, voicemail follow-up, check calls, ETA and POD requests, load offers, the location link and more.'}
          </EmptyState>
        </div>
      ) : !visible.length ? (
        <div className="rounded-xl border border-line bg-surface"><EmptyState title="No templates match">Try another search or category.</EmptyState></div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <TemplateCard key={t.id} t={t} isEmail={isEmail} busy={busy} onEdit={() => setEditing(t)} onDuplicate={() => duplicate(t)} onDelete={() => remove(t)} />
          ))}
        </ul>
      )}

      {editing && <TemplateEditor channel={channel} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TemplateCard({ t, isEmail, busy, onEdit, onDuplicate, onDelete }) {
  const cat = categoryMeta(t.category);
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-line bg-surface transition-ui hover:border-line-strong">
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 rounded-t-xl px-4 pb-2 pt-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-medium">{t.name}</h3>
          <Badge color={cat.color} className="shrink-0">{cat.label}</Badge>
        </div>
        {isEmail && <p className="mt-1 truncate text-[13px] text-fg-2">{t.subject}</p>}
        <p className={cx('mt-1.5 whitespace-pre-line break-words text-[13px] text-muted', isEmail ? 'line-clamp-3' : 'line-clamp-4')}>{t.body}</p>
      </button>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-1.5">
        <span className="min-w-0 truncate text-xs text-muted">
          {usesLabel(t.useCount)}{t.lastUsedAt ? ` · last ${relative(t.lastUsedAt)}` : ''}{t.starterKey ? ' · starter' : ''}
        </span>
        <div className="flex shrink-0 items-center">
          <IconButton icon={Pencil} label={`Edit ${t.name}`} onClick={onEdit} />
          <IconButton icon={Copy} label={`Duplicate ${t.name}`} onClick={onDuplicate} disabled={busy === `dup:${t.id}`} />
          <IconButton icon={Trash2} label={`Delete ${t.name}`} onClick={onDelete} disabled={busy === `del:${t.id}`} className="hover:text-red-600" />
        </div>
      </div>
    </li>
  );
}
