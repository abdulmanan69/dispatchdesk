import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, Trash2, Send, Globe, BookOpen, MessageSquare, PenLine, Phone, ShieldQuestion, Calculator, Copy, ExternalLink, AlertTriangle, KeyRound } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Markdown, PageHeader, Select, Switch, Tabs, Textarea, cx } from '../../components/ui.jsx';
import { dollars, relative, label as labelOf, EQUIPMENT } from '../../lib/format.js';
import { describeAiError, aiSourceLabel, AI_OFF, AI_SETTINGS } from './aiErrors.js';

/** useApiMutation for AI calls: errors get the AI wording and a link, and the usage counter refreshes. */
function useAiMutation(fn) {
  const toast = useToast();
  return useApiMutation(fn, {
    invalidate: [['ai', 'status']],
    onError: (err) => {
      const { message, links } = describeAiError(err);
      toast.error(message, links[0] ? { action: { label: links[0].label, href: links[0].to } } : undefined);
    },
  });
}

function AiErrorNote({ error }) {
  const { message, links } = describeAiError(error);
  return (
    <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      {message}
      {links.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-3">
          {links.map((l) => <Link key={l.to} to={l.to} className="font-medium underline">{l.label}</Link>)}
        </span>
      )}
    </div>
  );
}

function SourceChips({ sources }) {
  if (!sources?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {sources.map((s, i) => {
        const body = (
          <>
            <span className="font-mono text-[10.5px] text-muted">[{i + 1}]</span>
            {s.kind === 'web' ? <Globe className="size-3" /> : <BookOpen className="size-3" />}
            <span className="max-w-56 truncate">{s.title}</span>
            {s.date && <span className="text-muted">· {s.date}</span>}
            {s.url && <ExternalLink className="size-3 text-muted" />}
          </>
        );
        const cls = 'inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11.5px]';
        return s.url
          ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className={cx(cls, 'hover:border-brand-400')} title={s.url}>{body}</a>
          : <span key={i} className={cls} title="From your knowledge base">{body}</span>;
      })}
    </div>
  );
}

// Memoized: typing in the composer re-renders Chat, but unchanged messages (and their Markdown) are skipped.
const Message = memo(function Message({ m }) {
  const toast = useToast();
  const mine = m.role === 'user';
  return (
    <div className={cx('flex gap-3', mine && 'flex-row-reverse')}>
      <div className={cx('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', mine ? 'bg-surface-2' : 'bg-brand-600 text-white')}>
        {mine ? <MessageSquare className="size-3.5" /> : <Bot className="size-4" />}
      </div>
      <div className={cx('max-w-[min(720px,85%)] rounded-lg px-3.5 py-2.5', mine ? 'bg-brand-600/10 dark:bg-brand-400/10' : 'border border-line bg-surface')}>
        {mine ? <p className="whitespace-pre-wrap text-sm">{m.content}</p> : <Markdown text={m.content} />}
        {!mine && <SourceChips sources={m.sources} />}
        {!mine && (
          <button type="button" className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg" onClick={() => { navigator.clipboard?.writeText(m.content); toast.success('Copied'); }}>
            <Copy className="size-3" /> Copy
          </button>
        )}
      </div>
    </div>
  );
});

// AI answers with web research can take a while; the server gives up after about 2 minutes.
const AI_TIMEOUT = { timeoutMs: 180_000 };

function Chat({ status }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [activeId, setActiveId] = useState(null);
  const [text, setText] = useState('');
  const [useWeb, setUseWeb] = useState(false);
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [pending, setPending] = useState(null);
  const [notes, setNotes] = useState([]);
  const [failure, setFailure] = useState(null);
  const endRef = useRef(null);

  const convs = useQuery({ queryKey: ['ai', 'conversations'], queryFn: ({ signal }) => api.get('/api/ai/conversations', undefined, { signal }) });
  const conv = useQuery({ queryKey: ['ai', 'conversation', activeId], queryFn: ({ signal }) => api.get(`/api/ai/conversations/${activeId}`, undefined, { signal }), enabled: !!activeId });
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [conv.data, pending]);

  const remove = useApiMutation((id) => api.del(`/api/ai/conversations/${id}`), {
    invalidate: [['ai', 'conversations']], onSuccess: (_, id) => { if (id === activeId) setActiveId(null); },
  });

  const send = useApiMutation(async (content) => {
    let id = activeId;
    if (!id) {
      const { conversation } = await api.post('/api/ai/conversations', {});
      id = conversation.id;
      setActiveId(id);
    }
    return api.post(`/api/ai/conversations/${id}/messages`, { content, useWeb, useKnowledge }, AI_TIMEOUT).then((r) => ({ ...r, id }));
  }, {
    onSuccess: async (r) => {
      setPending(null);
      setNotes(r.notes || []);
      await qc.invalidateQueries({ queryKey: ['ai', 'conversation', r.id] });
      qc.invalidateQueries({ queryKey: ['ai', 'conversations'] });
      qc.invalidateQueries({ queryKey: ['ai', 'status'] });
    },
    onError: (err) => { setPending(null); setText((t) => t || pendingRef.current || ''); setFailure(err); },
  });
  const pendingRef = useRef('');

  const submit = (content) => {
    const c = (content ?? text).trim();
    if (!c || send.isPending) return;
    pendingRef.current = c;
    setPending(c);
    setText('');
    setNotes([]);
    setFailure(null);
    send.mutate(c);
  };

  const messages = activeId ? conv.data?.messages || [] : [];
  const pendingMessage = useMemo(() => (pending ? { role: 'user', content: pending } : null), [pending]);

  return (
    <div className="grid min-h-[70vh] gap-4 lg:grid-cols-[260px_1fr]">
      <Card bodyClass="p-2" className="lg:max-h-[78vh] lg:overflow-y-auto" title="Conversations" actions={<Button size="sm" variant="ghost" icon={Plus} onClick={() => { setActiveId(null); setNotes([]); setFailure(null); }}>New</Button>}>
        {convs.isLoading ? <Loading /> : !convs.data?.items?.length ? <p className="px-2 py-6 text-center text-xs text-muted">No conversations yet.</p> : (
          <ul className="space-y-0.5">
            {convs.data.items.map((c) => (
              <li key={c.id} className={cx('group flex items-center rounded-md', c.id === activeId ? 'bg-brand-600/10 dark:bg-brand-400/10' : 'hover:bg-surface-2')}>
                <button type="button" onClick={() => { setActiveId(c.id); setNotes([]); setFailure(null); }} className="min-w-0 flex-1 px-2.5 py-2 text-left">
                  <p className="truncate text-[13px] font-medium">{c.title}</p>
                  <p className="text-[11px] text-muted">{relative(c.updatedAt)} · {c._count?.messages ?? 0} msgs</p>
                </button>
                <button type="button" aria-label={`Delete ${c.title}`} className="mr-1 rounded p-1 text-muted opacity-0 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                  onClick={async () => { if (await confirm({ title: 'Delete conversation?', message: 'Messages are removed permanently.', danger: true })) remove.mutate(c.id); }}>
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card bodyClass="flex h-full flex-col p-0" className="flex flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-4 lg:max-h-[64vh]">
          {activeId && conv.isLoading && <Loading />}
          {!messages.length && !pending && (
            <div className="py-6">
              <EmptyState icon={Bot} title="Ask anything about dispatching">Prospecting, carrier onboarding, broker negotiation, rate per mile, paperwork. Answers cite your knowledge base and web sources when used.</EmptyState>
              <div className="mx-auto grid max-w-2xl gap-2 sm:grid-cols-2">
                {(status?.suggestions || []).map((s) => (
                  <button key={s} type="button" onClick={() => submit(s)} className="rounded-md border border-line px-3 py-2 text-left text-[13px] hover:border-brand-400 hover:bg-surface-2">{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => <Message key={m.id} m={m} />)}
          {pending && (
            <>
              <Message m={pendingMessage} />
              <div className="flex items-center gap-2 pl-10 text-sm text-muted"><span className="size-1.5 rounded-full bg-brand-600" aria-hidden /> Thinking{useWeb ? ' and researching the web' : ''}…</div>
            </>
          )}
          {notes.length > 0 && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{notes.join(' ')}</div>}
          {failure && <AiErrorNote error={failure} />}
          <div ref={endRef} />
        </div>
        <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the AI dispatcher…" aria-label="Message"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Switch checked={useKnowledge} onChange={setUseKnowledge} label={<span className="inline-flex items-center gap-1 text-[13px]"><BookOpen className="size-3.5" /> Knowledge base</span>} />
            <Switch checked={useWeb} onChange={setUseWeb} disabled={!status?.webSearch} label={<span className="inline-flex items-center gap-1 text-[13px]" title={status?.webSearch ? '' : 'An admin must configure a search provider'}><Globe className="size-3.5" /> Web research{!status?.webSearch && ' (not configured)'}</span>} />
            <Button type="submit" icon={Send} className="ml-auto" loading={send.isPending} disabled={!text.trim()}>Send</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function ToolResult({ children }) {
  if (!children) return null;
  return <div className="mt-4 rounded-md border border-line bg-surface-2/40 p-3.5">{children}</div>;
}

function EmailTool() {
  const toast = useToast();
  const [f, setF] = useState({ purpose: 'carrier_intro', tone: 'professional', notes: '' });
  const m = useAiMutation((v) => api.post('/api/ai/draft-email', v, AI_TIMEOUT));
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Purpose">
          <Select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
            <option value="carrier_intro">Carrier introduction</option>
            <option value="follow_up">Follow-up</option>
            <option value="broker_intro">Broker introduction</option>
            <option value="broker_rate">Broker rate negotiation</option>
            <option value="custom">Custom</option>
          </Select>
        </Field>
        <Field label="Tone">
          <Select value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}>
            <option value="professional">Professional</option><option value="friendly">Friendly</option><option value="direct">Direct</option>
          </Select>
        </Field>
      </div>
      <Field label="Details" className="mt-3" hint="Equipment, lanes, load details, what you offer."><Textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <Button className="mt-3" icon={PenLine} loading={m.isPending} onClick={() => m.mutate({ ...f, notes: f.notes || undefined })}>Draft email</Button>
      <ToolResult>{m.data && (
        <>
          <p className="text-sm"><span className="text-muted">Subject:</span> <strong>{m.data.subject}</strong></p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">{m.data.body}</pre>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="secondary" icon={Copy} onClick={() => { navigator.clipboard?.writeText(`${m.data.subject}\n\n${m.data.body}`); toast.success('Copied'); }}>Copy</Button>
            <Button size="sm" variant="secondary" to="/app/email?tab=compose">Open composer</Button>
          </div>
        </>
      )}</ToolResult>
    </div>
  );
}

function ScriptTool() {
  const [f, setF] = useState({ scenario: 'cold_call', notes: '' });
  const m = useAiMutation((v) => api.post('/api/ai/call-script', v, AI_TIMEOUT));
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Scenario">
          <Select value={f.scenario} onChange={(e) => setF({ ...f, scenario: e.target.value })}>
            <option value="cold_call">Cold call</option><option value="follow_up">Follow-up call</option><option value="voicemail">Voicemail</option>
            <option value="onboarding">Onboarding call</option><option value="custom">Custom</option>
          </Select>
        </Field>
        <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. 2-truck reefer fleet in GA" /></Field>
      </div>
      <Button className="mt-3" icon={Phone} loading={m.isPending} onClick={() => m.mutate({ ...f, notes: f.notes || undefined })}>Generate script</Button>
      <ToolResult>{m.data && <Markdown text={m.data.script} />}</ToolResult>
    </div>
  );
}

function ObjectionTool() {
  const [objection, setObjection] = useState('');
  const m = useAiMutation((v) => api.post('/api/ai/objection', v, AI_TIMEOUT));
  const examples = ['I already have a dispatcher.', 'Your percentage is too high.', 'I only use load boards myself.', 'Call me next month.'];
  return (
    <div>
      <Field label="What did the carrier say?"><Input value={objection} onChange={(e) => setObjection(e.target.value)} /></Field>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {examples.map((e) => <button key={e} type="button" onClick={() => setObjection(e)} className="rounded border border-line px-2 py-0.5 text-xs hover:border-brand-400">{e}</button>)}
      </div>
      <Button className="mt-3" icon={ShieldQuestion} disabled={!objection.trim()} loading={m.isPending} onClick={() => m.mutate({ objection })}>Get responses</Button>
      <ToolResult>{m.data && <Markdown text={m.data.answer} />}</ToolResult>
    </div>
  );
}

function LoadTool() {
  const [f, setF] = useState({ origin: '', destination: '', equipment: '', rate: '', loadedMiles: '', deadheadMiles: '', mpg: '6.5', fuelPricePerGallon: '', dispatchFeePercent: '', detentionHours: '', detentionRate: '' });
  const m = useAiMutation((v) => api.post('/api/ai/analyze-load', v, AI_TIMEOUT));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const n = m.data?.numbers;
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Origin"><Input value={f.origin} onChange={set('origin')} placeholder="Dallas, TX" /></Field>
        <Field label="Destination"><Input value={f.destination} onChange={set('destination')} placeholder="Atlanta, GA" /></Field>
        <Field label="Equipment"><Select value={f.equipment} onChange={set("equipment")}><option value="">Any</option>{EQUIPMENT.map((e) => <option key={e} value={labelOf(e)}>{labelOf(e)}</option>)}</Select></Field>
        <Field label="Total rate ($)" required><Input type="number" min="0" value={f.rate} onChange={set('rate')} /></Field>
        <Field label="Loaded miles" required><Input type="number" min="0" value={f.loadedMiles} onChange={set('loadedMiles')} /></Field>
        <Field label="Deadhead miles"><Input type="number" min="0" value={f.deadheadMiles} onChange={set('deadheadMiles')} /></Field>
        <Field label="Truck MPG"><Input type="number" min="0" step="0.1" value={f.mpg} onChange={set('mpg')} /></Field>
        <Field label="Diesel $/gal" hint="Enter the current price you pay"><Input type="number" min="0" step="0.01" value={f.fuelPricePerGallon} onChange={set('fuelPricePerGallon')} /></Field>
        <Field label="Dispatch fee %"><Input type="number" min="0" max="100" step="0.5" value={f.dispatchFeePercent} onChange={set('dispatchFeePercent')} /></Field>
      </div>
      <Button className="mt-3" icon={Calculator} disabled={!f.rate || !f.loadedMiles} loading={m.isPending}
        onClick={() => m.mutate(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')))}>Analyze load</Button>
      <ToolResult>{n && (
        <>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['Rate / loaded mile', n.ratePerMile != null ? dollars(n.ratePerMile) : '—'],
              ['All-in rate / mile', n.allInRatePerMile != null ? dollars(n.allInRatePerMile) : '—'],
              ['Fuel cost', n.fuelCost != null ? dollars(n.fuelCost) : 'Add MPG & diesel'],
              ['Estimated net', dollars(n.estimatedNet)],
              ['Total miles', n.totalMiles],
              ['Deadhead', `${n.deadheadPercent}%`],
              ['Dispatch fee', dollars(n.dispatchFee)],
              ['Net / total mile', n.netPerTotalMile != null ? dollars(n.netPerTotalMile) : '—'],
            ].map(([k, v]) => <div key={k} className="rounded bg-surface px-2.5 py-2"><p className="text-[11px] text-muted">{k}</p><p className="font-medium tabular">{v}</p></div>)}
          </div>
          <p className="mt-2 text-[11px] text-muted">Numbers are calculated exactly; the commentary below is AI-generated.</p>
          <div className="mt-3"><Markdown text={m.data.commentary} /></div>
        </>
      )}</ToolResult>
    </div>
  );
}

export default function AiDispatcher() {
  const [tab, setTab] = useState('chat');
  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: ({ signal }) => api.get('/api/ai/status', undefined, { signal }) });
  const s = status.data;
  const source = aiSourceLabel(s);
  return (
    <div>
      <PageHeader title="AI dispatcher" subtitle="Dispatch-trained assistant with your knowledge base and optional web research."
        actions={<>
          {source && <Badge color={s.source === 'byok' ? 'blue' : 'green'} title={s.model ? `Model ${s.model}` : undefined}>{source}</Badge>}
          <Button variant="secondary" icon={BookOpen} to="/app/ai/knowledge">Knowledge base ({(s?.knowledge?.own ?? 0) + (s?.knowledge?.global ?? 0)})</Button>
        </>} />
      {status.isLoading ? <Loading /> : !s?.configured ? (
        <Card>
          <EmptyState icon={AlertTriangle} title="AI is off" action={<Button icon={KeyRound} to={AI_SETTINGS}>Add your own key</Button>}>
            {AI_OFF} The assistant never returns canned answers, so it stays off until a provider is connected.
            <span className="mt-2 block">Meanwhile you can still <Link to="/app/ai/knowledge" className="font-medium text-brand-700 underline dark:text-brand-300">upload knowledge documents</Link>.</span>
          </EmptyState>
        </Card>
      ) : (
        <>
          <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[
            { value: 'chat', label: 'Chat' }, { value: 'email', label: 'Email drafts' }, { value: 'script', label: 'Call scripts' },
            { value: 'objection', label: 'Objections' }, { value: 'load', label: 'Load analysis' },
          ]} />
          {tab === 'chat' && <Chat status={s} />}
          {tab !== 'chat' && (
            <Card>
              {tab === 'email' && <EmailTool />}
              {tab === 'script' && <ScriptTool />}
              {tab === 'objection' && <ObjectionTool />}
              {tab === 'load' && <LoadTool />}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
