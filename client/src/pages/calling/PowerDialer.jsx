import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOff, Settings2, SkipForward, Check, RotateCcw, Mail, MessageSquare, ClipboardCheck, Puzzle, Send, Clock, Copy, ExternalLink, History, Reply } from 'lucide-react';
import { api } from '../../lib/api.js';
import { errorToast } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { relative, phoneFmt } from '../../lib/format.js';
import { Button, Card, EmptyState, ErrorState, Field, Input, Loading, LocalClock, Markdown, PageHeader, Select, Switch, Textarea, cx } from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { StageBadge } from '../../components/carriers/shared.jsx';
import CallingSettings from '../../components/calling/CallingSettings.jsx';
import { useDialer, ATTEMPT_LABEL } from '../../components/calling/useDialer.js';
import CallTimer, { secondsSince } from '../../components/calling/CallTimer.jsx';
import CarrierTimeInput from '../../components/calling/CarrierTimeInput.jsx';
import { businessDayAt, browserTz, formatInZone, nextMondayAt, tzOf, windowFor, zoneAbbr } from '../../components/calling/callWindow.js';
import { CALL_OUTCOMES, OUTCOME_HINTS, OUTCOME_HOTKEYS, ensureDoNotCall, outcomeForKey, outcomeLabel } from '../../components/calling/outcomes.js';
import { clearSession, loadSession, mergeResumed, saveSession } from '../../components/calling/dialerSession.js';
import TemplatePicker from '../../components/templates/TemplatePicker.jsx';
import { mergeText, scriptValues } from '../../components/templates/merge.js';
import { copyText, openTextLink, textHref } from '../../components/followups/followUpUtils.js';

const FINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'canceled']);
const STEP_ICON = { call: Phone, email: Mail, text: MessageSquare, task: ClipboardCheck };
const STEP_LABEL = { call: 'Call', email: 'Email', text: 'Text', task: 'Task' };
const QUICK_PROVIDERS = ['google_voice', 'eight_by_eight', 'ringcentral', 'dialpad', 'tel'];
/** After finishing a step, stay on the carrier only when the next step is an email or text to work right away. */
const STAY_ON = new Set(['email', 'text']);

/** Calls and texts need a phone and no do-not-call flag; email and task steps don't. */
function workable(i) {
  const type = i.step?.type;
  if (type === 'email' || type === 'task') return true;
  return !!i.carrier.phone && !i.carrier.doNotCall;
}

/** Build the work list for a source: today's queue, one sequence, or a prospect list. */
async function fetchSource(source, includeUpcoming) {
  if (source === 'queue') {
    const q = await api.get('/api/prospecting/queue', { includeHot: 'true' });
    return {
      items: q.items.map((it) => ({
        key: it.key, carrier: it.carrier, dueAt: it.dueAt,
        enrollmentId: it.sequence?.enrollmentId,
        step: it.sequence ? { type: it.sequence.type, number: it.sequence.stepNumber } : null,
        reason: it.sequence ? `${it.sequence.name} · step ${it.sequence.stepNumber} of ${it.sequence.stepCount} · ${STEP_LABEL[it.sequence.type] || it.sequence.type}${it.sequence.instructions ? `: ${it.sequence.instructions}` : ''}` : it.followUp ? `Follow-up${it.followUp.note ? `: ${it.followUp.note}` : ''}` : 'Hot lead',
      })),
    };
  }
  if (source.startsWith('seq:')) {
    const s = await api.get(`/api/sequences/${source.slice(4)}/session`, { includeUpcoming: String(includeUpcoming) });
    return {
      sequence: s.sequence, dueToday: s.dueToday, upcoming: s.upcoming,
      items: s.items.map((it) => ({
        key: it.enrollmentId, carrier: it.carrier, dueAt: it.dueAt, enrollmentId: it.enrollmentId, step: it.step, seq: it,
        reason: `${s.sequence.name} · step ${it.step.number} of ${it.sequence.stepCount} · ${STEP_LABEL[it.step.type] || it.step.type}${it.step.instructions ? `: ${it.step.instructions}` : ''}`,
      })),
    };
  }
  const l = await api.get(`/api/prospecting/lists/${source}`, { pageSize: 200 });
  return { items: l.items.map((it) => ({ key: it.carrier.id, carrier: it.carrier, reason: `List: ${l.list.name}` })) };
}

export default function PowerDialer() {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const seqParam = params.get('sequenceId');
  // ?listId= starts with a prospect list (the carrier list's "Call in the power dialer" creates one and links here).
  const listParam = params.get('listId');
  const linked = seqParam ? `seq:${seqParam}` : listParam || null;
  // A saved session resumes by itself unless the link asks for a different sequence or list; then it is offered instead.
  const [initial] = useState(() => {
    const saved = loadSession(user?.id);
    if (!saved) return { resume: null, offer: null };
    const conflicting = linked && saved.source !== linked;
    return conflicting ? { resume: null, offer: saved } : { resume: saved, offer: null };
  });
  const [offer, setOffer] = useState(initial.offer);
  const [source, setSourceState] = useState(initial.resume?.source || linked || 'queue');
  const [includeUpcoming, setIncludeUpcoming] = useState(initial.resume?.includeUpcoming || false);
  const [session, setSession] = useState(() => (initial.resume
    ? { items: initial.resume.items, index: initial.resume.index, results: initial.resume.results, skipped: initial.resume.skipped, resumed: true }
    : null));
  const [setupOpen, setSetupOpen] = useState(false);
  const lists = useQuery({ queryKey: ['prospect-lists'], queryFn: () => api.get('/api/prospecting/lists') });
  const sequences = useQuery({ queryKey: ['sequences'], queryFn: () => api.get('/api/sequences') });
  const settings = useQuery({ queryKey: ['telephony', 'settings'], queryFn: () => api.get('/api/telephony/settings') });
  const providers = useQuery({ queryKey: ['telephony', 'providers'], queryFn: () => api.get('/api/telephony/providers'), staleTime: 3600000 });

  useEffect(() => { if (linked && !session) setSourceState(linked); }, [linked]); // eslint-disable-line react-hooks/exhaustive-deps
  const setSource = (v) => {
    setSourceState(v);
    setIncludeUpcoming(false);
    if (v.startsWith('seq:')) setParams({ sequenceId: v.slice(4) }, { replace: true });
    else if (v !== 'queue') setParams({ listId: v }, { replace: true });
    else if (seqParam || listParam) setParams({}, { replace: true });
  };

  // Persist every change (position, results) for this tab; an offered session is kept until the user decides.
  useEffect(() => {
    if (!user?.id) return;
    if (session) saveSession(user.id, { source, includeUpcoming, session });
    else if (!offer) clearSession(user.id);
  }, [session, source, includeUpcoming, offer, user?.id]);

  // After a resume, refresh the remaining carriers against the source (work done elsewhere drops out).
  const resumed = !!session?.resumed;
  useEffect(() => {
    if (!resumed) return undefined;
    let cancelled = false;
    const s0 = session;
    if (s0.index < s0.items.length) toast.info(`Resumed your session at ${s0.index + 1} of ${s0.items.length}`);
    fetchSource(source, includeUpcoming)
      .then((fresh) => { if (!cancelled) setSession((s) => (s ? { ...s, ...mergeResumed(s, fresh.items), resumed: false } : s)); })
      .catch(() => { if (!cancelled) setSession((s) => (s ? { ...s, resumed: false } : s)); });
    return () => { cancelled = true; };
  }, [resumed]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useQuery({
    queryKey: ['dialer-source', source, includeUpcoming],
    enabled: !session,
    queryFn: () => fetchSource(source, includeUpcoming),
  });

  const s = settings.data?.settings;
  const providerLabel = providers.data?.items.find((p) => p.key === s?.provider)?.label;
  const sourceName = (src) => {
    if (src === 'queue') return "Today's call queue";
    if (src?.startsWith('seq:')) return `Sequence: ${(sequences.data?.items || []).find((x) => x.id === src.slice(4))?.name || 'sequence'}`;
    return `List: ${(lists.data?.items || []).find((l) => l.id === src)?.name || 'prospect list'}`;
  };
  const resumeOffer = () => {
    setSourceState(offer.source);
    setIncludeUpcoming(offer.includeUpcoming);
    setSession({ items: offer.items, index: offer.index, results: offer.results, skipped: offer.skipped, resumed: true });
    setOffer(null);
  };
  const current = session && session.index < session.items.length ? session.items[session.index] : null;

  return (
    <div>
      <PageHeader title="Power dialer" subtitle={session ? `${providerLabel || 'Your calling app'} · one click per call` : 'Work through calls, emails and texts one carrier at a time. Every call starts from your click.'}
        actions={<>
          <Button variant="ghost" icon={Puzzle} to="/app/extension">Chrome extension</Button>
          <Button variant="secondary" icon={Settings2} onClick={() => setSetupOpen(true)}>Calling setup</Button>
        </>} />

      {!session && offer && offer.index < offer.items.length && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
          <History className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 text-fg-2">Unfinished session: <span className="font-medium text-fg">{offer.index + 1} of {offer.items.length}</span> · {sourceName(offer.source)}</span>
          <Button size="sm" onClick={resumeOffer}>Resume</Button>
          <Button size="sm" variant="ghost" onClick={() => setOffer(null)}>Discard</Button>
        </div>
      )}

      {!session ? (
        <Start source={source} setSource={setSource} lists={lists} sequences={sequences} items={items} settings={s} providers={providers}
          includeUpcoming={includeUpcoming} setIncludeUpcoming={setIncludeUpcoming} providerLabel={providerLabel} onMoreProviders={() => setSetupOpen(true)}
          onStart={(list) => { setOffer(null); setSession({ items: list, index: 0, results: [], skipped: 0 }); }} />
      ) : !current ? (
        <Summary session={session} onRestart={() => setSession(null)} />
      ) : (
        // Keyed per carrier: every carrier starts with fresh state, and the previous dialer (and its polling) is gone.
        <Session key={`${session.index}:${current.key}`} session={session} setSession={setSession} autoAdvance={s?.autoAdvance !== false} provider={s?.provider} />
      )}

      <Modal open={setupOpen} onClose={() => setSetupOpen(false)} title="Calling setup" size="lg">
        <CallingSettings compact onSaved={() => setSetupOpen(false)} />
      </Modal>
    </div>
  );
}

function ProviderPicker({ settings, providers, onMore }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(null);
  const all = providers.data?.items || [];
  const quick = QUICK_PROVIDERS.map((k) => all.find((p) => p.key === k)).filter(Boolean);
  const current = settings?.provider;
  const choose = async (key) => {
    setSaving(key);
    try {
      const res = await api.put('/api/telephony/settings', { provider: key });
      qc.setQueryData(['telephony', 'settings'], res);
      toast.success(`Calls now go through ${all.find((p) => p.key === key)?.label}`);
    } catch (err) { errorToast(toast, err); } finally { setSaving(null); }
  };
  return (
    <div>
      <div className="mb-2 text-[13px] font-medium">Dial with</div>
      <div className="flex flex-wrap gap-1.5">
        {quick.map((p) => (
          <button key={p.key} type="button" aria-pressed={current === p.key} disabled={!!saving} onClick={() => choose(p.key)}
            className={cx('h-8 rounded-lg border px-2.5 text-[13px] transition-ui', current === p.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-fg-2 hover:bg-surface-2', saving === p.key && 'opacity-60')}>
            {p.key === 'tel' ? 'Phone app' : p.label}
          </button>
        ))}
        <button type="button" onClick={onMore} className="h-8 rounded-lg border border-dashed border-line-strong px-2.5 text-[13px] text-fg-2 transition-ui hover:bg-surface-2">More…</button>
      </div>
      {settings && !settings.configured && <p className="mt-2 text-xs text-signal-600">Pick how you place calls before you start. Google Voice opens in your browser with the number filled in.</p>}
      {current === 'google_voice' && <p className="mt-2 text-xs text-muted">Stay signed in at voice.google.com. Press Call there after it opens.</p>}
    </div>
  );
}

function Start({ source, setSource, lists, sequences, items, settings, providers, providerLabel, includeUpcoming, setIncludeUpcoming, onMoreProviders, onStart }) {
  const data = items.data || { items: [] };
  const list = data.items;
  const workableItems = list.filter(workable);
  const nowCallable = workableItems.filter((i) => windowFor(i.carrier).callable).length;
  const activeSeqs = (sequences.data?.items || []).filter((x) => x.active);
  const isSeq = source.startsWith('seq:');
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card title="Who to work" actions={
        <Select aria-label="Call list" value={source} onChange={(e) => setSource(e.target.value)} className="w-52 sm:w-60">
          <option value="queue">Today's call queue</option>
          {activeSeqs.map((x) => <option key={x.id} value={`seq:${x.id}`}>Sequence: {x.name}</option>)}
          {lists.data?.items.map((l) => <option key={l.id} value={l.id}>List: {l.name}</option>)}
        </Select>
      } bodyClass="p-0">
        {isSeq && data.upcoming > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3 text-sm">
            <span className="text-fg-2">{data.dueToday} due today · {data.upcoming} scheduled later</span>
            <Switch checked={includeUpcoming} onChange={setIncludeUpcoming} label="Include later steps" />
          </div>
        )}
        {items.isLoading ? <Loading label="Loading carriers…" /> : items.isError ? <ErrorState error={items.error} onRetry={items.refetch} /> : !list.length ? (
          <EmptyState icon={Phone} title={isSeq ? 'Nothing due in this sequence' : 'Nobody to call here'} action={<Button variant="secondary" to={isSeq ? '/app/discover' : '/app/prospecting'}>{isSeq ? 'Find leads' : 'Open prospecting'}</Button>}>
            {isSeq ? 'Enroll carriers from Find carriers or the lead generator, or include later steps.' : 'Enroll carriers in a sequence, schedule follow-ups, or pick a prospect list.'}
          </EmptyState>
        ) : (
          <ul className="max-h-[480px] divide-y divide-line overflow-y-auto">
            {list.map((i) => {
              const Icon = STEP_ICON[i.step?.type] || Phone;
              const ok = workable(i);
              const win = windowFor(i.carrier);
              return (
                <li key={i.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3">
                  <Icon className="size-4 text-muted" aria-label={STEP_LABEL[i.step?.type] || 'Call'} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{i.carrier.companyName}</div>
                    <div className="truncate text-xs text-muted">{i.reason}</div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <LocalClock timezone={tzOf(i.carrier)} />
                    <span className={cx('text-xs', !ok ? 'text-red-600 dark:text-red-400' : win.callable ? 'text-fg-2' : 'text-muted')}>
                      {i.carrier.doNotCall && !ok ? 'Do not call' : !ok ? 'No phone' : i.dueAt && new Date(i.dueAt) > new Date(Date.now() + 3600000) ? `Due ${relative(i.dueAt)}` : win.text}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <div className="space-y-4">
        <Card title="Session">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-fg-2">Carriers</dt><dd className="font-mono tabular">{workableItems.length}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-2">Inside calling hours now</dt><dd className="font-mono tabular">{nowCallable}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-2">Calls go through</dt><dd>{providerLabel || '—'}</dd></div>
          </dl>
          <div className="mt-5 border-t border-line pt-4">
            <ProviderPicker settings={settings} providers={providers} onMore={onMoreProviders} />
          </div>
          <Button className="mt-5 w-full" size="lg" icon={Phone} disabled={!workableItems.length} onClick={() => onStart(workableItems)}>Start</Button>
          <p className="mt-3 text-xs text-muted">Shortcuts: <Kbd>C</Kbd> call, <Kbd>1</Kbd>–<Kbd>9</Kbd> and <Kbd>0</Kbd> outcome, <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> save, <Kbd>S</Kbd> skip</p>
          <p className="mt-2 text-xs text-muted">Calling hours: weekdays 8 AM to 7 PM in each carrier's local time.</p>
        </Card>
        <Card bodyClass="flex items-start gap-3 p-4">
          <Puzzle className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <p className="text-[13px] text-fg-2">Calling from carrier websites or load boards? <Link to="/app/extension" className="font-medium text-fg underline-offset-2 hover:underline">Download the Chrome extension</Link>. Its call button dials through the same provider.</p>
        </Card>
      </div>
    </div>
  );
}

function Kbd({ children }) {
  return <kbd className="rounded border border-line-strong bg-surface px-1 font-mono text-[11px] text-fg-2">{children}</kbd>;
}

/** The merged script, memoized so typing notes or ticking timers never re-parse the Markdown. */
const ScriptView = memo(function ScriptView({ text }) {
  return <Markdown text={text} className="max-h-[420px] overflow-y-auto" />;
});

const FOLLOW_UP_CHOICES = [['auto', 'Automatic'], ['next', 'Next business day 9 AM'], ['two_days', 'In 2 business days'], ['week', 'Next Monday 9 AM'], ['custom', 'Pick a time'], ['none', 'None']];

function followUpDate(choice, tz, customAt) {
  if (choice === 'next') return businessDayAt(tz, 1, 9);
  if (choice === 'two_days') return businessDayAt(tz, 2, 9);
  if (choice === 'week') return nextMondayAt(tz, 9);
  if (choice === 'custom' && customAt) return new Date(customAt);
  return null;
}

function Session({ session, setSession, autoAdvance, provider }) {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const item = session.items[session.index];
  const c = item.carrier;
  const tz = tzOf(c);
  const win = windowFor(c);
  const d = useDialer();
  const eid = item.enrollmentId;
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [followUp, setFollowUp] = useState('auto');
  const [customAt, setCustomAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedCall, setSavedCall] = useState(null);
  const [marking, setMarking] = useState(false);
  const [scriptId, setScriptId] = useState('');
  const dialedFor = useRef(null);

  const detail = useQuery({ queryKey: ['carrier', c.id], queryFn: () => api.get(`/api/carriers/${c.id}`) });
  const scripts = useQuery({ queryKey: ['call-scripts'], queryFn: () => api.get('/api/call-scripts'), retry: false });
  const enrollment = useQuery({
    queryKey: ['enrollment', eid], enabled: !!eid,
    queryFn: () => api.get(`/api/sequences/enrollments/${eid}`),
    initialData: item.seq ? { item: item.seq } : undefined,
  });
  const scriptList = scripts.data?.items || [];
  const script = scriptList.find((x) => x.id === scriptId) || scriptList[0];
  const seqItem = enrollment.data?.item;
  // Which kind of work this carrier needs right now. Non-sequence items are always calls.
  const stage = !eid ? 'call' : seqItem ? (seqItem.step?.type || 'done') : (item.step?.type || 'call');

  const att = d.attempt;
  const reported = att?.durationSec != null;
  // Only an attempt started for this carrier counts (never one left over from a previous carrier).
  const mine = !!att && dialedFor.current === c.id && (!att.carrier || att.carrier.id === c.id);

  // Bridge call logged automatically (no answer / busy): count it and move on.
  useEffect(() => {
    if (mine && att.callId && !savedCall && FINAL.has(att.status)) {
      setSavedCall({ id: att.callId, outcome: att.status === 'busy' ? 'busy' : 'no_answer', automatic: true, durationSec: att.durationSec ?? null });
    }
  }, [att, mine, savedCall]);

  // Everything done for this carrier (call outcome, email sent, text skipped...), reported to the summary on Next.
  const log = useRef([]);
  const record = useCallback((o) => { log.current = [...log.current, { outcome: o, carrier: c.companyName }]; }, [c.companyName]);
  const next = useCallback(() => {
    const done = log.current;
    log.current = [];
    setSession((s) => ({ ...s, index: s.index + 1, results: [...s.results, ...done], skipped: done.length ? s.skipped : s.skipped + 1 }));
  }, [setSession]);
  /** Called after any step action with the refreshed enrollment item. */
  const settle = useCallback((fresh) => {
    if (fresh?.step && STAY_ON.has(fresh.step.type)) return;
    next();
  }, [next]);

  /** After a call in a sequence: stay on this carrier when the next step is an email or text to work now. */
  const afterCall = useCallback(async (o) => {
    record(o);
    if (!eid) { if (autoAdvance) next(); return; }
    try {
      const fresh = await api.get(`/api/sequences/enrollments/${eid}`);
      qc.setQueryData(['enrollment', eid], fresh);
      if (autoAdvance && !(fresh.item.step && STAY_ON.has(fresh.item.step.type))) next();
    } catch { if (autoAdvance) next(); }
  }, [eid, autoAdvance, next, qc, record]);

  useEffect(() => {
    if (savedCall?.automatic) { const t = setTimeout(() => afterCall(savedCall.outcome), 1200); return () => clearTimeout(t); }
    return undefined;
  }, [savedCall, afterCall]);

  const call = () => {
    if (c.doNotCall || d.dialing || savedCall) return;
    dialedFor.current = c.id;
    d.dial({ carrierId: c.id });
  };

  const save = async () => {
    if (!outcome || saving || savedCall || stage !== 'call') return;
    setSaving(true);
    try {
      const followUpAt = followUpDate(followUp, tz, customAt);
      const ownAttempt = mine && !att.callId ? att : null;
      const durationSec = ownAttempt && !reported ? Math.round(secondsSince(ownAttempt.createdAt)) : undefined;
      const res = await api.post('/api/calls', {
        carrierId: c.id, outcome, notes,
        attemptId: ownAttempt?.id,
        durationSec,
        followUpAt: followUpAt ? followUpAt.toISOString() : null,
        autoFollowUp: followUp !== 'none',
      });
      setSavedCall({ id: res.call.id, outcome, durationSec: reported ? att.durationSec : durationSec ?? null });
      let dncOn = false;
      if (outcome === 'do_not_call') {
        try {
          await ensureDoNotCall(c.id, res);
          dncOn = true;
          // Later items for this carrier in the session become unworkable right away.
          setSession((s) => ({ ...s, items: s.items.map((i) => (i.carrier.id === c.id ? { ...i, carrier: { ...i.carrier, doNotCall: true } } : i)) }));
        } catch (err) { toast.error(`Call saved, but do-not-call could not be turned on: ${err.message}`); }
      }
      qc.invalidateQueries({ queryKey: ['queue'] });
      qc.invalidateQueries({ queryKey: ['carrier', c.id] });
      const when = res.followUp ? ` · follow-up ${formatInZone(res.followUp.dueAt, browserTz(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
      if (outcome === 'wrong_number') toast.info(`${c.companyName}: wrong number logged. Update the phone on the carrier profile.`);
      else if (outcome === 'do_not_call') { if (dncOn) toast.success(`${c.companyName}: do-not-call is on and its sequences are stopped.`); }
      else toast.success(`${c.companyName}: ${outcomeLabel(outcome)}${when}`);
      await afterCall(outcome);
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setSaving(false);
    }
  };

  /**
   * The carrier answered outside reply detection (a text to your number, an email reply, a call back):
   * POST /api/carriers/:id/replied stops its running sequences, logs the reply and adds a "Reply from" follow-up.
   */
  const markReplied = async () => {
    if (marking || saving) return;
    const ok = await confirm({
      title: `Mark ${c.companyName} as replied?`,
      message: 'This stops its running sequences, logs the reply and adds a "Reply from" follow-up.',
      confirmLabel: 'Mark replied',
    });
    if (!ok) return;
    setMarking(true);
    try {
      const res = await api.post(`/api/carriers/${c.id}/replied`);
      for (const key of [['carrier', c.id], ['enrollment', eid], ['queue'], ['follow-ups'], ['emails']]) qc.invalidateQueries({ queryKey: key });
      toast.success(res.stopped ? `${c.companyName}: reply logged and ${res.stopped} sequence${res.stopped === 1 ? '' : 's'} stopped` : `${c.companyName}: reply logged`);
      record('replied');
      next();
    } catch (err) {
      errorToast(toast, err);
      setMarking(false);
    }
  };

  // Keyboard shortcuts, bound once. They read the latest state through a ref and are off while typing or in a dialog.
  const keys = useRef({});
  keys.current = { stage, savedCall, save, call, next, setOutcome };
  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector('[role="dialog"]')) return;
      const k = keys.current;
      const el = e.target;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || el.getAttribute?.('role') === 'combobox';
      if (k.stage === 'call' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); k.save(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || k.stage !== 'call' || k.savedCall) return;
      const o = outcomeForKey(e.key);
      if (o) k.setOutcome(o);
      else if (e.key.toLowerCase() === 'c') k.call();
      else if (e.key.toLowerCase() === 's') k.next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const live = mine && !FINAL.has(att.status) && att.status !== 'dialed';
  // Warn before a reload or tab close would drop a live call or an outcome that is not saved yet.
  const unsaved = !savedCall && (live || (stage === 'call' && (!!outcome || !!notes.trim())));
  useEffect(() => {
    if (!unsaved) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  const carrier = detail.data?.carrier;
  const contacts = carrier?.contacts;
  const scriptText = useMemo(
    () => (script ? mergeText(script.body, scriptValues({ carrier: c, contacts, user }), { missing: 'bracket' }) : ''),
    [script, c, contacts, user],
  );
  const lastNotes = carrier?.notes?.slice(0, 3) || [];
  const lastCalls = carrier?.calls?.slice(0, 3) || [];
  const StageIcon = STEP_ICON[stage] || Check;
  const planned = followUpDate(followUp, tz, customAt);
  const myTz = browserTz();

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between text-sm text-fg-2">
          <span className="font-mono text-xs tabular">{session.index + 1} of {session.items.length}</span>
          <div className="mx-4 h-1 flex-1 rounded-full bg-surface-2">
            <div className="h-1 rounded-full bg-brand-600 transition-ui" style={{ width: `${(session.index / session.items.length) * 100}%` }} />
          </div>
          <button type="button" className="text-xs text-muted hover:text-fg"
            onClick={() => { const done = log.current; log.current = []; setSession((s) => ({ ...s, index: s.items.length, results: [...s.results, ...done] })); }}>End session</button>
        </div>

        <Card>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              {/* New tab: the session stays where it is. */}
              <Link to={`/app/carriers/${c.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-xl font-medium tracking-[-0.01em] hover:underline">
                <span className="truncate">{c.companyName}</span><ExternalLink className="size-3.5 shrink-0 text-muted" aria-label="Opens in a new tab" />
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-2">
                {c.mcNumber && <span className="font-mono text-[13px]">MC {c.mcNumber}</span>}
                {c.dotNumber && <span className="font-mono text-[13px]">DOT {c.dotNumber}</span>}
                {(c.city || c.state) && <span>{[c.city, c.state].filter(Boolean).join(', ')}</span>}
                <StageBadge stage={c.stage} />
              </div>
              <p className="mt-2 text-sm text-muted">{item.reason}</p>
            </div>
            <div className="shrink-0 text-left sm:text-right">
              <LocalClock timezone={tz} className="text-sm" />
              <div className={cx('mt-0.5 text-xs', win.callable ? 'text-fg-2' : 'text-signal-600')}>{win.text}</div>
            </div>
          </div>

          {eid && seqItem && (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
              <StageIcon className="size-4 text-muted" aria-hidden />
              {seqItem.step ? <>Step {seqItem.step.number} of {seqItem.sequence.stepCount} · {STEP_LABEL[seqItem.step.type]} · day {seqItem.step.day}
                {seqItem.dueAt && new Date(seqItem.dueAt) > new Date(Date.now() + 3600000) && <span className="inline-flex items-center gap-1 text-muted"><Clock className="size-3.5" aria-hidden />due {relative(seqItem.dueAt)}</span>}</>
                : <>Sequence finished for this carrier</>}
              {seqItem.step && !savedCall && (
                <Button size="sm" variant="ghost" icon={Reply} className="ml-auto" loading={marking} disabled={saving} onClick={markReplied}
                  title="The carrier answered by text, email or phone: stop the sequence and log the reply">Mark replied</Button>
              )}
            </div>
          )}

          {stage === 'call' && (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-5">
              {c.doNotCall ? (
                <p className="text-sm text-red-600 dark:text-red-400">Marked do-not-call. Skip this carrier.</p>
              ) : !c.phone ? (
                <p className="text-sm text-fg-2">No phone number on file.</p>
              ) : (
                <>
                  <Button size="lg" icon={Phone} onClick={call} loading={d.dialing} disabled={!!savedCall}>Call {phoneFmt(c.phone)}</Button>
                  {live && <Button variant="secondary" icon={PhoneOff} onClick={d.cancel}>Hang up</Button>}
                  {mine && (
                    <span className="flex items-center gap-2 text-sm text-fg-2" role="status">
                      <span className={cx('size-1.5 rounded-full', live ? 'bg-brand-600' : 'bg-line-strong')} aria-hidden />
                      {ATTEMPT_LABEL[att.status] || att.status}
                      <CallTimer since={att.createdAt} seconds={savedCall ? (savedCall.durationSec ?? 0) : reported ? att.durationSec : undefined} />
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </Card>

        {stage === 'call' && (
          <Card title="Outcome">
            <fieldset disabled={!!savedCall}>
              <legend className="sr-only">Call outcome</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-5">
                {CALL_OUTCOMES.map((o, i) => (
                  <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}
                    className={cx('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-ui',
                      outcome === o ? 'border-fg/30 bg-surface-2 font-medium text-fg' : 'border-line text-fg-2 hover:bg-surface-2/60',
                      o === 'do_not_call' && outcome === o && 'border-red-400/60 text-red-700 dark:text-red-300')}>
                    {outcomeLabel(o)}<Kbd>{OUTCOME_HOTKEYS[i]}</Kbd>
                  </button>
                ))}
              </div>
              {outcome && <p className="mt-2 text-xs text-muted">{OUTCOME_HINTS[outcome]}</p>}
              <Field label="Notes" className="mt-4"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Equipment, lanes, rate expectations, who you spoke with" /></Field>
              {!['wrong_number', 'do_not_call', 'not_interested', 'converted'].includes(outcome) && (
                <div className="mt-4">
                  <div className="mb-2 text-[13px] font-medium">Next follow-up</div>
                  <div className="flex flex-wrap gap-2">
                    {FOLLOW_UP_CHOICES.map(([k, l]) => (
                      <button key={k} type="button" aria-pressed={followUp === k} onClick={() => setFollowUp(k)}
                        className={cx('h-8 rounded-lg border px-3 text-[13px] transition-ui', followUp === k ? 'border-fg/30 bg-surface-2 text-fg' : 'border-line text-fg-2 hover:bg-surface-2/60')}>{l}</button>
                    ))}
                  </div>
                  {followUp === 'custom' && <CarrierTimeInput className="mt-2" aria-label="Follow-up time" value={customAt} onChange={setCustomAt} timezone={tz} />}
                  {planned && followUp !== 'custom' && (
                    <p className="mt-2 text-xs text-muted">
                      {formatInZone(planned, tz || myTz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} {tz ? `carrier time (${zoneAbbr(tz, planned)})` : 'your time'}
                      {tz && formatInZone(planned, tz) !== formatInZone(planned, myTz) && <> = {formatInZone(planned, myTz)} your time</>}
                    </p>
                  )}
                  {followUp === 'auto' && <p className="mt-2 text-xs text-muted">About a day from now, moved into 9 AM to 5 PM on a weekday in the carrier's time. Not interested, converted, wrong number and do not call schedule nothing.</p>}
                </div>
              )}
            </fieldset>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <Button variant="ghost" icon={SkipForward} onClick={() => next()} disabled={!!savedCall}>Skip</Button>
              {savedCall ? (
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 text-sm text-fg-2"><Check className="size-4 text-brand-600" />{savedCall.automatic ? 'Logged automatically' : 'Saved'}: {outcomeLabel(savedCall.outcome)}</span>
                  {!autoAdvance || savedCall.automatic ? (
                    // An automatic log is counted after a short delay; moving on sooner must still count the call.
                    <Button onClick={() => { if (savedCall.automatic && !log.current.length) record(savedCall.outcome); next(); }}>Next carrier</Button>
                  ) : null}
                </div>
              ) : (
                <Button onClick={save} loading={saving} disabled={!outcome || (followUp === 'custom' && !customAt && !['wrong_number', 'do_not_call', 'not_interested', 'converted'].includes(outcome))}>{autoAdvance ? 'Save and next' : 'Save call'}</Button>
              )}
            </div>
          </Card>
        )}

        {stage === 'email' && seqItem && <EmailStep key={`${eid}-${seqItem.step.index}`} item={seqItem} record={record} settle={settle} onLater={next} />}
        {stage === 'text' && seqItem && <TextStep key={`${eid}-${seqItem.step.index}`} item={seqItem} provider={provider} record={record} settle={settle} onLater={next} />}
        {stage === 'task' && seqItem && <TaskStep key={`${eid}-${seqItem.step.index}`} item={seqItem} record={record} settle={settle} onLater={next} />}
        {stage === 'done' && (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-fg-2">No more steps for {c.companyName} in this sequence.</p>
              <Button onClick={() => next()}>Next carrier</Button>
            </div>
          </Card>
        )}
        {eid && !seqItem && stage !== 'call' && <Card><Loading /></Card>}
      </div>

      <div className="min-w-0 space-y-4">
        <Card title="Script" actions={scriptList.length > 1 && (
          <Select aria-label="Choose script" value={script?.id || ''} onChange={(e) => setScriptId(e.target.value)} className="h-8 w-44">
            {scriptList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        )}>
          {scripts.isLoading ? <Loading /> : script ? (
            <ScriptView text={scriptText} />
          ) : (
            <p className="text-sm text-fg-2">No call scripts yet. <Link to="/app/call-scripts" target="_blank" rel="noopener" className="text-fg underline underline-offset-2">Write or add starter scripts</Link> to see them here while you call.</p>
          )}
        </Card>
        <Card title="History">
          {detail.isLoading ? <Loading /> : !lastCalls.length && !lastNotes.length ? <p className="text-sm text-muted">No calls or notes yet</p> : (
            <ul className="space-y-3 text-sm">
              {lastCalls.map((x) => <li key={x.id}><span className="font-mono text-xs text-muted">{relative(x.calledAt)}</span><div>{outcomeLabel(x.outcome)}{x.notes ? `: ${x.notes}` : ''}</div></li>)}
              {lastNotes.map((n) => <li key={n.id}><span className="font-mono text-xs text-muted">Note · {relative(n.createdAt)}</span><div className="line-clamp-3">{n.body}</div></li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Run a sequence step action (skip-step / complete-step) and refresh the enrollment. `stepIndex` is the step on screen:
 * when the scheduler or another tab already moved on, the server answers 409 instead of acting on the next step.
 */
function useStepAction(eid, stepIndex) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  /** Returns the refreshed work item, or undefined on error. */
  const run = async (action) => {
    setBusy(action);
    try {
      await api.post(`/api/sequences/enrollments/${eid}/${action}`, stepIndex != null ? { stepIndex } : undefined);
      qc.invalidateQueries({ queryKey: ['queue'] });
      const fresh = await api.get(`/api/sequences/enrollments/${eid}`);
      qc.setQueryData(['enrollment', eid], fresh);
      return fresh.item;
    } catch (err) {
      errorToast(toast, err);
      // The screen was stale (409: the step already moved on; 400: the enrollment stopped): show the current step.
      if (err?.status === 409 || err?.status === 400) {
        qc.invalidateQueries({ queryKey: ['enrollment', eid] });
        qc.invalidateQueries({ queryKey: ['queue'] });
      }
      return undefined;
    } finally { setBusy(null); }
  };
  return { busy, run };
}

function StepFooter({ children, onLater, laterLabel = 'Leave on schedule' }) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <Button variant="ghost" onClick={onLater}>{laterLabel}</Button>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function EmailStep({ item, record, settle, onLater }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [subject, setSubject] = useState(item.email?.subject || '');
  const [body, setBody] = useState(item.email?.body || '');
  const [accountId, setAccountId] = useState('');
  const [sending, setSending] = useState(false);
  const { busy, run } = useStepAction(item.enrollmentId, item.step?.index);
  const accounts = useQuery({ queryKey: ['email', 'accounts'], queryFn: () => api.get('/api/email/accounts') });
  const connected = (accounts.data?.items || []).filter((a) => a.status === 'connected');
  const to = item.email?.to;
  const blocked = item.email?.blocked || (!to ? 'No email address on file for this carrier' : null);

  const send = async () => {
    setSending(true);
    try {
      const res = await api.post(`/api/sequences/enrollments/${item.enrollmentId}/send-email`, { subject, body, stepIndex: item.step.index, accountId: accountId || null });
      qc.setQueryData(['enrollment', item.enrollmentId], { item: res.item });
      qc.invalidateQueries({ queryKey: ['carrier', item.carrier.id] });
      toast.success(res.outcome === 'sent' ? `Email sent to ${to}` : res.message);
      record('email_sent');
      settle(res.item);
    } catch (err) {
      errorToast(toast, err);
      if (err.status === 409) qc.invalidateQueries({ queryKey: ['enrollment', item.enrollmentId] });
    } finally { setSending(false); }
  };

  return (
    <Card title={<span className="flex items-center gap-2 text-sm font-medium"><Mail className="size-4 text-muted" aria-hidden />Send email</span>}
      actions={!blocked && connected.length > 0 && (
        <TemplatePicker channel="email" carrierId={item.carrier.id} category="follow_up" align="right"
          onPick={(r) => { setSubject(r.subject || ''); setBody(r.body || ''); }} />
      )}>
      {blocked ? <p className="text-sm text-fg-2">{blocked}. Skip this step or leave it on schedule.</p> : accounts.isLoading ? <Loading /> : !connected.length ? (
        <p className="text-sm text-fg-2">Connect a mailbox to send from here. <Link to="/app/email?tab=mailboxes" target="_blank" rel="noopener" className="font-medium text-fg underline-offset-2 hover:underline">Connect a mailbox</Link></p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="To"><Input value={to} readOnly /></Field>
            <Field label="From">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">{(connected.find((a) => a.isDefault) || connected[0]).fromEmail} (default)</option>
                {connected.filter((a) => !a.isDefault).map((a) => <option key={a.id} value={a.id}>{a.fromEmail}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} /></Field>
          <Field label="Message" hint="Your signature and an unsubscribe link are added when it is sent."><Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        </div>
      )}
      <StepFooter onLater={onLater}>
        <Button variant="secondary" icon={SkipForward} loading={busy === 'skip-step'} onClick={async () => { const fresh = await run('skip-step'); if (fresh) { record('email_skipped'); settle(fresh); } }}>Skip email</Button>
        {!blocked && connected.length > 0 && <Button icon={Send} loading={sending} disabled={!subject.trim() || !body.trim()} onClick={send}>Send</Button>}
      </StepFooter>
    </Card>
  );
}

function TextStep({ item, provider, record, settle, onLater }) {
  const toast = useToast();
  const [body, setBody] = useState(item.text?.body || '');
  const [opened, setOpened] = useState(false);
  const [logging, setLogging] = useState(false);
  const { busy, run } = useStepAction(item.enrollmentId, item.step?.index);
  const phone = item.text?.to;
  const gv = provider === 'google_voice';
  const href = textHref(phone, provider, gv ? undefined : body);

  const copy = async () => {
    if (await copyText(body)) toast.success('Message copied');
    else toast.info('Your browser blocked copying. Select the message and copy it.');
  };
  const open = async () => {
    const copied = await copyText(body);
    if (gv) toast.info(copied ? 'Message copied. Paste it in Google Voice and press Send.' : 'Paste the message in Google Voice and press Send.');
    openTextLink(href);
    setOpened(true);
  };
  const markSent = async () => {
    setLogging(true);
    try {
      // Log the text on the carrier's timeline, then complete the step.
      await api.post(`/api/carriers/${item.carrier.id}/texts`, { body: body.trim() || undefined });
    } catch (err) { errorToast(toast, err); setLogging(false); return; }
    setLogging(false);
    const fresh = await run('complete-step');
    if (fresh) { record('text_sent'); settle(fresh); }
  };

  return (
    <Card title={<span className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="size-4 text-muted" aria-hidden />Text message</span>}
      actions={!item.carrier.doNotCall && phone && (
        <TemplatePicker channel="sms" carrierId={item.carrier.id} align="right" onPick={(r) => setBody(r.body || '')} />
      )}>
      {item.carrier.doNotCall ? <p className="text-sm text-fg-2">Marked do-not-call. Texts are blocked too. Skip this step.</p> : !phone ? <p className="text-sm text-fg-2">No phone number on file.</p> : (
        <div className="space-y-3">
          <Field label={`To ${phoneFmt(phone)}`} hint="DispatchDesk does not send texts. You send it from your own number.">
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={MessageSquare} onClick={open} disabled={!body.trim()}>{gv ? 'Copy and open Google Voice' : 'Open messaging app'}</Button>
            <Button variant="ghost" icon={Copy} onClick={copy} disabled={!body.trim()}>Copy</Button>
          </div>
        </div>
      )}
      <StepFooter onLater={onLater}>
        <Button variant="secondary" icon={SkipForward} loading={busy === 'skip-step'} onClick={async () => { const fresh = await run('skip-step'); if (fresh) { record('text_skipped'); settle(fresh); } }}>Skip text</Button>
        {!item.carrier.doNotCall && phone && <Button icon={Check} variant={opened ? 'primary' : 'secondary'} loading={logging || busy === 'complete-step'} onClick={markSent}>Log as sent</Button>}
      </StepFooter>
    </Card>
  );
}

function TaskStep({ item, record, settle, onLater }) {
  const { busy, run } = useStepAction(item.enrollmentId, item.step?.index);
  return (
    <Card title={<span className="flex items-center gap-2 text-sm font-medium"><ClipboardCheck className="size-4 text-muted" aria-hidden />Task</span>}>
      <p className="text-sm text-fg">{item.step.instructions || 'No instructions for this task.'}</p>
      <StepFooter onLater={onLater}>
        <Button variant="secondary" icon={SkipForward} loading={busy === 'skip-step'} onClick={async () => { const fresh = await run('skip-step'); if (fresh) { record('task_skipped'); settle(fresh); } }}>Skip</Button>
        <Button icon={Check} loading={busy === 'complete-step'} onClick={async () => { const fresh = await run('complete-step'); if (fresh) { record('task_done'); settle(fresh); } }}>Done</Button>
      </StepFooter>
    </Card>
  );
}

const RESULT_LABEL = {
  email_sent: 'Emails sent', email_skipped: 'Emails skipped', text_sent: 'Texts logged', text_skipped: 'Texts skipped', task_done: 'Tasks done', task_skipped: 'Tasks skipped',
  replied: 'Replies logged',
};

function Summary({ session, onRestart }) {
  const counts = session.results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
  const calls = session.results.filter((r) => CALL_OUTCOMES.includes(r.outcome)).length;
  const positive = (counts.interested || 0) + (counts.converted || 0) + (counts.call_back || 0) + (counts.follow_up || 0);
  return (
    <Card title="Session finished">
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <div><div className="text-[13px] text-fg-2">Calls logged</div><div className="mt-2 text-[28px] font-medium leading-none tabular">{calls}</div></div>
        <div><div className="text-[13px] text-fg-2">Positive conversations</div><div className="mt-2 text-[28px] font-medium leading-none tabular text-brand-700 dark:text-brand-300">{positive}</div></div>
        <div><div className="text-[13px] text-fg-2">Emails sent</div><div className="mt-2 text-[28px] font-medium leading-none tabular">{counts.email_sent || 0}</div></div>
        <div><div className="text-[13px] text-fg-2">Skipped carriers</div><div className="mt-2 text-[28px] font-medium leading-none tabular">{session.skipped}</div></div>
      </div>
      {session.results.length > 0 && (
        <ul className="mt-6 divide-y divide-line border-t border-line text-sm">
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([o, n]) => (
            <li key={o} className="flex justify-between py-2"><span>{RESULT_LABEL[o] || outcomeLabel(o)}</span><span className="font-mono tabular text-fg-2">{n}</span></li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button icon={RotateCcw} onClick={onRestart}>New session</Button>
        <Button variant="secondary" to="/app/follow-ups">Review follow-ups</Button>
      </div>
    </Card>
  );
}
