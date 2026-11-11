import { HttpError } from '../../../lib/errors.js';
import { aiError } from './common.js';
import { guardedFetch } from './http.js';

/**
 * OpenAI-compatible chat completions and embeddings (OpenAI, Google Gemini, Groq, OpenRouter, local gateways).
 * target: { baseUrl, apiKey, model, embeddingModel?, guard }. `guard` is set for a user's own base URL: the request then
 * goes through providers/http.js (public https hosts only, no redirects). Platform URLs set by an admin use fetch.
 */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 90_000;

async function post(target, path, body) {
  const url = `${target.baseUrl}${path}`;
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  let res;
  try {
    res = target.guard
      ? await guardedFetch(url, { ...init, timeoutMs: TIMEOUT_MS })
      : await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof HttpError) throw err; // a refused (non-public) address
    throw aiError(502, `AI provider unreachable: ${err.message}`, 'AI_PROVIDER_ERROR');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw aiError(400, 'The AI provider rejected the API key', 'AI_KEY_REJECTED');
    if (res.status === 429) throw aiError(429, 'The AI provider is rate limiting requests. Try again in a minute.', 'AI_PROVIDER_RATE_LIMIT');
    throw aiError(502, `AI provider error: ${msg}`, 'AI_PROVIDER_ERROR');
  }
  return data;
}

/** One chat completion. Returns { text, model, inputTokens, outputTokens, stopReason }. */
export async function complete(target, messages, { temperature = 0.3, maxTokens = 1200, json = false } = {}) {
  const data = await post(target, '/chat/completions', {
    model: target.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  const usage = { inputTokens: Number(data?.usage?.prompt_tokens) || 0, outputTokens: Number(data?.usage?.completion_tokens) || 0 };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw aiError(502, 'AI provider returned an empty response', 'AI_PROVIDER_ERROR', { usage });
  return { text: content.trim(), model: data?.model || target.model, stopReason: data?.choices?.[0]?.finish_reason || null, ...usage };
}

/** Embeddings in batches of 64. Returns null when no embedding model is set or the count does not match. */
export async function embed(target, texts) {
  if (!target.embeddingModel || !texts.length) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const data = await post(target, '/embeddings', { model: target.embeddingModel, input: texts.slice(i, i + 64) });
    for (const d of data.data || []) out.push(d.embedding);
  }
  return out.length === texts.length ? out : null;
}
