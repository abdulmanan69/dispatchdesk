import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { PageHeader, QueryState } from '../../components/ui.jsx';
import { ChatThread } from '../../components/training/ChatThread.jsx';

export default function TrainerMessages() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['training', 'messages'], queryFn: () => api.get('/api/training/messages'), refetchInterval: 30000 });
  const send = useApiMutation((body) => api.post('/api/training/messages', { body }), { invalidate: [['training', 'messages']], success: 'Message sent to the trainers' });

  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/app/training" className="hover:underline">Training</Link>}
        title="Trainer messages"
        subtitle="Ask a trainer about dispatching, prospecting or the courses. Replies arrive here and in your notifications."
      />
      <div className="flex h-[min(70vh,640px)] flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <QueryState query={q}>
          {(d) => (
            <ChatThread
              messages={d.items}
              mine={(m) => m.author?.id === user.id}
              onSend={(body) => send.mutateAsync(body)}
              sending={send.isPending}
              placeholder="Type your question… (Ctrl+Enter to send)"
              emptyText="No messages yet. Ask your first question below."
            />
          )}
        </QueryState>
      </div>
    </>
  );
}
