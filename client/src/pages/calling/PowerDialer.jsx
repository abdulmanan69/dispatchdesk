import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOff, Settings2, SkipForward, Check, RotateCcw, Mail, MessageSquare, ClipboardCheck, Puzzle, Send, Clock } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { CALL_OUTCOMES, label, relative, dateTime, phoneFmt } from '../../lib/format.js';
import { Button, Card, EmptyState, ErrorState, Field, Input, Loading, LocalClock, Markdown, PageHeader, Select, Switch, Textarea, cx } from '../../components/ui.jsx';
import { Modal } from '../../components/Modal.jsx';
import { StageBadge } from '../../components/carriers/shared.jsx';
import CallingSettings from '../../components/calling/CallingSettings.jsx';
import { useDialer, ATTEMPT_LABEL } from '../../components/calling/useDialer.js';

const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver', PR: 'America/Puerto_Rico',
};
const tzOf = (c) => c?.timezone || STATE_TZ[String(c?.state || '').toUpperCase()] || null;

function localHour(tz) {
  if (!tz) return null;
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date());
    return { hour: Number(p.find((x) => x.type === 'hour').value) % 24, weekday: p.find((x) => x.type === 'weekday').value };
  } catch { return null; }
}
function windowFor(c) {
  const t = localHour(tzOf(c));
  if (!t) return { callable: true, text: 'Time zone unknown' };
  if (t.weekday === 'Sat' || t.weekday === 'Sun') return { callable: false, text: 'Weekend locally' };
  if (t.hour < 8) return { callable: false, text: 'Too early locally' };
  if (t.hour >= 19) return { callable: false, text: 'After hours locally' };
  if (t.hour < 11) return { callable: true, text: 'Prime window' };
  return { callable: true, text: 'Good window' };
}

/** Next local 9:00 AM in the carrier's zone, `days` ahead, as a Date. */
function localNineAm(tz, days) {
  const base = new Date(Date.now() + days * 86400000);
  if (!tz) { base.setHours(9, 0, 0, 0); return base; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(base).map((p) => [p.type, p.value]));
  // Find the UTC instant that is 09:00 in tz on that date (scan offsets −12h..+14h).
  const target = Date.UTC(+parts.year, +parts.month - 1, +parts.day, 9, 0, 0);
  for (let off = -14; off <= 12; off += 0.5) {
    const d = new Date(target - off * 3600000);
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false }).format(d);
    if (h === '09:00') return d;
  }
  return new Date(target);
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const FINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'canceled']);
const STEP_ICON = { call: Phone, email: Mail, text: MessageSquare, task: ClipboardCheck };
const STEP_LABEL = { call: 'Call', email: 'Email', text: 'Text', task: 'Task' };
const QUICK_PROVIDERS = ['google_voice', 'eight_by_eight', 'ringcentral', 'dialpad', 'tel'];
/** After finishing a step, stay on the carrier only when the next step is an email or text to work right away. */
const STAY_ON = new Set(['email', 'text']);

function e164(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return d ? `+${d}` : '';
}

function mergeScript(body, c, user) {
  const map = { company: c?.companyName || 'your company', first_name: 'there', my_name: user?.name?.split(' ')[0] || '', mc: c?.mcNumber || '', city: c?.city || '', state: c?.state || '', dot: c?.dotNumber || '' };
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m));
}

/** Calls and texts need a phone and no do-not-call flag; email and task steps don't. */
function workable(i) {
  const type = i.step?.type;
  if (type === 'email' || type === 'task') return true;
  return !!i.carrier.phone && !i.carrier.doNotCall;
}

export default function PowerDialer() {
  const [params, setParams] = useSearchParams();
  const seqParam = params.get('sequenceId');
  const [source, setSourceState] = useState(seqParam ? `seq:${seqParam}` : 'queue');
  const [includeUpcoming, setIncludeUpcoming] = useState(false);
  const [session, setSession] = useState(null); // { items, index, results: [], skipped: 0 }
  const [setupOpen, setSetupOpen] = useState(false);
  const lists = useQuery({ queryKey: ['prospect-lists'], queryFn: () => api.get('/api/prospecting/lists') });
  const sequences = useQuery({ queryKey: ['sequences'], queryFn: () => api.get('/api/sequences') });
  const settings = useQuery({ queryKey: ['telephony', 'settings'], queryFn: () => api.get('/api/telephony/settings') });
  const providers = useQuery({ queryKey: ['telephony', 'providers'], queryFn: () => api.get('/api/telephony/providers'), staleTime: 3600000 });

  useEffect(() => { if (seqParam) setSourceState(`seq:${seqParam}`); }, [seqParam]);
  const setSource = (v) => {
    setSourceState(v);
    setIncludeUpcoming(false);
    if (v.startsWith('seq:')) setParams({ sequenceId: v.slice(4) }, { replace: true });
    else if (seqParam) setParams({}, { replace: true });
  };

  const items = useQuery({
    queryKey: ['dialer-source', source, includeUpcoming],
    enabled: !session,
    queryFn: async () => {
      if (source === 'queue') {
        const q = await api.get('/api/prospecting/queue', { includeHot: 'true' });
        return {
          items: q.items.map((it) => ({
            key: it.key, carrier: it.carrier, dueAt: it.dueAt,
            enrollmentId: it.sequence?.enrollmentId,
            step: it.sequence ? { type: it.sequence.type, number: it.sequence.stepNumber } : null,
            reason: it.sequence ? `${it.sequence.name} · step ${it.sequence.stepNumber} of ${it.sequence.stepCount} · ${STEP_LABEL[it.sequence.type] || it.sequence.type}${it.sequence.instructions ? ` — ${it.sequence.instructions}` : ''}` : it.followUp ? `Follow-up${it.followUp.note ? ` — ${it.followUp.note}` : ''}` : 'Hot lead',
          })),
        };
      }
      if (source.startsWith('seq:')) {
        const s = await api.get(`/api/sequences/${source.slice(4)}/session`, { includeUpcoming: String(includeUpcoming) });
        return {
          sequence: s.sequence, dueToday: s.dueToday, upcoming: s.upcoming,
          items: s.items.map((it) => ({
            key: it.enrollmentId, carrier: it.carrier, dueAt: it.dueAt, enrollmentId: it.enrollmentId, step: it.step, seq: it,
            reason: `${s.sequence.name} · step ${it.step.number} of ${it.sequence.stepCount} · ${STEP_LABEL[it.step.type] || it.step.type}${it.step.instructions ? ` — ${it.step.instructions}` : ''}`,
          })),
        };
      }
      const l = await api.get(`/api/prospecting/lists/${source}`, { pageSize: 200 });
      return { items: l.items.map((it) => ({ key: it.carrier.id, carrier: it.carrier, reason: `List: ${l.list.name}` })) };
    },
  });

  const s = settings.data?.settings;
  const providerLabel = providers.data?.items.find((p) => p.key === s?.provider)?.label;

  return (
    <div>
      <PageHeader title="Power dialer" subtitle={session ? `${providerLabel || 'Your calling app'} · one click per call` : 'Work through calls, emails and texts one carrier at a time. Every call starts from your click.'}
        actions={<>
          <Button variant="ghost" icon={Puzzle} to="/app/extension">Chrome extension</Button>
          <Button variant="secondary" icon={Settings2} onClick={() => setSetupOpen(true)}>Calling setup</Button>
        </>} />

      {!session ? (
        <Start source={source} setSource={setSource} lists={lists} sequences={sequences} items={items} settings={s} providers={providers}
          includeUpcoming={includeUpcoming} setIncludeUpcoming={setIncludeUpcoming} providerLabel={providerLabel} onMoreProviders={() => setSetupOpen(true)}
          onStart={(list) => setSession({ items: list, index: 0, results: [], skipped: 0 })} />
      ) : session.index >= session.items.length ? (
        <Summary session={session} onRestart={() => setSession(null)} />
      ) : (
        <Session session={session} setSession={setSession} autoAdvance={s?.autoAdvance !== false} provider={s?.provider} />
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
    } catch (err) { toast.error(err); } finally { setSaving(null); }
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
        <Select aria-label="Call list" value={source} onChange={(e) => setSource(e.target.value)} className="w-60">
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
              return (
                <li key={i.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3">
                  <Icon className="size-4 text-muted" aria-label={STEP_LABEL[i.step?.type] || 'Call'} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{i.carrier.companyName}</div>
                    <div className="truncate text-xs text-muted">{i.reason}</div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <LocalClock timezone={tzOf(i.carrier)} />
                    <span className={cx('text-xs', !ok ? 'text-red-600 dark:text-red-400' : windowFor(i.carrier).callable ? 'text-fg-2' : 'text-muted')}>
                      {i.carrier.doNotCall && !ok ? 'Do not call' : !ok ? 'No phone' : i.dueAt && new Date(i.dueAt) > new Date(Date.now() + 3600000) ? `Due ${relative(i.dueAt)}` : windowFor(i.carrier).text}
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
          <p className="mt-3 text-xs text-muted">Shortcuts: <Kbd>C</Kbd> call, <Kbd>1</Kbd>–<Kbd>8</Kbd> outcome, <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> save, <Kbd>S</Kbd> skip</p>
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

function Session({ session, setSession, autoAdvance, provider }) {
  const { user } = useAuth();
  const toast = useToast();
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
  const [elapsed, setElapsed] = useState(0);
  const [scriptId, setScriptId] = useState('');

  const detail = useQuery({ queryKey: ['carrier', c.id], queryFn: () => api.get(`/api/carriers/${c.id}`) });
  const scripts = useQuery({ queryKey: ['call-scripts'], queryFn: () => api.get('/api/call-scripts'), retry: false });
  const enrollment = useQuery({
    queryKey: ['enrollment', eid], enabled: !!eid,
    queryFn: () => api.get(`/api/sequences/enrollments/${eid}`),
    initialData: item.seq ? { item: item.seq } : undefined,
  });
  const scriptList = scripts.data?.items || [];
  const script = scriptList.find((s) => s.id === scriptId) || scriptList[0];
  const seqItem = enrollment.data?.item;
  // Which kind of work this carrier needs right now. Non-sequence items are always calls.
  const stage = !eid ? 'call' : seqItem ? (seqItem.step?.type || 'done') : (item.step?.type || 'call');

  // Reset per carrier.
  useEffect(() => { log.current = []; setOutcome(''); setNotes(''); setFollowUp('auto'); setCustomAt(''); setSavedCall(null); setElapsed(0); d.reset(); }, [session.index]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live timer from the click until the call is saved (or the phone system reports the length).
  const att = d.attempt;
  const reported = att?.durationSec != null;
  useEffect(() => {
    if (!att || savedCall || reported) return undefined;
    const start = new Date(att.createdAt).getTime();
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 1000);
    return () => clearInterval(id);
  }, [att, savedCall, reported]);

  // Bridge call logged automatically (no answer / busy): count it and move on.
  useEffect(() => {
    if (att?.callId && !savedCall && FINAL.has(att.status)) {
      setSavedCall({ id: att.callId, outcome: att.status === 'busy' ? 'busy' : 'no_answer', automatic: true });
    }
  }, [att, savedCall]);

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

  const call = useCallback(() => { if (!c.doNotCall && !d.dialing) d.dial({ carrierId: c.id }); }, [c, d]);

  const save = useCallback(async () => {
    if (!outcome || saving || savedCall || stage !== 'call') return;
    setSaving(true);
    try {
      const followUpAt = followUp === 'tomorrow' ? localNineAm(tz, 1) : followUp === 'two_days' ? localNineAm(tz, 2) : followUp === 'week' ? localNineAm(tz, 7) : followUp === 'custom' && customAt ? new Date(customAt) : null;
      const res = await api.post('/api/calls', {
        carrierId: c.id, outcome, notes,
        attemptId: att && !att.callId ? att.id : undefined,
        durationSec: !reported && att ? Math.round(elapsed) : undefined,
        followUpAt: followUpAt ? followUpAt.toISOString() : null,
        autoFollowUp: followUp !== 'none',
      });
      setSavedCall({ id: res.call.id, outcome });
      qc.invalidateQueries({ queryKey: ['queue'] });
      qc.invalidateQueries({ queryKey: ['carrier', c.id] });
      toast.success(`${c.companyName}: ${label(outcome)}${res.followUp ? ` · follow-up ${dateTime(res.followUp.dueAt)}` : ''}`);
      await afterCall(outcome);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  }, [outcome, saving, savedCall, stage, followUp, tz, customAt, c, notes, att, reported, elapsed, qc, toast, afterCall]);

  // Keyboard shortcuts (ignored while typing in a field). Call shortcuts only apply on a call step.
  useEffect(() => {
    const onKey = (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
      if (stage === 'call' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (stage === 'call' && !savedCall && /^[1-8]$/.test(e.key)) { setOutcome(CALL_OUTCOMES[Number(e.key) - 1]); }
      else if (stage === 'call' && e.key.toLowerCase() === 'c') call();
      else if (e.key.toLowerCase() === 's' && !savedCall && stage === 'call') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, call, next, savedCall, stage]);

  const carrier = detail.data?.carrier;
  const lastNotes = carrier?.notes?.slice(0, 3) || [];
  const lastCalls = carrier?.calls?.slice(0, 3) || [];
  const live = att && !FINAL.has(att.status) && att.status !== 'dialed';
  const StageIcon = STEP_ICON[stage] || Check;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <div className="flex items-center justify-between text-sm text-fg-2">
          <span className="font-mono text-xs tabular">{session.index + 1} of {session.items.length}</span>
          <div className="mx-4 h-1 flex-1 rounded-full bg-surface-2">
            <div className="h-1 rounded-full bg-brand-600 transition-ui" style={{ width: `${(session.index / session.items.length) * 100}%` }} />
          </div>
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setSession((s) => ({ ...s, index: s.items.length }))}>End session</button>
        </div>

        <Card>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <Link to={`/app/carriers/${c.id}`} className="text-xl font-medium tracking-[-0.01em] hover:underline">{c.companyName}</Link>
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
                  {att && (
                    <span className="flex items-center gap-2 text-sm text-fg-2" role="status">
                      <span className={cx('size-1.5 rounded-full', live ? 'bg-brand-600' : 'bg-line-strong')} aria-hidden />
                      {ATTEMPT_LABEL[att.status] || att.status}
                      <span className="font-mono tabular text-fg">{mmss(reported ? att.durationSec : elapsed)}</span>
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
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {CALL_OUTCOMES.map((o, i) => (
                  <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}
                    className={cx('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-ui', outcome === o ? 'border-fg/30 bg-surface-2 font-medium text-fg' : 'border-line text-fg-2 hover:bg-surface-2/60')}>
                    {label(o)}<Kbd>{i + 1}</Kbd>
                  </button>
                ))}
              </div>
              <Field label="Notes" className="mt-4"><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Equipment, lanes, rate expectations, who you spoke with" /></Field>
              <div className="mt-4">
                <div className="mb-2 text-[13px] font-medium">Next follow-up</div>
                <div className="flex flex-wrap gap-2">
                  {[['auto', 'Automatic'], ['tomorrow', 'Tomorrow 9 AM local'], ['two_days', 'In 2 days'], ['week', 'Next week'], ['custom', 'Pick a time'], ['none', 'None']].map(([k, l]) => (
                    <button key={k} type="button" aria-pressed={followUp === k} onClick={() => setFollowUp(k)}
                      className={cx('h-8 rounded-lg border px-3 text-[13px] transition-ui', followUp === k ? 'border-fg/30 bg-surface-2 text-fg' : 'border-line text-fg-2 hover:bg-surface-2/60')}>{l}</button>
                  ))}
                </div>
                {followUp === 'custom' && <Input type="datetime-local" aria-label="Follow-up time" value={customAt} onChange={(e) => setCustomAt(e.target.value)} className="mt-2 w-60" />}
              </div>
            </fieldset>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <Button variant="ghost" icon={SkipForward} onClick={() => next()} disabled={!!savedCall}>Skip</Button>
              {savedCall ? (
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 text-sm text-fg-2"><Check className="size-4 text-brand-600" />{savedCall.automatic ? 'Logged automatically' : 'Saved'}: {label(savedCall.outcome)}</span>
                  {!autoAdvance || savedCall.automatic ? <Button onClick={() => next()}>Next carrier</Button> : null}
                </div>
              ) : (
                <Button onClick={save} loading={saving} disabled={!outcome}>{autoAdvance ? 'Save and next' : 'Save call'}</Button>
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

      <div className="space-y-4">
        <Card title="Script" actions={scriptList.length > 1 && (
          <Select aria-label="Choose script" value={script?.id || ''} onChange={(e) => setScriptId(e.target.value)} className="h-8 w-44">
            {scriptList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}>
          {scripts.isLoading ? <Loading /> : script ? (
            <Markdown text={mergeScript(script.body, c, user)} className="max-h-[420px] overflow-y-auto" />
          ) : (
            <p className="text-sm text-fg-2">No call scripts yet. <Link to="/app/call-scripts" className="text-fg underline underline-offset-2">Write or add starter scripts</Link> to see them here while you call.</p>
          )}
        </Card>
        <Card title="History">
          {detail.isLoading ? <Loading /> : !lastCalls.length && !lastNotes.length ? <p className="text-sm text-muted">No calls or notes yet</p> : (
            <ul className="space-y-3 text-sm">
              {lastCalls.map((x) => <li key={x.id}><span className="font-mono text-xs text-muted">{relative(x.calledAt)}</span><div>{label(x.outcome)}{x.notes ? ` — ${x.notes}` : ''}</div></li>)}
              {lastNotes.map((n) => <li key={n.id}><span className="font-mono text-xs text-muted">Note · {relative(n.createdAt)}</span><div className="line-clamp-3">{n.body}</div></li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Run a sequence step action (skip-step / complete-step) and refresh the enrollment. */
function useStepAction(eid) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  /** Returns the refreshed work item, or undefined on error. */
  const run = async (action) => {
    setBusy(action);
    try {
      await api.post(`/api/sequences/enrollments/${eid}/${action}`);
      qc.invalidateQueries({ queryKey: ['queue'] });
      const fresh = await api.get(`/api/sequences/enrollments/${eid}`);
      qc.setQueryData(['enrollment', eid], fresh);
      return fresh.item;
    } catch (err) { toast.error(err); return undefined; } finally { setBusy(null); }
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
  const { busy, run } = useStepAction(item.enrollmentId);
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
      toast.error(err);
      if (err.status === 409) qc.invalidateQueries({ queryKey: ['enrollment', item.enrollmentId] });
    } finally { setSending(false); }
  };

  return (
    <Card title={<span className="flex items-center gap-2 text-sm font-medium"><Mail className="size-4 text-muted" aria-hidden />Send email</span>}>
      {blocked ? <p className="text-sm text-fg-2">{blocked}. Skip this step or leave it on schedule.</p> : accounts.isLoading ? <Loading /> : !connected.length ? (
        <p className="text-sm text-fg-2">Connect a mailbox to send from here. <Link to="/app/email?tab=mailboxes" className="font-medium text-fg underline-offset-2 hover:underline">Connect a mailbox</Link></p>
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
          <Field label="Message"><Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
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
  const { busy, run } = useStepAction(item.enrollmentId);
  const to = e164(item.text?.to);
  const gv = provider === 'google_voice';

  const open = async () => {
    try { await navigator.clipboard.writeText(body); toast.success(gv ? 'Message copied. Paste it in Google Voice and press Send.' : 'Message copied'); } catch { /* clipboard blocked: the text is still visible to copy */ }
    if (gv) window.open(`https://voice.google.com/u/0/messages?itemId=t.${encodeURIComponent(to)}`, '_blank', 'noopener');
    else window.location.href = `sms:${to}?&body=${encodeURIComponent(body)}`;
    setOpened(true);
  };

  return (
    <Card title={<span className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="size-4 text-muted" aria-hidden />Text message</span>}>
      {item.carrier.doNotCall ? <p className="text-sm text-fg-2">Marked do-not-call. Texts are blocked too. Skip this step.</p> : !to ? <p className="text-sm text-fg-2">No phone number on file.</p> : (
        <div className="space-y-3">
          <Field label={`To ${phoneFmt(item.text.to)}`} hint="DispatchDesk does not send texts. You send it from your own number.">
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} />
          </Field>
          <Button variant="secondary" icon={MessageSquare} onClick={open}>{gv ? 'Open in Google Voice' : 'Open messaging app'}</Button>
        </div>
      )}
      <StepFooter onLater={onLater}>
        <Button variant="secondary" icon={SkipForward} loading={busy === 'skip-step'} onClick={async () => { const fresh = await run('skip-step'); if (fresh) { record('text_skipped'); settle(fresh); } }}>Skip text</Button>
        {!item.carrier.doNotCall && to && <Button icon={Check} variant={opened ? 'primary' : 'secondary'} loading={busy === 'complete-step'} onClick={async () => { const fresh = await run('complete-step'); if (fresh) { record('text_sent'); settle(fresh); } }}>Mark sent</Button>}
      </StepFooter>
    </Card>
  );
}

function TaskStep({ item, record, settle, onLater }) {
  const { busy, run } = useStepAction(item.enrollmentId);
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

function Summary({ session, onRestart }) {
  const counts = session.results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
  const calls = session.results.filter((r) => CALL_OUTCOMES.includes(r.outcome)).length;
  const positive = (counts.interested || 0) + (counts.converted || 0) + (counts.call_back || 0) + (counts.follow_up || 0);
  return (
    <Card title="Session finished">
      <div className="grid gap-6 sm:grid-cols-4">
        <div><div className="text-[13px] text-fg-2">Calls logged</div><div className="mt-2 text-[28px] font-medium leading-none tabular">{calls}</div></div>
        <div><div className="text-[13px] text-fg-2">Positive conversations</div><div className="mt-2 text-[28px] font-medium leading-none tabular text-brand-700 dark:text-brand-300">{positive}</div></div>
        <div><div className="text-[13px] text-fg-2">Emails sent</div><div className="mt-2 text-[28px] font-medium leading-none tabular">{counts.email_sent || 0}</div></div>
        <div><div className="text-[13px] text-fg-2">Skipped carriers</div><div className="mt-2 text-[28px] font-medium leading-none tabular">{session.skipped}</div></div>
      </div>
      {session.results.length > 0 && (
        <ul className="mt-6 divide-y divide-line border-t border-line text-sm">
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([o, n]) => (
            <li key={o} className="flex justify-between py-2"><span>{label(o)}</span><span className="font-mono tabular text-fg-2">{n}</span></li>
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
