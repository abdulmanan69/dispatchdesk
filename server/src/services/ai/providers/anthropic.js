import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../../../lib/errors.js';
import { aiError } from './common.js';

/**
 * Claude through the official Anthropic SDK (Messages API).
 *
 * Request choices (current Claude API):
 * - Default model claude-opus-5-5 when none is set.
 * - No temperature / top_p / top_k: the current API rejects sampling parameters (400).
 * - No `thinking` parameter: Opus 5.5 always runs adaptive thinking and rejects `disabled`. Depth is set with
 *   output_config.effort instead: 'low' for short drafting purposes (email drafts, objection answers, sequence
 *   emails, the connection test), the model default (medium on Opus 5.5) for everything else, where reasoning
 *   quality matters (chat, call scripts, load analysis, negotiation). Effort is only sent to models that accept it.
 * - Thinking tokens share max_tokens with the reply, so the caller's reply budget is multiplied (at least 4096, at
 *   most 16000: the non-streaming ceiling the SDK guidance recommends).
 * - System-role messages are joined into the top-level `system`; user/assistant turns keep their order, consecutive
 *   same-role turns are merged, and the list always starts and ends with a user turn (no assistant prefill).
 * - json mode: the system prompt asks for only a JSON object; callers parse it with parseJsonReply().
 * - stop_reason 'refusal' becomes a readable 502 (AI_REFUSED). 'max_tokens' without a usable answer (or in json mode)
 *   becomes AI_TRUNCATED; a cut-off plain-text answer is returned as is.
 * - Server-side refusal fallback (beta server-side-fallback-2026-07-01, fallbacks: 'default') for the models the
 *   Claude API guidance enables it on. If the beta request is rejected as invalid (400), the call is retried once on
 *   the standard endpoint without it, so an organization without the beta still works.
 * - 90 s timeout, one SDK retry. SDK error classes map to HttpError (401/403 key rejected, 404 unknown model,
 *   429 provider rate limit, 5xx and connection problems 502).
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 90_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const EFFORT_MODELS = /^claude-(fable|mythos|opus-5|opus-4-[5-9]|sonnet-5|sonnet-4-6|haiku-5)/;
const JSON_INSTRUCTION = 'Reply with only a JSON object, with no text before or after it.';

/** Replaceable in tests (the SDK client is mocked; tests never reach the real API). */
export const sdk = { createClient: (opts) => new Anthropic(opts) };

export const supportsEffort = (model) => EFFORT_MODELS.test(String(model || ''));

/** Our [{role, content}] list to { system, messages } for the Messages API. */
export function toAnthropicMessages(messages, { json = false } = {}) {
  const system = [];
  const turns = [];
  for (const m of messages || []) {
    const content = typeof m?.content === 'string' ? m.content : m?.content == null ? '' : String(m.content);
    if (!content.trim()) continue;
    if (m.role === 'system') { system.push(content); continue; }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  if (!turns.length || turns[0].role !== 'user') turns.unshift({ role: 'user', content: '(Earlier messages in this conversation are not shown.)' });
  if (turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: 'Continue.' });
  if (json) system.push(JSON_INSTRUCTION);
  return { system: system.join('\n\n'), messages: turns };
}

const usageOf = (res) => {
  const u = res?.usage || {};
  return {
    inputTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0),
    outputTokens: Number(u.output_tokens) || 0,
  };
};

const apiMessage = (err) => String(err?.error?.error?.message || err?.message || 'unknown error').slice(0, 300);

/** SDK error classes to HttpError, most specific first. */
export function mapAnthropicError(err, model) {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError) return aiError(400, 'The AI provider rejected the API key', 'AI_KEY_REJECTED');
  if (err instanceof Anthropic.PermissionDeniedError) return aiError(400, `The AI provider rejected the API key for this request: ${apiMessage(err)}`, 'AI_KEY_REJECTED');
  if (err instanceof Anthropic.NotFoundError) return aiError(400, `The AI provider does not offer the model "${model}" to this key. Check the model name.`, 'AI_MODEL_NOT_FOUND');
  if (err instanceof Anthropic.RateLimitError) return aiError(429, 'The AI provider is rate limiting requests. Try again in a minute.', 'AI_PROVIDER_RATE_LIMIT');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return aiError(502, 'The AI provider did not answer in time. Try again.', 'AI_PROVIDER_ERROR');
  if (err instanceof Anthropic.APIConnectionError) return aiError(502, `AI provider unreachable: ${apiMessage(err)}`, 'AI_PROVIDER_ERROR');
  if (err instanceof Anthropic.InternalServerError) return aiError(502, `The AI provider is having trouble (${err.status || 'server error'}). Try again shortly.`, 'AI_PROVIDER_ERROR');
  if (err instanceof Anthropic.APIError) return aiError(502, `AI provider error: ${apiMessage(err)}`, 'AI_PROVIDER_ERROR');
  return aiError(502, `AI provider error: ${apiMessage(err)}`, 'AI_PROVIDER_ERROR');
}

/** One Messages API call. Returns { text, model, inputTokens, outputTokens, stopReason }. */
export async function complete(target, messages, { maxTokens = 1200, json = false, effort = null } = {}) {
  const model = target.model || DEFAULT_ANTHROPIC_MODEL;
  const client = sdk.createClient({ apiKey: target.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  const { system, messages: turns } = toAnthropicMessages(messages, { json });
  const params = {
    model,
    max_tokens: Math.min(16_000, Math.max(4096, Math.round(Number(maxTokens) || 0) * 4)),
    ...(system ? { system } : {}),
    messages: turns,
    ...(effort && supportsEffort(model) ? { output_config: { effort } } : {}),
  };

  let res;
  try {
    if (FALLBACK_MODELS.has(model)) {
      try {
        res = await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' });
      } catch (err) {
        if (!(err instanceof Anthropic.BadRequestError)) throw err;
        res = await client.messages.create(params);
      }
    } else {
      res = await client.messages.create(params);
    }
  } catch (err) {
    throw mapAnthropicError(err, model);
  }

  const usage = usageOf(res);
  const servedBy = res?.model || model;
  if (res?.stop_reason === 'refusal') {
    const category = res?.stop_details?.category || null;
    throw aiError(502, 'Claude declined to answer this request. Rephrase it and try again.', 'AI_REFUSED', { category, usage, model: servedBy });
  }
  const text = (res?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('').trim();
  if (res?.stop_reason === 'max_tokens' && (!text || json)) {
    throw aiError(502, 'The AI reply was cut off before it finished. Try a shorter request.', 'AI_TRUNCATED', { usage, model: servedBy });
  }
  if (!text) throw aiError(502, 'AI provider returned an empty response', 'AI_PROVIDER_ERROR', { usage, model: servedBy });
  return { text, model: servedBy, stopReason: res?.stop_reason || null, ...usage };
}
