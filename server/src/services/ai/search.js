import { getSettings } from '../../lib/settings.js';

export async function searchConfig() {
  const s = await getSettings(['search.provider', 'search.apiKey']);
  const provider = (s['search.provider'] || '').toLowerCase();
  return { provider, apiKey: s['search.apiKey'], configured: ['tavily', 'brave'].includes(provider) && !!s['search.apiKey'] };
}

/** Web research through the configured provider. Returns [{ title, url, snippet, date }]. Throws on provider errors. */
export async function webSearch(query, { max = 5 } = {}) {
  const cfg = await searchConfig();
  if (!cfg.configured) throw new Error('Web research is not configured (set search provider and API key in Admin → Settings)');
  const signal = AbortSignal.timeout(20000);
  if (cfg.provider === 'tavily') {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: max, search_depth: 'basic', include_answer: false }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Tavily error ${res.status}: ${data.detail?.error || data.error || 'search failed'}`);
    return (data.results || []).slice(0, max).map((x) => ({ title: x.title, url: x.url, snippet: String(x.content || '').slice(0, 800), date: x.published_date || null }));
  }
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(max) })}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.apiKey },
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Brave Search error ${res.status}`);
  return (data.web?.results || []).slice(0, max).map((x) => ({
    title: x.title, url: x.url, snippet: String(x.description || '').replace(/<[^>]+>/g, '').slice(0, 800), date: x.page_age || x.age || null,
  }));
}
