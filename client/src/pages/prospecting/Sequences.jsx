import { Link } from 'react-router';
import { Plus, ListOrdered, Phone, Mail, ClipboardCheck, MessageSquare, Play } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader } from '../../components/ui.jsx';
import { useSequences } from '../../components/carriers/shared.jsx';

const ICON = { call: Phone, email: Mail, text: MessageSquare, task: ClipboardCheck };

export default function Sequences() {
  const { can } = useAuth();
  const q = useSequences();
  return (
    <div>
      <PageHeader title="Sequences" subtitle="Multi-day cadences of calls, emails, texts and tasks. Press Start to work today's steps in the power dialer; emails also send on their own from your connected mailbox."
        actions={can('automation.use') && <Button icon={Plus} to="/app/sequences/new">New sequence</Button>} />
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !q.data.items.length ? (
        <Card><EmptyState icon={ListOrdered} title="No sequences yet" action={can('automation.use') && <Button icon={Plus} to="/app/sequences/new">Create your first sequence</Button>}>
          A classic cadence: Day 1 call, Day 2 email, Day 4 call, Day 7 final follow-up.
        </EmptyState></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {q.data.items.map((s) => (
            <div key={s.id} className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-ui hover:border-line-strong">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/app/sequences/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                <Badge color={s.active ? 'green' : 'gray'}>{s.active ? 'Active' : 'Paused'}</Badge>
              </div>
              {s.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{s.description}</p>}
              <ol className="mt-3 flex flex-wrap gap-1.5">
                {s.steps.map((st, i) => {
                  const Icon = ICON[st.type] || ClipboardCheck;
                  return <li key={i} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs" title={st.type}><Icon className="size-3" />Day {st.dayOffset + 1}</li>;
                })}
              </ol>
              <div className="mt-auto flex items-end justify-between gap-3 pt-3">
                <p className="text-xs text-muted tabular">
                  {s.enrollments.active || 0} active · {s.enrollments.paused || 0} paused · {s.enrollments.completed || 0} completed
                </p>
                <Button size="sm" icon={Play} to={s.enrollments.active ? `/app/dialer?sequenceId=${s.id}` : undefined} disabled={!s.enrollments.active} title={s.enrollments.active ? undefined : 'Enroll carriers first'}>Start</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
