import { getSettings } from '../../lib/settings.js';
import { unavailable, HttpError } from '../../lib/errors.js';

export async function aiConfig() {
  const s = await getSettings(['ai.baseUrl', 'ai.apiKey', 'ai.model', 'ai.embeddingModel']);
  return {
    baseUrl: (s['ai.baseUrl'] || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: s['ai.apiKey'],
    model: s['ai.model'] || 'gpt-4o-mini',
    embeddingModel: s['ai.embeddingModel'] || '',
    configured: !!s['ai.apiKey'],
  };
}

export const NOT_CONFIGURED = 'AI not configured — an admin must set the AI provider (base URL, API key, model) in Admin → Settings.';

async function post(cfg, path, body) {
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    throw new HttpError(502, `AI provider unreachable: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new HttpError(502, `AI provider error: ${msg}`);
  }
  return data;
}

/** OpenAI-compatible chat completion. messages: [{role, content}] */
export async function chat(messages, { temperature = 0.3, maxTokens = 1200, json = false } = {}) {
  const cfg = await aiConfig();
  if (!cfg.configured) throw unavailable(NOT_CONFIGURED);
  const data = await post(cfg, '/chat/completions', {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, 'AI provider returned an empty response');
  return content.trim();
}

/** Embeddings when an embedding model is configured; returns null otherwise. */
export async function embed(texts) {
  const cfg = await aiConfig();
  if (!cfg.configured || !cfg.embeddingModel || !texts.length) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const data = await post(cfg, '/embeddings', { model: cfg.embeddingModel, input: texts.slice(i, i + 64) });
    for (const d of data.data || []) out.push(d.embedding);
  }
  return out.length === texts.length ? out : null;
}

/** Parse a JSON object from a model reply (tolerates code fences). */
export function parseJsonReply(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}
