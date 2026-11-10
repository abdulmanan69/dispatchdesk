import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Check, ChevronRight, PhoneCall, Mail, Crosshair, ListOrdered, PhoneOutgoing, Puzzle, MapPinned, PlayCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, cx } from '../ui.jsx';
import { useTourState } from './TourHost.jsx';

const safe = (fn) => async () => { try { return await fn(); } catch { return null; } };

/** First-week checklist on the dashboard. Each step's done state comes from the user's real data. */
export default function GettingStarted() {
  const { state, loaded, record } = useTourState();
  const results = useQueries({
    queries: [
      { queryKey: ['gs', 'calling'], queryFn: safe(() => api.get('/api/telephony/settings')) },
      { queryKey: ['gs', 'mailboxes'], queryFn: safe(() => api.get('/api/email/accounts')) },
      { queryKey: ['gs', 'carriers'], queryFn: safe(() => api.get('/api/carriers', { pageSize: 1 })) },
      { queryKey: ['gs', 'sequences'], queryFn: safe(() => api.get('/api/sequences')) },
      { queryKey: ['gs', 'calls'], queryFn: safe(() => api.get('/api/calls', { pageSize: 1 })) },
      { queryKey: ['gs', 'tokens'], queryFn: safe(() => api.get('/api/tokens')) },
      { queryKey: ['gs', 'fleet'], queryFn: safe(() => api.get('/api/fleet')) },
    ],
  });
  const [calling, mailboxes, carriers, sequences, calls, tokens, fleet] = results.map((r) => r.data);
  if (!loaded || state?.['getting-started'] || results.some((r) => r.isLoading)) return null;

  const count = (d) => d?.total ?? d?.items?.length ?? 0;
  const steps = [
    { done: !!calling?.settings?.configured, icon: PhoneCall, title: 'Choose how you call', body: 'Google Voice, 8x8, RingCentral and more', to: '/app/settings?tab=calling' },
    { done: count(mailboxes) > 0, icon: Mail, title: 'Connect your mailbox', body: 'Send email from your own address', to: '/app/email?tab=mailboxes' },
    { done: count(carriers) > 0, icon: Crosshair, title: 'Generate your first leads', body: 'Fresh carriers from the FMCSA census', to: '/app/lead-generator' },
    { done: count(sequences) > 0, icon: ListOrdered, title: 'Create a sequence', body: 'Call, email and text steps over a few days', to: '/app/sequences' },
    { done: count(calls) > 0, icon: PhoneOutgoing, title: 'Start the power dialer', body: 'Call, log the outcome, move to the next', to: '/app/dialer' },
    { done: count(tokens) > 0, icon: Puzzle, title: 'Install the Chrome extension', body: 'Call from any page, side by side with Google Voice', to: '/app/extension' },
    { done: (fleet?.trucks || []).some((t) => t.truckStatus && t.truckStatus !== 'unknown'), icon: MapPinned, title: 'Add a truck to the fleet map', body: 'Set where it is and plan its next trip', to: '/app/fleet' },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

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
          <li key={s.title} className="sm:border-b sm:border-line">
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
