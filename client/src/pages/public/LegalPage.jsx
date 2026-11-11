import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

/**
 * Privacy policy / terms page. The text comes from the server (server/src/content/legal.js), the same HTML it writes
 * into the page for crawlers, so there is one source. Trusted, static, escaped server content.
 */
export default function LegalPage({ doc }) {
  const ssr = typeof window !== 'undefined' && window.__SSR_LEGAL__ && window.__SSR_LEGAL__.includes(`data-legal="${doc}"`) ? window.__SSR_LEGAL__ : null;
  const q = useQuery({ queryKey: ['legal', doc], queryFn: () => api.get(`/api/public/legal/${doc}`), staleTime: 5 * 60_000, enabled: !ssr });
  const html = ssr || q.data?.html;
  if (!html) {
    return <div className="mx-auto max-w-3xl px-4 py-14 text-sm text-muted">{q.isError ? 'This page could not be loaded. Refresh to try again.' : 'Loading…'}</div>;
  }
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
