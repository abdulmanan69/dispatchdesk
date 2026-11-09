import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Copy, Trash2, BookOpen } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { label } from '../../lib/format.js';
import { Button, Card, EmptyState, Field, Input, Loading, ErrorState, Markdown, PageHeader, Select, Tabs, Textarea, cx } from '../../components/ui.jsx';

export const SCRIPT_CATEGORIES = ['cold_call', 'follow_up', 'voicemail', 'objection', 'onboarding', 'broker'];
export const MERGE_FIELDS = ['company', 'first_name', 'my_name', 'mc', 'city', 'state'];

/** Fill {{merge}} fields. Unknown values stay as visible placeholders like [company]. */
export function fillScript(body, values = {}) {
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (values[k] ? String(values[k]) : `[${k.replace('_', ' ')}]`));
}

const EMPTY = { id: null, name: '', category: 'cold_call', body: '' };

export default function CallScripts() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['call-scripts'], queryFn: () => api.get('/api/call-scripts') });
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [view, setView] = useState('edit');
  const bodyRef = useRef(null);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);

  useEffect(() => {
    if (selectedId === 'new') return;
    const s = items.find((x) => x.id === selectedId) || (selectedId == null ? items[0] : null);
    if (s) { setSelectedId(s.id); setForm({ id: s.id, name: s.name, category: s.category, body: s.body }); }
  }, [items, selectedId]);

  const inv = [['call-scripts']];
  const save = useApiMutation((f) => (f.id ? api.patch(`/api/call-scripts/${f.id}`, { name: f.name, category: f.category, body: f.body }) : api.post('/api/call-scripts', f)), {
    success: 'Script saved', invalidate: inv, onSuccess: (d) => setSelectedId(d.script.id),
  });
  const remove = useApiMutation((id) => api.del(`/api/call-scripts/${id}`), { success: 'Script deleted', invalidate: inv, onSuccess: () => setSelectedId(null) });
  const starter = useApiMutation(() => api.post('/api/call-scripts/starter'), {
    success: (d) => (d.created ? `Added ${d.created} starter ${d.created === 1 ? 'script' : 'scripts'}` : 'Starter scripts are already in your library'), invalidate: inv,
  });

  const insertField = (field) => {
    const el = bodyRef.current;
    const token = `{{${field}}}`;
    const start = el?.selectionStart ?? form.body.length;
    const end = el?.selectionEnd ?? form.body.length;
    const body = form.body.slice(0, start) + token + form.body.slice(end);
    setForm({ ...form, body });
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(start + token.length, start + token.length); } });
  };

  const startNew = () => { setSelectedId('new'); setForm(EMPTY); setView('edit'); };
  const duplicate = () => { setSelectedId('new'); setForm({ ...form, id: null, name: `${form.name} (copy)` }); };
  const sample = { company: 'Red River Transport LLC', first_name: 'Marcus', my_name: user?.name?.split(' ')[0], mc: '1184420', city: 'Shreveport', state: 'LA' };
  const dirty = form.id ? (() => { const s = items.find((x) => x.id === form.id); return s && (s.name !== form.name || s.body !== form.body || s.category !== form.category); })() : !!(form.name || form.body);

  const grouped = SCRIPT_CATEGORIES.map((c) => [c, items.filter((s) => s.category === c)]).filter(([, list]) => list.length);

  return (
    <div>
      <PageHeader title="Call scripts" subtitle="Talk tracks for cold calls, voicemails, objections and onboarding. They show up in the power dialer."
        actions={<>
          <Button variant="secondary" icon={BookOpen} loading={starter.isPending} onClick={() => starter.mutate()}>Add starter scripts</Button>
          <Button icon={Plus} onClick={startNew}>New script</Button>
        </>} />
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card bodyClass="p-2" className="self-start">
            {!items.length && selectedId !== 'new' ? (
              <EmptyState icon={BookOpen} title="No scripts yet" action={<Button size="sm" onClick={() => starter.mutate()}>Add starter scripts</Button>}>
                Start from seven tested talk tracks, or write your own.
              </EmptyState>
            ) : (
              <nav aria-label="Scripts" className="space-y-4 py-1">
                {selectedId === 'new' && (
                  <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm font-medium">{form.name || 'Untitled script'}</div>
                )}
                {grouped.map(([cat, list]) => (
                  <div key={cat}>
                    <div className="mb-1 px-3 text-xs text-muted">{label(cat)}</div>
                    {list.map((s) => (
                      <button key={s.id} type="button" onClick={() => { setSelectedId(s.id); setView('edit'); }}
                        className={cx('block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-ui', s.id === selectedId ? 'bg-surface-2 font-medium text-fg' : 'text-fg-2 hover:bg-surface-2/60 hover:text-fg')}>
                        {s.name}
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
            )}
          </Card>

          {(selectedId || items.length) ? (
            <Card
              title={<Tabs className="-mb-2 border-0" tabs={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} value={view} onChange={setView} />}
              actions={form.id && <>
                <Button size="sm" variant="ghost" icon={Copy} onClick={duplicate}>Duplicate</Button>
                <Button size="sm" variant="ghost" icon={Trash2} className="text-red-600" onClick={async () => {
                  if (await confirm({ title: 'Delete script?', message: `"${form.name}" will be removed from your library.`, danger: true })) remove.mutate(form.id);
                }}>Delete</Button>
              </>}
              footer={<div className="flex items-center justify-end gap-2">
                {dirty && <span className="mr-auto text-xs text-muted">Unsaved changes</span>}
                <Button loading={save.isPending} disabled={!form.name.trim() || !form.body.trim()} onClick={() => save.mutate(form)}>Save script</Button>
              </div>}>
              {view === 'edit' ? (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
                    <Field label="Name" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} /></Field>
                    <Field label="Category">
                      <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                        {SCRIPT_CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <div>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted">Insert field</span>
                      {MERGE_FIELDS.map((f) => (
                        <button key={f} type="button" onClick={() => insertField(f)}
                          className="rounded-md border border-line-strong px-2 py-0.5 font-mono text-xs text-fg-2 transition-ui hover:bg-surface-2 hover:text-fg">{`{{${f}}}`}</button>
                      ))}
                    </div>
                    <Textarea ref={bodyRef} aria-label="Script" rows={18} className="font-mono text-[13px] leading-6" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
                      placeholder={'## Opening\nHi {{first_name}}, this is {{my_name}}…'} />
                    <p className="mt-2 text-xs text-muted">Markdown works: ## headings, - lists, **bold**. Fields fill in from the carrier during a call.</p>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="mb-3 text-xs text-muted">Preview with a sample carrier (Red River Transport LLC)</p>
                  <Markdown text={fillScript(form.body, sample)} className="max-w-2xl" />
                </div>
              )}
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
