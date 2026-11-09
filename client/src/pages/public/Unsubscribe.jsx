import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MailX, CheckCircle2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Button, ErrorState, Loading } from '../../components/ui.jsx';

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const q = useQuery({ queryKey: ['unsubscribe', token], queryFn: () => api.get('/api/public/unsubscribe', { token }), enabled: !!token });
  const confirm = useApiMutation(() => api.post(`/api/public/unsubscribe?token=${encodeURIComponent(token)}`), { invalidate: [['unsubscribe', token]] });
  const done = confirm.isSuccess || q.data?.unsubscribed;

  return (
    <div className="mx-auto max-w-md px-4 py-20">
      <div className="rounded-xl border border-line bg-surface p-6 text-center">
        {!token ? <ErrorState title="Missing link" error={{ message: 'Open the unsubscribe link from your email.' }} />
          : q.isLoading ? <Loading />
            : q.isError ? <ErrorState title="Link not valid" error={q.error} />
              : done ? (
                <>
                  <CheckCircle2 className="mx-auto size-9 text-green-600" />
                  <h1 className="mt-3 text-lg font-medium">You're unsubscribed</h1>
                  <p className="mt-1 text-sm text-muted"><strong>{q.data.email}</strong> will not receive further emails from {q.data.sender}.</p>
                </>
              ) : (
                <>
                  <MailX className="mx-auto size-9 text-muted" />
                  <h1 className="mt-3 text-lg font-medium">Unsubscribe?</h1>
                  <p className="mt-1 text-sm text-muted">Stop emails from <strong>{q.data.sender}</strong> to <strong>{q.data.email}</strong>.</p>
                  <Button className="mt-5 w-full" loading={confirm.isPending} onClick={() => confirm.mutate()}>Unsubscribe</Button>
                </>
              )}
      </div>
    </div>
  );
}
