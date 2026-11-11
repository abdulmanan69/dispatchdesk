import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Check, ChevronRight, PhoneCall, Mail, Crosshair, ListOrdered, PhoneOutgoing, Puzzle, MapPinned, PlayCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Card, cx } from '../ui.jsx';
import { useTourState } from './useTourState.js';

/**
 * Steps in the order a new dispatcher needs them: a sequence exists before leads arrive, so the lead generator can
 * enroll them right away. GET /api/onboarding/status checks each step against the user's real data in one request;
 * a step that is done stays done (cached per user), so it is never asked for again, and nothing is fetched once the
 * checklist is hidden or complete.
 */
const STEPS = [
  { key: 'calling', icon: PhoneCall, title: 'Choose how you call', body: 'Google Voice, 8x8, RingCentral and more', to: '/app/settings?tab=calling' },
  { key: 'mailbox', icon: Mail, title: 'Connect your mailbox', body: 'Send email from your own address', to: '/app/email?tab=mailboxes' },
  { key: 'sequence', icon: ListOrdered, title: 'Create a sequence', body: 'Call, email and text steps over a few days', to: '/app/sequences' },
  { key: 'leads', icon: Crosshair, title: 'Generate your first leads', body: 'Fresh carriers from the FMCSA census', to: '/app/lead-generator' },
  { key: 'dialer', icon: PhoneOutgoing, title: 'Start the power dialer', body: 'Call, log the outcome, move to the next', to: '/app/dialer' },
  { key: 'extension', icon: Puzzle, title: 'Install the Chrome extension', body: 'Call from any page, side by side with Google Voice', to: '/app/extension' },
  { key: 'fleet', icon: MapPinned, title: 'Add a truck to the fleet map', body: 'Set where it is and plan its next trip', to: '/app/fleet' },
];

const cacheKey = (uid) => `dd:getting-started:${uid}`;
const readDone = (uid) => { try { return JSON.parse(localStorage.getItem(cacheKey(uid)) || '{}') || {}; } catch { return {}; } };
const writeDone = (uid, done) => { try { localStorage.setItem(cacheKey(uid), JSON.stringify(done)); } catch { /* storage unavailable */ } };

/** First-week checklist on the dashboard. Each step's done state comes from the user's real data. */
export default function GettingStarted() {
  const { user } = useAuth();
  const { state, loaded, record } = useTourState();
  const hidden = !!state?.['getting-started'];
  const cached = useMemo(() => readDone(user.id), [user.id]);
  const active = loaded && !hidden;
  const pending = STEPS.filter((s) => !cached[s.key]).map((s) => s.key).join(',');
  const status = useQuery({
    queryKey: ['gs', user.id, pending],
    queryFn: ({ signal }) => api.get('/api/onboarding/status', { steps: pending }, { signal }),
    enabled: active && !!pending,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
  });
  const steps = STEPS.map((s) => ({ ...s, done: !!cached[s.key] || !!status.data?.steps?.[s.key] }));
  const done = steps.filter((s) => s.done).length;
  const allDone = done === steps.length;
  const doneKeys = steps.filter((s) => s.done).map((s) => s.key).join(',');

  useEffect(() => {
    if (!doneKeys) return;
    const next = Object.fromEntries(doneKeys.split(',').map((k) => [k, true]));
    writeDone(user.id, next);
  }, [doneKeys, user.id]);
  // Finished: remember it on the server so the checklist (and its requests) never come back.
  useEffect(() => {
    if (active && allDone) record('getting-started', 'done');
  }, [active, allDone, record]);

  if (!active || allDone || status.isLoading) return null;

  return (
    <Card
      title={<div className="flex items-center gap-3"><h2 className="text-sm font-medium">Getting started</h2><span className="text-xs tabular text-muted">{done} of {steps.length} done</span></div>}
      actions={<>
        <Button variant="ghost" size="sm" icon={PlayCircle} onClick={() => window.dispatchEvent(new CustomEvent('dd:tour', { detail: { id: 'welcome' } }))}>Take the tour</Button>
        <Button variant="ghost" size="sm" onClick={() => record('getting-started', 'done')}>Hide</Button>
      </>}
      bodyClass="!p-0"
    >
      <div className="h-1 bg-surface-2"><div className="h-full bg-c-teal transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className="grid divide-y divide-line sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.key} className="sm:border-b sm:border-line">
            <Link to={s.to} className="group flex h-full items-start gap-3 px-5 py-4 transition-ui hover:bg-surface-2">
              <span className={cx('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-medium',
                s.done ? 'bg-c-green text-white' : 'bg-c-blue-soft text-c-blue')}>
                {s.done ? <Check className="size-4" aria-hidden /> : <s.icon className="size-3.5" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block text-sm font-medium', s.done && 'text-muted line-through decoration-line-strong')}>
                  <span className="sr-only">Step {i + 1}{s.done ? ', done' : ''}: </span>{s.title}
                </span>
                <span className="mt-0.5 block text-xs text-muted">{s.body}</span>
              </span>
              {!s.done && <ChevronRight className="mt-1 size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
