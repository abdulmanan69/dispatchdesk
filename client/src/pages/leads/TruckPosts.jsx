import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Megaphone, Truck, Eye, Send, RotateCcw, AlertTriangle, MapPinned, Mail } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { US_STATES, dateTime, relative } from '../../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, Input, PageHeader, QueryState, Select, Textarea, cx } from '../../components/ui.jsx';
import { Modal } from '../../components/Modal.jsx';
import TemplatePicker from '../../components/templates/TemplatePicker.jsx';
import { fieldList } from '../../components/templates/templateApi.js';
import ReloadIdeas from '../../components/carriers/ReloadIdeas.jsx';
import { capacityLine } from '../../components/carriers/BulkEmailModal.jsx';
import { insertAtCursor } from '../../components/carriers/bulkSelection.js';
import { EMPTY_FORM, MAX_BROKERS, POST_TOKENS, detailsPayload, lanesLabel, pickerExtra, postStatus, sendBlocker } from './truckPosts.js';

const STATUS_LABEL = { available: 'Available', loaded: 'Loaded', off_duty: 'Off duty', maintenance: 'In the shop', unknown: 'Status not set' };

/** The value after it stopped changing for `ms` (search boxes). */
function useDebounced(value, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Post truck availability to brokers: pick a truck, adjust what the email says, pick up to 30 brokers (filtered by the
 * lanes you hauled for them), preview each email and queue them from your own mailbox. Reload ideas for the truck's
 * market and the history of recent posts are on the same page.
 */
export default function TruckPosts() {
  const [params, setParams] = useSearchParams();
  // ?truck=<carrier id> (from the fleet panel) preselects a truck.
  const [truckId, setTruckIdState] = useState(() => params.get('truck') || '');
  const setTruckId = (id) => {
    setTruckIdState(id);
    const next = new URLSearchParams(params);
    if (id) next.set('truck', id); else next.delete('truck');
    setParams(next, { replace: true });
  };
  const [form, setForm] = useState(EMPTY_FORM);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [filters, setFilters] = useState({ q: '', state: '', lane: '', withinDays: '' });
  const [preview, setPreview] = useState(null);
  const [allowRepeat, setAllowRepeat] = useState(false);
  const bodyRef = useRef(null);

  const trucks = useQuery({ queryKey: ['truck-posts', 'trucks'], queryFn: () => api.get('/api/truck-posts/trucks') });
  const draft = useQuery({
    queryKey: ['truck-posts', 'draft', truckId],
    queryFn: () => api.get('/api/truck-posts/draft', { carrierId: truckId }),
    enabled: !!truckId,
  });
  // Search as you type: the text is debounced, the signal cancels a search already typed past, and the current list
  // stays on screen (same truck only) while the next one loads.
  const searchText = useDebounced(filters.q.trim());
  const brokerQuery = { ...Object.fromEntries(Object.entries({ ...filters, q: searchText }).filter(([, v]) => v)), carrierId: truckId || undefined };
  const brokers = useQuery({
    queryKey: ['truck-posts', 'brokers', brokerQuery],
    queryFn: ({ signal }) => api.get('/api/truck-posts/brokers', brokerQuery, { signal }),
    enabled: !!truckId && (!filters.lane || /^[A-Za-z]{2}-[A-Za-z]{2}$/.test(filters.lane)),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[2]?.carrierId === brokerQuery.carrierId ? prev : undefined),
    retry: false,
  });
  const history = useQuery({ queryKey: ['truck-posts', 'history'], queryFn: () => api.get('/api/truck-posts/history') });

  // Pick the first available truck once the list loads.
  useEffect(() => {
    if (!truckId && trucks.data?.items?.length) setTruckIdState(trucks.data.items[0].id);
  }, [truckId, trucks.data]);
  // A new truck starts from its own default message and an empty broker selection.
  useEffect(() => {
    if (!draft.data) return;
    setForm(EMPTY_FORM);
    setSubject(draft.data.template.subject);
    setBody(draft.data.template.body);
    setTemplateId(null);
    setSelected(new Set());
  }, [draft.data?.truck?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const truck = draft.data?.truck || trucks.data?.items?.find((t) => t.id === truckId) || null;
  const values = draft.data?.values || {};
  const extra = useMemo(() => pickerExtra(values, form, (d) => dateTime(d)), [values, form]);
  const blocker = sendBlocker({ truck, brokerCount: selected.size, subject, body });
  const payload = () => ({ carrierId: truckId, brokerIds: [...selected], subject, body, templateId: templateId || undefined, details: detailsPayload(form) });

  const runPreview = useApiMutation((p) => api.post('/api/truck-posts/preview', p), { onSuccess: (d) => { setAllowRepeat(false); setPreview(d); } });
  const send = useApiMutation((p) => api.post('/api/truck-posts/send', p), {
    success: (d) => `${d.message}${d.skipped.length ? ` ${d.skipped.length} skipped.` : ''}`,
    invalidate: [['truck-posts', 'history'], ['truck-posts', 'brokers'], ['truck-posts', 'draft'], ['email']],
    onSuccess: () => { setPreview(null); setSelected(new Set()); },
  });

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const insert = (token) => {
    const { value, caret } = insertAtCursor(bodyRef.current, body, `{{${token}}}`);
    setBody(value);
    requestAnimationFrame(() => { const el = bodyRef.current; if (el) { el.focus(); el.setSelectionRange(caret, caret); } });
  };
  const resetMessage = () => { if (draft.data) { setSubject(draft.data.template.subject); setBody(draft.data.template.body); setTemplateId(null); } };

  const brokerRows = brokers.data?.items || [];
  const brokerColumns = [
    { key: 'companyName', header: 'Broker', render: (b) => (
      <div className="min-w-40">
        <div className="font-medium">{b.companyName}</div>
        <div className="text-xs text-muted">{[b.contactName, b.email || 'No email'].filter(Boolean).join(' · ')}</div>
      </div>
    ) },
    { key: 'lanes', header: 'Lanes you hauled', render: (b) => <span className="text-[13px]">{b.lanes.length ? lanesLabel(b.lanes) : <span className="text-muted">None in the last year</span>}</span> },
    { key: 'lastLoadAt', header: 'Last load', render: (b) => <span className="whitespace-nowrap text-[13px] text-muted">{b.lastLoadAt ? relative(b.lastLoadAt) : '—'}</span> },
    { key: 'postedAt', header: '', render: (b) => (b.postedAt ? <span title={dateTime(b.postedAt)}><Badge color="amber">Got this truck {relative(b.postedAt)}</Badge></span> : null) },
  ];

  const availableCount = trucks.data?.available ?? 0;
  // Emails the send will queue: not skipped, every field filled, and not a repeat within 12 hours unless allowed.
  const queueable = (preview?.items || []).filter((i) => !i.skip && !i.unresolved?.length && !i.unknown?.length && (!i.postedAt || allowRepeat)).length;

  return (
    <div>
      <PageHeader title="Post trucks" subtitle="Email an available truck to the brokers you work with. Each broker gets a personal email from your own mailbox." />

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card title="Trucks" actions={trucks.data && <span className="text-xs text-muted">{availableCount} available</span>} bodyClass="p-0">
          <QueryState query={trucks} isEmpty={(d) => !d.items.length}
            empty={<EmptyState icon={Truck} title="No trucks yet" action={<Button size="sm" variant="secondary" icon={MapPinned} to="/app/fleet">Open the fleet map</Button>}>Customers and carriers with a status or location on the fleet map show up here.</EmptyState>}>
            {(d) => (
              <ul className="max-h-[540px] divide-y divide-line overflow-y-auto" aria-label="Trucks">
                {d.items.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => setTruckId(t.id)} aria-pressed={t.id === truckId}
                      className={cx('flex w-full flex-col gap-1 px-4 py-3 text-left transition-ui hover:bg-surface-2', t.id === truckId && 'bg-surface-2')}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{t.companyName}</span>
                        <Badge color={t.available ? 'green' : t.truckStatus === 'loaded' ? 'blue' : 'gray'}>{t.available ? 'Available' : STATUS_LABEL[t.truckStatus] || t.truckStatus}</Badge>
                      </span>
                      <span className="text-xs text-muted">{[t.equipmentText, t.location].filter(Boolean).join(' · ') || 'No equipment or location yet'}</span>
                      {t.availableAt && new Date(t.availableAt) > new Date() && <span className="text-xs text-muted">Empty {dateTime(t.availableAt)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Card>

        <div className="min-w-0 space-y-4">
          {!truckId ? (
            <Card><EmptyState icon={Megaphone} title="Pick a truck">Choose a truck on the left to write its availability email.</EmptyState></Card>
          ) : (
            <>
              <Card title={truck ? `What the email says about ${truck.companyName}` : 'Truck details'}>
                <QueryState query={draft}>
                  {() => (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Empty in" hint="City and state"><Input value={form.location} onChange={setField('location')} placeholder={values.truck_location || 'Dallas, TX'} maxLength={120} /></Field>
                      <Field label="Available" hint={values.available_date ? `Stored: ${values.available_date}` : 'Leave empty if not known'}><Input type="datetime-local" value={form.availableAt} onChange={setField('availableAt')} /></Field>
                      <Field label="Equipment"><Input value={form.equipment} onChange={setField('equipment')} placeholder={values.equipment || 'Dry van'} maxLength={120} /></Field>
                      <Field label="Target rate"><Input value={form.rate} onChange={setField('rate')} placeholder={values.target_rate || '$2.50/mi'} maxLength={60} /></Field>
                      <Field label="Preferred lanes" className="sm:col-span-2"><Input value={form.lanes} onChange={setField('lanes')} placeholder={values.preferred_lanes || 'TX to GA; TX to FL'} maxLength={300} /></Field>
                      <Field label="Trailer and endorsements" className="sm:col-span-2"><Input value={form.details} onChange={setField('details')} placeholder={values.truck_details || '53 ft trailer, hazmat'} maxLength={300} /></Field>
                    </div>
                  )}
                </QueryState>
              </Card>

              <Card title="Message" actions={<>
                <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!draft.data} onClick={resetMessage}>Default</Button>
                <TemplatePicker channel="email" category="broker" extra={extra} align="right" label="Templates"
                  onPick={({ subject: s, body: b, template }) => { setSubject(s || ''); setBody(b || ''); setTemplateId(template?.id || null); }} />
              </>}>
                <div className="space-y-3">
                  <Field label="Subject" required><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} /></Field>
                  <Field label="Message" required hint="Fields in {{double braces}} are filled for each broker and from the truck details above.">
                    <Textarea ref={bodyRef} rows={11} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} />
                  </Field>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Insert a field">
                    {POST_TOKENS.map((t) => (
                      <button key={t} type="button" onClick={() => insert(t)} className="rounded-md border border-line px-2 py-1 font-mono text-xs text-fg-2 transition-ui hover:bg-surface-2 hover:text-fg">{`{{${t}}}`}</button>
                    ))}
                  </div>
                </div>
              </Card>

              <Card bodyClass="p-0" title={<div><h2 className="text-sm font-medium">Brokers</h2><p className="text-xs text-muted">{selected.size} selected · up to {MAX_BROKERS} per post</p></div>}
                actions={<Button icon={Eye} disabled={!!blocker} title={blocker || undefined} loading={runPreview.isPending} onClick={() => runPreview.mutate(payload())}>Preview</Button>}>
                <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-4">
                  <Input aria-label="Search brokers" placeholder="Search name, email or MC" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
                  <Select aria-label="State" value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value }))}>
                    <option value="">Any state</option>{US_STATES.map((s) => <option key={s} value={s}>Works {s}</option>)}
                  </Select>
                  <Input aria-label="Lane, like TX-GA" placeholder="Lane, like TX-GA" value={filters.lane} maxLength={5} onChange={(e) => setFilters((f) => ({ ...f, lane: e.target.value.toUpperCase() }))} />
                  <Select aria-label="Last load" value={filters.withinDays} onChange={(e) => setFilters((f) => ({ ...f, withinDays: e.target.value }))}>
                    <option value="">Any time</option><option value="30">Load in the last 30 days</option><option value="90">Load in the last 90 days</option><option value="180">Load in the last 180 days</option>
                  </Select>
                </div>
                {blocker && selected.size > MAX_BROKERS && <p className="border-b border-line px-4 py-2 text-xs text-c-red" role="alert">{blocker}</p>}
                {filters.lane && !/^[A-Za-z]{2}-[A-Za-z]{2}$/.test(filters.lane) ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">Type a lane as two state codes, like TX-GA.</p>
                ) : (
                <QueryState query={brokers}>
                  {(d) => (
                    <>
                      <DataTable dense rows={brokerRows} columns={brokerColumns} selected={selected} onSelect={setSelected}
                        mobileRow={(b, { selected: on, toggle }) => (
                          <div className="flex items-start gap-3">
                            <Checkbox aria-label={`Select ${b.companyName}`} checked={on} onChange={toggle} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2"><span className="truncate font-medium">{b.companyName}</span>{b.postedAt && <Badge color="amber">Sent {relative(b.postedAt)}</Badge>}</div>
                              <div className="truncate text-xs text-muted">{b.email || 'No email'}</div>
                              {b.lanes.length > 0 && <div className="text-xs text-muted">{lanesLabel(b.lanes, 2)}</div>}
                            </div>
                          </div>
                        )}
                        empty={<EmptyState icon={Mail} title="No brokers match">Brokers need an email address. Add brokers on the Brokers page, or clear the filters.</EmptyState>} />
                      {d.limited && <p className="border-t border-line px-4 py-2 text-xs text-muted">Showing the first 500 brokers by name. Search to find others.</p>}
                    </>
                  )}
                </QueryState>
                )}
              </Card>

              {truck && <ReloadIdeas state={truck.locationState} city={truck.locationCity} equipment={truck.equipment} extra={values} compact />}
            </>
          )}

          <Card title="Recent posts" bodyClass="p-0">
            <QueryState query={history} isEmpty={(d) => !d.items.length} empty={<p className="px-4 py-6 text-center text-sm text-muted">Posts you send appear here with each email's status.</p>}>
              {(d) => (
                <ul className="divide-y divide-line">
                  {d.items.map((p) => (
                    <li key={p.postId} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-medium">{p.truck?.companyName || 'Deleted truck'}{p.location ? <span className="font-normal text-muted"> · {p.location}</span> : null}</span>
                        <span className="text-xs text-muted" title={dateTime(p.at)}>{relative(p.at)}</span>
                      </div>
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {p.recipients.map((r, i) => {
                          const [color, text] = postStatus(r.status);
                          return <li key={`${r.emailId || i}`} title={r.error || r.toEmail || undefined}><Badge color={color}>{r.brokerName || r.toEmail || 'Broker'}: {text}</Badge></li>;
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          </Card>
        </div>
      </div>

      <Modal open={!!preview} onClose={() => setPreview(null)} size="lg" title={`Preview: ${queueable} email${queueable === 1 ? '' : 's'} to queue`}
        footer={preview && (
          <>
            {preview.items.some((i) => i.postedAt) && <Checkbox label="Also send to brokers that got this truck in the last 12 hours" checked={allowRepeat} onChange={(e) => setAllowRepeat(e.target.checked)} />}
            <span className="flex-1" />
            <Button variant="secondary" onClick={() => setPreview(null)}>Back</Button>
            <Button icon={Send} disabled={!preview.mailbox || !queueable} loading={send.isPending} onClick={() => send.mutate({ ...payload(), allowRepeat })}>Queue emails</Button>
          </>
        )}>
        {preview && (
          <div className="space-y-3">
            {!preview.mailbox ? (
              <p className="flex items-start gap-2 rounded-lg border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-[13px] text-fg-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-c-amber" aria-hidden />
                <span>No mailbox is connected, so nothing can be sent. <Link to="/app/email" className="font-medium text-fg underline-offset-2 hover:underline">Connect your mailbox</Link> first.</span>
              </p>
            ) : (
              <p className="text-sm text-fg-2">From {preview.mailbox.fromEmail}. {queueable ? capacityLine(preview.capacity, queueable) : 'None of these emails can be queued yet.'}</p>
            )}
            {preview.items.map((it) => (
              <article key={it.brokerId} className={cx('rounded-lg border border-line', it.skip && 'opacity-70')}>
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs text-muted">
                  <span>To {it.brokerName || 'Unknown broker'}{it.toEmail ? ` · ${it.toEmail}` : ''}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {it.skip && <Badge color="gray">{it.skip}</Badge>}
                    {it.postedAt && <Badge color="amber">Got this truck {relative(it.postedAt)}</Badge>}
                    {(it.unresolved?.length > 0 || it.unknown?.length > 0) && <Badge color="red">Missing fields</Badge>}
                  </span>
                </header>
                {!it.skip && (
                  <div className="space-y-2 px-3 py-2 text-sm">
                    <p className="font-medium">{it.subject}</p>
                    <p className="whitespace-pre-wrap break-words text-fg-2">{it.body}{it.signature ? `\n\n${it.signature}` : ''}</p>
                    {(it.unresolved?.length > 0 || it.unknown?.length > 0) && (
                      <p className="text-xs text-c-red">{fieldList([...(it.unresolved || []), ...(it.unknown || [])])} {[...(it.unresolved || []), ...(it.unknown || [])].length === 1 ? 'has' : 'have'} no value, so this email will not be queued. Fill the truck details or edit the message.</p>
                    )}
                  </div>
                )}
              </article>
            ))}
            <p className="text-xs text-muted">Emails are queued and go out from your mailbox in the background, within its cooldown and daily limits.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
