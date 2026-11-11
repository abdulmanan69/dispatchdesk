import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { num } from '../../lib/format.js';

export const PURPOSE_LABEL = {
  chat: 'Chat', draft_email: 'Email drafts', call_script: 'Call scripts', objection: 'Objection answers',
  analyze_load: 'Load analysis', sequence_email: 'Sequence emails', negotiation: 'Negotiations', other: 'Other (key tests, misc.)',
};

/**
 * AI calls this month for cost control (Admin -> System settings -> AI). Platform calls cost the platform; calls made
 * with users' own keys are shown for context only. Counts and token totals only, never content.
 */
export default function AiUsage() {
  const q = useQuery({ queryKey: ['admin', 'ai-usage'], queryFn: ({ signal }) => api.get('/api/ai-settings/admin-usage', undefined, { signal }) });
  const d = q.data;
  if (!d?.totals) return null;
  const month = new Date(d.since).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <section className="mt-5 border-t border-line pt-4" aria-labelledby="ai-usage-title">
      <h3 id="ai-usage-title" className="text-sm font-medium">AI usage in {month}</h3>
      <p className="mt-0.5 text-xs text-muted">
        {num(d.totals.platform)} calls on the platform key, {num(d.totals.byok)} with users' own keys{d.totals.failed ? `, ${num(d.totals.failed)} failed` : ''}.
        Platform key tokens: {num(d.totals.platformInputTokens ?? 0)} in, {num(d.totals.platformOutputTokens ?? 0)} out.
      </p>
      {d.byPurpose?.length ? (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted"><th className="py-1 pr-2 font-medium">Purpose</th><th className="py-1 pr-2 text-right font-medium">Platform</th><th className="py-1 pr-2 text-right font-medium">Own key</th><th className="py-1 text-right font-medium">Failed</th></tr></thead>
              <tbody className="divide-y divide-line">
                {d.byPurpose.map((p) => (
                  <tr key={p.purpose}>
                    <td className="py-1 pr-2">{PURPOSE_LABEL[p.purpose] || p.purpose}</td>
                    <td className="py-1 pr-2 text-right tabular">{num(p.platform)}</td>
                    <td className="py-1 pr-2 text-right tabular">{num(p.byok)}</td>
                    <td className="py-1 text-right tabular">{num(p.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <p className="text-xs font-medium">Most platform calls</p>
            {d.topUsers?.length ? (
              <ol className="mt-1 space-y-0.5 text-xs">
                {d.topUsers.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{u.name || 'Unknown user'} <span className="text-muted">{u.email}</span></span>
                    <span className="tabular">{num(u.platformCalls)}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="mt-1 text-xs text-muted">No platform calls yet.</p>}
          </div>
        </div>
      ) : <p className="mt-2 text-xs text-muted">No AI calls this month yet.</p>}
    </section>
  );
}
