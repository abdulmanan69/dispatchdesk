import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Info, ShieldCheck, AlertTriangle } from 'lucide-react';
import { dateTime, label, num } from '../../lib/format.js';
import { Badge, Button, Checkbox, Field, Input, QueryState, Select, Textarea, cx } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import {
  AiBadge, Choice, MODE_OPTIONS, MoneyInput, NEVER_ALONE, OPEN, StatusBadge, fromCents, laneText, negotiationApi, toCents,
  useNegotiationAction, usd,
} from './shared.jsx';

const KIND = { counter: 'Counter', accept: 'Accept', walk_away: 'Walk away', answer: 'Answer', confirm: 'Confirmation' };
const INTENT = { accept: 'Accepted', counter: 'Countered', decline: 'Declined', question: 'Asked a question', other: 'Other' };
const MANUAL_INTENTS = [['counter', 'They countered'], ['accept', 'They accepted'], ['decline', 'They declined'], ['question', 'They asked a question'], ['other', 'Something else']];
const EMAIL_COLOR = { sent: 'green', review: 'amber', scheduled: 'blue', sending: 'blue', failed: 'red', canceled: 'gray' };
const EMAIL_TEXT = { review: 'Waiting for approval' };

function proposalTitle(a) {
  if (a.kind === 'counter') return `Counter at ${usd(a.cents)}`;
  if (a.kind === 'accept') return `Accept ${usd(a.cents)} and book`;
  if (a.kind === 'walk_away') return 'Walk away politely';
  return 'Answer their question';
}

/** The waiting proposal: Approve / Edit / Reject (accept books through the accept dialog). */
function Proposal({ n, onAccept }) {
  const a = n.nextAction;
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(a.subject || '');
  const [body, setBody] = useState(a.body || '');
  const [amount, setAmount] = useState(fromCents(a.cents));
  const key = `${a.createdAt}|${a.emailId}|${a.cents}`;
  useEffect(() => { setEditing(false); setSubject(a.subject || ''); setBody(a.body || ''); setAmount(fromCents(a.cents)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const approve = useNegotiationAction(n.id, (b) => negotiationApi.act(n.id, 'approve', b), { success: (d) => (d.outcome === 'deferred' ? 'Queued: it goes out when the mailbox has room' : 'Email sent') });
  const reject = useNegotiationAction(n.id, () => negotiationApi.act(n.id, 'reject'), { success: 'Proposal discarded. Nothing was sent.' });
  const cents = toCents(amount);
  const outside = a.kind === 'counter' && editing && (cents == null || cents < n.floorCents || cents > n.targetCents);
  const send = () => approve.mutate(editing ? { subject, body, ...(a.kind === 'counter' ? { cents } : {}) } : {});

  return (
    <section className="space-y-3 rounded-lg border border-brand-500/40 bg-surface-2/40 p-3" aria-label="Waiting for your approval">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{proposalTitle(a)}</h3>
        {a.aiWritten && <AiBadge />}
        <Badge color="amber">Waiting for you</Badge>
      </div>
      {a.reason && <p className="text-[13px] text-fg-2">{a.reason}.</p>}
      {a.kind === 'accept' ? (
        <p className="text-[13px] text-fg-2">Booking creates or updates the load at this rate and emails the broker a short confirmation. You can change the amount first.</p>
      ) : editing ? (
        <div className="space-y-3">
          {a.kind === 'counter' && (
            <Field label="Counter" error={outside ? `Keep it between ${usd(n.floorCents)} and ${usd(n.targetCents)}, or change your limits` : null}>
              <MoneyInput value={amount} onChange={setAmount} className="max-w-48" />
            </Field>
          )}
          <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>
          <Field label="Message" hint={a.kind === 'counter' ? 'Changing the amount updates it in the message when you have not edited the text.' : null}>
            <Textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
          </Field>
        </div>
      ) : (
        <div className="rounded-md border border-line bg-surface p-3 text-sm">
          <p className="font-medium">{a.subject}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-fg-2">{a.body}</p>
          <p className="mt-2 text-xs text-muted">To {n.toEmail}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {a.kind === 'accept' ? (
          <Button size="sm" icon={CheckCircle2} onClick={() => onAccept(a.cents)}>Accept & book</Button>
        ) : (
          <>
            <Button size="sm" loading={approve.isPending} disabled={outside || reject.isPending} onClick={send}>{editing ? 'Send edited email' : a.kind === 'walk_away' ? 'Approve: walk away and send' : 'Approve and send'}</Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>{editing ? 'Stop editing' : 'Edit'}</Button>
          </>
        )}
        <Button size="sm" variant="ghost" loading={reject.isPending} disabled={approve.isPending} onClick={() => reject.mutate()}>Reject</Button>
      </div>
    </section>
  );
}

/** History and emails in order: our emails on the right, the broker's replies on the left, small notes between. */
function Thread({ n, emails }) {
  const byId = useMemo(() => new Map(emails.map((e) => [e.id, e])), [emails]);
  if (!n.history.length) return null;
  return (
    <ol className="space-y-2" aria-label="Negotiation thread">
      {n.history.map((h, i) => {
        const key = `${h.at}-${i}`;
        if (h.kind === 'sent') {
          const e = byId.get(h.emailId);
          return (
            <li key={key} className="ml-auto max-w-[min(100%,34rem)] rounded-lg border border-line bg-surface p-3 text-sm sm:ml-12">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <ArrowUpRight className="size-3.5" aria-hidden />
                <span>{h.auto ? 'Sent automatically' : 'You sent'} · {dateTime(h.at)}</span>
                {(e?.aiGenerated || h.from === 'ai') && <AiBadge />}
                {KIND[h.action] && <Badge>{KIND[h.action]}{h.cents != null ? ` ${usd(h.cents)}` : ''}</Badge>}
                {e && e.status !== 'sent' && <Badge color={EMAIL_COLOR[e.status]}>{EMAIL_TEXT[e.status] || label(e.status)}</Badge>}
              </div>
              <p className="font-medium">{e?.subject || h.subject}</p>
              {e?.body && <p className="mt-1 line-clamp-6 whitespace-pre-wrap break-words text-fg-2">{e.body}</p>}
              {e?.error && e.status === 'failed' && <p className="mt-1 text-xs text-c-red">{e.error}</p>}
            </li>
          );
        }
        if (h.from === 'broker') {
          return (
            <li key={key} className="mr-auto max-w-[min(100%,34rem)] rounded-lg border border-line bg-surface-2/60 p-3 text-sm sm:mr-12">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <ArrowDownLeft className="size-3.5" aria-hidden />
                <span>Broker · {dateTime(h.at)}{h.source === 'email' ? ' · by email' : ''}</span>
                {h.intent && <Badge color="blue">{INTENT[h.intent] || h.intent}{h.cents != null ? ` ${usd(h.cents)}` : ''}</Badge>}
                {h.manual && <Badge>Entered by you</Badge>}
              </div>
              {h.noBody
                ? <p className="text-fg-2">They replied by email{h.text ? ` (${h.text.replace(/^Subject:\s*/, '')})` : ''}. Paste their reply below so it can be read.</p>
                : h.text ? <p className="line-clamp-6 whitespace-pre-wrap break-words">{h.text}</p> : null}
              {h.summary && <p className="mt-1 text-xs text-muted">{h.summary}</p>}
            </li>
          );
        }
        return <Note key={key} h={h} />;
      })}
    </ol>
  );
}

function Note({ h }) {
  const warn = h.kind === 'ai_error' || h.kind === 'no_reply';
  let text = h.text;
  if (h.kind === 'proposal') text = `${h.from === 'ai' ? 'AI drafted' : 'Drafted'}: ${(KIND[h.action] || h.action).toLowerCase()}${h.cents != null ? ` ${usd(h.cents)}` : ''}`;
  if (h.kind === 'start') text = `Started. ${h.text || ''}`;
  if (h.kind === 'rejected') text = `Discarded the ${(KIND[h.action] || 'proposal').toLowerCase()}${h.cents != null ? ` at ${usd(h.cents)}` : ''}${h.note ? ` (${h.note.toLowerCase()})` : ''}`;
  if (h.kind === 'agreed') text = `Agreed at ${usd(h.cents)}. Load booked.`;
  if (h.kind === 'walked_away') text = 'You walked away.';
  if (h.kind === 'canceled') text = 'Canceled.';
  if (!text) return null;
  return (
    <li className={cx('flex items-start gap-1.5 px-1 text-xs', warn ? 'text-c-amber' : 'text-muted')}>
      {warn ? <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> : <Info className="mt-px size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0"><span className="tabular">{dateTime(h.at)}</span> · {text}</span>
    </li>
  );
}

/** Paste the broker's reply (the AI reads it), or say by hand what they answered. */
function PasteReply({ n }) {
  const [text, setText] = useState('');
  const [manual, setManual] = useState(false);
  const [intent, setIntent] = useState('counter');
  const [amount, setAmount] = useState('');
  const send = useNegotiationAction(n.id, (b) => negotiationApi.act(n.id, 'reply', b), {
    onSuccess: (d) => {
      if (d.aiError) { setManual(true); return; }
      setText('');
      setAmount('');
      setManual(false);
    },
  });
  const needsAmount = intent === 'counter' || intent === 'accept';
  return (
    <section className="space-y-2" aria-label="Broker reply">
      <Field label="Paste the broker’s reply" hint="Copy their email text here. The AI reads it and proposes the next step; nothing is sent without you, except counters in automatic mode.">
        <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={20000} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" loading={send.isPending && !manual} disabled={!text.trim() || send.isPending} onClick={() => send.mutate({ text })}>Read reply</Button>
        <Button size="sm" variant="link" onClick={() => setManual((v) => !v)}>{manual ? 'Hide' : 'Enter it by hand'}</Button>
      </div>
      {manual && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-line p-3">
          <Field label="What did they say" className="w-56 max-w-full">
            <Select value={intent} onChange={(e) => setIntent(e.target.value)}>{MANUAL_INTENTS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>
          </Field>
          {needsAmount && <Field label="Their rate" className="w-36"><MoneyInput value={amount} onChange={setAmount} /></Field>}
          <Button size="sm" loading={send.isPending && manual} disabled={send.isPending || (needsAmount && intent === 'counter' && toCents(amount) == null)}
            onClick={() => send.mutate({ intent, cents: needsAmount ? toCents(amount) : undefined, text: text.trim() || undefined })}>Save</Button>
        </div>
      )}
    </section>
  );
}

function AcceptDialog({ n, initialCents, onClose }) {
  const [amount, setAmount] = useState(fromCents(initialCents));
  const [sendEmail, setSendEmail] = useState(true);
  const [miles, setMiles] = useState('');
  const cents = toCents(amount);
  const needMiles = !n.loadId && !n.lane?.miles;
  const below = cents != null && cents < n.floorCents;
  const book = useNegotiationAction(n.id, (b) => negotiationApi.act(n.id, 'accept-book', b), {
    success: 'Rate agreed and load booked', invalidate: [['loads'], ['load']], onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} size="sm" title="Accept and book"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={book.isPending} disabled={cents == null || below || (needMiles && !Number(miles))}
          onClick={() => book.mutate({ cents, sendEmail, ...(needMiles ? { loadedMiles: Math.round(Number(miles)) } : {}) })}>Accept and book</Button>
      </>}>
      <div className="space-y-3 text-sm">
        <Field label="Agreed rate" error={below ? `Below your walk-away rate of ${usd(n.floorCents)}. Lower the walk-away first if you want it.` : null}>
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        {needMiles && <Field label="Loaded miles" hint="Needed to save the load"><Input inputMode="numeric" value={miles} onChange={(e) => setMiles(e.target.value)} /></Field>}
        <Checkbox label="Email the broker a short confirmation" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
        <p className="text-xs text-muted">{n.loadId ? 'The linked load is set to booked at this rate.' : 'A booked load is created with this lane, broker and carrier.'}</p>
      </div>
    </Modal>
  );
}

function LimitsDialog({ n, onClose }) {
  const [target, setTarget] = useState(fromCents(n.targetCents));
  const [floor, setFloor] = useState(fromCents(n.floorCents));
  const [rounds, setRounds] = useState(String(n.maxRounds));
  const t = toCents(target);
  const f = toCents(floor);
  const bad = t == null || f == null || f <= 0 || f > t;
  const save = useNegotiationAction(n.id, (b) => negotiationApi.patch(n.id, b), { success: 'Limits saved', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} size="sm" title="Your limits"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={save.isPending} disabled={bad} onClick={() => save.mutate({ targetCents: t, floorCents: f, maxRounds: Number(rounds) })}>Save</Button>
      </>}>
      <div className="space-y-3">
        <Field label="Target"><MoneyInput value={target} onChange={setTarget} /></Field>
        <Field label="Walk-away rate" error={!bad || t == null || f == null ? null : 'The walk-away rate cannot be above the target'}><MoneyInput value={floor} onChange={setFloor} /></Field>
        <Field label="Rounds"><Select value={rounds} onChange={(e) => setRounds(e.target.value)}>{Array.from({ length: 10 }, (_, i) => String(i + 1)).map((x) => <option key={x} value={x}>{x}</option>)}</Select></Field>
        <p className="text-xs text-muted">Counters always stay between these two numbers. A waiting counter outside them is discarded.</p>
      </div>
    </Modal>
  );
}

function WalkAwayDialog({ n, onClose }) {
  const [sendEmail, setSendEmail] = useState(n.nextAction?.kind === 'walk_away');
  const walk = useNegotiationAction(n.id, (b) => negotiationApi.act(n.id, 'walk-away', b), { success: 'Negotiation closed', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} size="sm" title="Walk away"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Keep negotiating</Button>
        <Button variant="danger" loading={walk.isPending} onClick={() => walk.mutate({ sendEmail })}>Walk away</Button>
      </>}>
      <div className="space-y-3 text-sm">
        <p>This closes the negotiation. Nothing is booked.</p>
        <Checkbox label="Send the broker a short, polite email" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
      </div>
    </Modal>
  );
}

function CounterForm({ n }) {
  const [amount, setAmount] = useState('');
  const cents = toCents(amount);
  const outside = cents != null && (cents < n.floorCents || cents > n.targetCents);
  const draft = useNegotiationAction(n.id, (b) => negotiationApi.act(n.id, 'counter', b), { success: 'Counter drafted. Review it above.', onSuccess: () => setAmount('') });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Draft a counter" className="w-40" error={outside ? `${usd(n.floorCents)} to ${usd(n.targetCents)}` : null}>
        <MoneyInput value={amount} onChange={setAmount} placeholder={String((n.lastCounterCents ?? n.targetCents) / 100)} />
      </Field>
      <Button size="sm" variant="secondary" loading={draft.isPending} disabled={cents == null || outside || n.rounds >= n.maxRounds} onClick={() => draft.mutate({ cents })}>Draft</Button>
      {n.rounds >= n.maxRounds && <span className="text-xs text-muted">All rounds used. Raise them in Limits.</span>}
    </div>
  );
}

function Detail({ n, emails }) {
  const confirm = useConfirm();
  const [dialog, setDialog] = useState(null); // { kind: 'accept', cents } | { kind: 'limits' } | { kind: 'walk' }
  const mode = useNegotiationAction(n.id, (m) => negotiationApi.patch(n.id, { mode: m }), { success: (_d, m) => (m === 'auto' ? 'Counters inside your limits now go out automatically' : 'Every email now waits for you') });
  const cancel = useNegotiationAction(n.id, () => negotiationApi.act(n.id, 'cancel'), { success: 'Negotiation canceled' });
  const open = OPEN.includes(n.status);
  const can = n.canWrite && open;
  const stat = (k, v, sub) => (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="font-medium tabular">{v}</dd>
      {sub && <dd className="text-xs text-muted">{sub}</dd>}
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={n.status} />
        <span className="font-medium">{laneText(n.lane)}</span>
        {n.broker && <span className="text-muted">· {n.broker.companyName}</span>}
        {n.carrier && <span className="text-muted">· {n.carrier.companyName}</span>}
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 text-sm sm:grid-cols-5">
        {stat('Broker’s offer', usd(n.offerCents))}
        {stat('Our last counter', usd(n.lastCounterCents))}
        {stat('Target', usd(n.targetCents))}
        {stat('Walk-away', usd(n.floorCents))}
        {stat('Round', `${num(n.rounds)} of ${num(n.maxRounds)}`, n.lane?.miles ? `${num(n.lane.miles)} loaded mi` : null)}
      </dl>
      <p className="flex items-start gap-1.5 text-xs text-muted"><ShieldCheck className="size-3.5 shrink-0 text-c-green" aria-hidden />{NEVER_ALONE}</p>

      {n.status === 'agreed' && (
        <p className="rounded-lg border border-c-green/30 bg-c-green-soft px-3 py-2 text-sm">
          Agreed at {usd(n.agreedCents)}.{n.loadId && <> <Link className="font-medium hover:underline" to={`/app/loads?load=${n.loadId}`}>Open the booked load</Link></>}
        </p>
      )}

      {can && (
        <div className="space-y-1">
          <p className="text-[13px] font-medium">Emails</p>
          <Choice label="When emails go out" options={MODE_OPTIONS} value={n.mode} disabled={mode.isPending} onChange={(m) => mode.mutate(m)} />
        </div>
      )}

      {n.nextAction && can && <Proposal n={n} onAccept={(cents) => setDialog({ kind: 'accept', cents })} />}
      {n.nextAction && !can && open && <p className="text-sm text-muted">A {KIND[n.nextAction.kind]?.toLowerCase() || 'proposal'} waits for {n.canWrite ? 'you' : 'the dispatcher who started this negotiation'}.</p>}

      <Thread n={n} emails={emails} />

      {can && (
        <div className="space-y-4 border-t border-line pt-4">
          <PasteReply n={n} />
          <CounterForm n={n} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={CheckCircle2} onClick={() => setDialog({ kind: 'accept', cents: n.nextAction?.kind === 'accept' ? n.nextAction.cents : n.offerCents })}>Accept & book</Button>
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'limits' })}>Limits</Button>
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'walk' })}>Walk away</Button>
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={async () => {
              if (await confirm({ title: 'Cancel this negotiation?', message: 'Nothing is sent to the broker. Any email waiting for approval is discarded.', confirmLabel: 'Cancel negotiation', cancelLabel: 'Keep it' })) cancel.mutate();
            }}>Cancel negotiation</Button>
          </div>
        </div>
      )}
      {dialog?.kind === 'accept' && <AcceptDialog n={n} initialCents={dialog.cents} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'limits' && <LimitsDialog n={n} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'walk' && <WalkAwayDialog n={n} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** One negotiation: numbers, the waiting proposal, the thread, and the dispatcher's actions. */
export default function NegotiationView({ id }) {
  const q = useQuery({ queryKey: ['negotiation', id], queryFn: () => negotiationApi.get(id), enabled: !!id });
  return <QueryState query={q}>{({ negotiation, emails }) => <Detail n={negotiation} emails={emails || []} />}</QueryState>;
}
