import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Lock, ShieldCheck } from 'lucide-react';
import { date } from '../../lib/format.js';
import { Button, Loading } from '../../components/ui.jsx';
import { Logo } from '../../components/Logo.jsx';
import { DispatcherCard, StatementsView } from '../../components/portal/Statements.jsx';

/**
 * Portal API path for a link token. The token (and the week key) are encoded, so a crafted link such as
 * /portal/..%2F..%2Fcarriers cannot point the page at other API routes.
 */
const portalBase = (token) => `/api/public/portal/${encodeURIComponent(token)}`;

/** GET a portal endpoint without the session cookie: the public page never acts as the signed-in user. */
async function portalGet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'omit' });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Could not load this page (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Public carrier portal (/portal/:token): this carrier's weekly statements and its delivered loads' files, nothing else. */
export default function CarrierPortal() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ['portal', token], queryFn: () => portalGet(portalBase(token)), retry: false });
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur">
        <Logo compact />
        <span className="text-sm text-muted">Carrier portal</span>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 pb-10 pt-5">
        {q.isLoading ? <Loading /> : q.isError ? (
          <div className="mx-auto max-w-md rounded-2xl border border-line bg-surface p-6 text-center">
            <Lock className="mx-auto mb-3 size-6 text-muted" aria-hidden />
            <h1 className="text-lg font-medium">This link is not available</h1>
            <p className="mt-1 text-sm text-muted">{q.error.status === 404 ? 'It may have expired or been replaced. Ask your dispatcher for a new link.' : q.error.message}</p>
          </div>
        ) : (
          <>
            <section className="space-y-1">
              <p className="text-sm text-muted">Dispatch statements</p>
              <h1 className="text-2xl font-medium leading-tight">{q.data.carrier.companyName}</h1>
              <p className="font-mono text-xs tabular text-muted">{[q.data.carrier.mcNumber && `MC ${q.data.carrier.mcNumber}`, q.data.carrier.dotNumber && `USDOT ${q.data.carrier.dotNumber}`].filter(Boolean).join(' · ')}</p>
            </section>
            <DispatcherCard dispatcher={q.data.dispatcher} />
            <StatementsView base={portalBase(token)} docBase={`${portalBase(token)}/documents`} get={portalGet} summary={q.data} queryKey={['portal', token]} />
            <section className="rounded-2xl border border-line bg-surface p-4">
              <h2 className="font-medium">Your carrier profile</h2>
              <p className="mt-1 text-sm text-fg-2">Keep your W-9, insurance and authority in one place, see the statements of every dispatcher you work with, and share documents in one tap. Sign in with a code sent to the email FMCSA has for your USDOT number.</p>
              <Button className="mt-3" variant="secondary" icon={ShieldCheck} href="/carrier">Open my carrier profile</Button>
            </section>
            <p className="text-center text-xs text-muted">Read-only link{q.data.expiresAt ? `, valid until ${date(q.data.expiresAt)}` : ''}. It shows only your statements and the rate con, BOL and POD files of your delivered loads.</p>
          </>
        )}
      </main>
    </div>
  );
}
