import { Link } from 'react-router';
import { BadgeCheck, Send } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { relative } from '../../lib/format.js';
import { Badge, Button } from '../ui.jsx';

/**
 * Teams, on a carrier: who signed it, whether it waits for a dispatcher or which dispatcher has it, and
 * "Hand to dispatch" for a signed carrier nobody dispatches yet. Hidden outside a team.
 */
export default function TeamHandoff({ carrier: c, canWrite }) {
  const user = useAuth()?.user; // no session context (tests, embeds): nothing to show
  const handoff = useApiMutation(() => api.post(`/api/teams/handoffs/${c.id}`), {
    invalidate: [['carrier', c.id], ['carriers'], ['team']],
    success: (d) => (d.status === 'assigned' ? 'Handed to the next dispatcher in turn' : 'Sent to your manager to assign a dispatcher'),
  });
  if (!user?.team) return null;
  const lead = user.team.role === 'owner' || user.team.role === 'manager';
  const signed = c.stage?.key === 'customer';
  const canHand = canWrite && signed && c.handoffStatus !== 'pending' && !(c.handoffStatus === 'assigned' && c.assignedTo);
  if (!c.soldBy && !c.handoffStatus && !canHand) return null;
  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-sm">
      {c.soldBy && (
        <p className="flex items-center gap-1.5 text-fg-2"><BadgeCheck className="size-4 text-c-green" aria-hidden />Signed by <span className="font-medium text-fg">{c.soldBy.name}</span></p>
      )}
      {c.handoffStatus === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="amber">Waiting for a dispatcher</Badge>
          {c.handoffAt && <span className="text-xs text-muted">since {relative(c.handoffAt)}</span>}
          {lead && <Link to="/app/team?tab=assign" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">Assign in Team</Link>}
        </div>
      )}
      {c.handoffStatus === 'assigned' && c.assignedTo && (
        <p className="text-fg-2">With <span className="font-medium text-fg">{c.assignedTo.name}</span> for dispatch{c.handoffAt ? ` since ${relative(c.handoffAt)}` : ''}</p>
      )}
      {canHand && (
        <Button size="sm" variant="secondary" icon={Send} loading={handoff.isPending} onClick={() => handoff.mutate()}>Hand to dispatch</Button>
      )}
    </div>
  );
}
