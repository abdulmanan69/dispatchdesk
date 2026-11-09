import { useParams, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { date, label } from '../../lib/format.js';
import { Button, Loading, ErrorState } from '../../components/ui.jsx';

export default function AcceptInvite() {
  const { token } = useParams();
  const { user, refresh, loading } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['invite', token, user?.id], queryFn: () => api.get(`/api/teams/invitations/${token}`), enabled: !loading });
  const accept = useApiMutation(() => api.post(`/api/teams/invitations/${token}/accept`), {
    success: (d) => `You joined ${d.team.name}`,
    invalidate: [['team']],
    onSuccess: async () => { await refresh(); navigate('/app/team'); },
  });
  const next = encodeURIComponent(`/invite/${token}`);

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-xl border border-line bg-surface p-6">
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"><Users className="size-5" /></div>
        {loading || q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} title="Invitation not available" /> : (
          <>
            <h1 className="text-lg font-medium">Join {q.data.team}</h1>
            <p className="mt-1 text-sm text-muted">{q.data.invitedBy} invited <span className="font-medium text-fg">{q.data.email}</span> to join as {label(q.data.role).toLowerCase()}.</p>
            {q.data.status !== 'pending' ? (
              <p className="mt-4 rounded-md bg-surface-2 px-3 py-2 text-sm">This invitation is {q.data.status}. Ask the team owner for a new link.</p>
            ) : !user ? (
              <div className="mt-5 space-y-2">
                <p className="text-sm text-muted">Sign in or create an account with the invited email address to accept.</p>
                <div className="flex gap-2">
                  <Button className="flex-1" to={`/register?next=${next}`}>Create account</Button>
                  <Button variant="secondary" className="flex-1" to={`/login?next=${next}`}>Log in</Button>
                </div>
              </div>
            ) : q.data.emailMatches === false ? (
              <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">You're signed in as {user.email}. Log in with the invited email to accept this invitation.</p>
            ) : (
              <div className="mt-5">
                {user.team && <p className="mb-3 text-sm text-red-600">You're already in {user.team.name}. Leave that team before joining another.</p>}
                <Button className="w-full" loading={accept.isPending} disabled={!!user.team} onClick={() => accept.mutate()}>Accept invitation</Button>
                <p className="mt-2 text-center text-xs text-muted">Expires {date(q.data.expiresAt)}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
