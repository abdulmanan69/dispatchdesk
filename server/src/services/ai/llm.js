import { prisma } from '../../db.js';
import { getSettings } from '../../lib/settings.js';
import { decrypt } from '../../lib/crypto.js';
import { broadcast, onBroadcast } from '../../lib/broadcast.js';
import { effectivePlan, usage as planUsage } from '../../lib/plans.js';
import * as openai from './providers/openai.js';
import * as anthropic from './providers/anthropic.js';
import { aiError, errCode } from './providers/common.js';

/**
 * One entry point for every AI call: chat(messages, { user, purpose, temperature, maxTokens, json }).
 *
 * Who pays:
 * - The user's own key (bring your own key, Settings -> AI) when they saved one: no plan quota, billed by their provider.
 * - Otherwise the platform provider set by an admin (Admin -> System settings -> AI; 'ai.provider' openai | anthropic).
 *   Calls with a user count against the plan's monthlyAiMessages (AiUsageEvent rows, byok = false, ok = true, since
 *   the start of the user's month: the same counter Billing shows, lib/plans.js aiMonth).
 * - Neither: 503 AI_NOT_CONFIGURED. Calls without a user (system jobs such as knowledge ingestion) skip the quota.
 *
 * Every call with a user is recorded as an AiUsageEvent (purpose, byok, provider, model, tokens, ok). Error codes are
 * listed in providers/common.js.
 */

export const AI_PURPOSES = ['chat', 'draft_email', 'call_script', 'objection', 'analyze_load', 'sequence_email', 'negotiation', 'other'];
// Short drafting work runs Claude at low effort (see providers/anthropic.js); everything else uses the model default.
const LOW_EFFORT = new Set(['draft_email', 'objection', 'sequence_email']);
const normPurpose = (p) => (AI_PURPOSES.includes(p) ? p : 'other');

export const { DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } = openai;
export const { DEFAULT_ANTHROPIC_MODEL } = anthropic;
export const AI_PROVIDERS = ['openai', 'anthropic'];

export const NOT_CONFIGURED = 'AI not configured: an admin must set the AI provider in Admin → System settings → AI, or add your own key in Settings → AI.';
const NOT_CONFIGURED_USER = 'AI not configured: ask your admin to turn it on, or add your own key in Settings → AI.';
const NOT_CONFIGURED_ADMIN = 'AI not configured: set the AI provider and key in Admin → System settings → AI, or add your own key in Settings → AI.';
export const QUOTA_MESSAGE = 'Monthly AI limit reached for your plan. Upgrade or add your own key in Settings → AI.';

const isAdmin = (user) => !!user?.role?.permissions?.some?.((rp) => rp?.permission?.key === 'admin.settings');
export function notConfiguredError(user) {
  return aiError(503, user ? (isAdmin(user) ? NOT_CONFIGURED_ADMIN : NOT_CONFIGURED_USER) : NOT_CONFIGURED, 'AI_NOT_CONFIGURED');
}

// ---------------------------------------------------------------------------
// Platform provider (admin settings, 5 s settings cache invalidated in every process by lib/settings.js)
// ---------------------------------------------------------------------------

export async function aiConfig() {
  const s = await getSettings(['ai.provider', 'ai.baseUrl', 'ai.apiKey', 'ai.model', 'ai.embeddingModel']);
  const provider = s['ai.provider'] === 'anthropic' ? 'anthropic' : 'openai';
  const model = String(s['ai.model'] || '').trim();
  return {
    provider,
    baseUrl: (s['ai.baseUrl'] || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, ''),
    apiKey: s['ai.apiKey'],
    // ai.model defaults to an OpenAI model (AI_MODEL / gpt-4o-mini); for Claude only claude-* ids are used.
    model: provider === 'anthropic' ? (/^claude-/i.test(model) ? model : DEFAULT_ANTHROPIC_MODEL) : (model || DEFAULT_OPENAI_MODEL),
    // Anthropic has no embeddings endpoint: knowledge search falls back to keywords.
    embeddingModel: provider === 'anthropic' ? '' : (s['ai.embeddingModel'] || ''),
    configured: !!s['ai.apiKey'],
  };
}

const platformTarget = (cfg) => ({
  byok: false, guard: false, provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model,
  baseUrl: cfg.provider === 'openai' ? cfg.baseUrl : null, embeddingModel: cfg.embeddingModel,
});

// ---------------------------------------------------------------------------
// The user's own key (cached 30 s per process, at most 5000 users; dropped in every process on change)
// ---------------------------------------------------------------------------

const BYOK_TTL_MS = 30_000;
const BYOK_MAX = 5000;
const byokCache = new Map(); // userId -> { at, row }
let byokGeneration = 0;
onBroadcast('ai-user', (userId) => {
  byokGeneration += 1;
  if (userId) byokCache.delete(userId);
  else byokCache.clear();
});
/** A user's AI settings changed (or everyone's, without an id): drop cached copies in every process. */
export function invalidateUserAi(userId) { broadcast('ai-user', userId || null); }

const BYOK_SELECT = { aiProvider: true, aiBaseUrl: true, aiModel: true, aiKeyEnc: true, aiKeyHint: true };

async function byokRow(userId) {
  const hit = byokCache.get(userId);
  if (hit && Date.now() - hit.at < BYOK_TTL_MS) return hit.row;
  const gen = byokGeneration;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: BYOK_SELECT });
  if (gen === byokGeneration) {
    byokCache.delete(userId);
    if (byokCache.size >= BYOK_MAX) byokCache.delete(byokCache.keys().next().value);
    byokCache.set(userId, { at: Date.now(), row });
  }
  return row;
}

export const byokActive = (row) => !!(row?.aiProvider && row?.aiKeyEnc);

/** Target for a user's own provider settings ({ aiProvider, aiBaseUrl, aiModel }) and plain key. */
export function byokTarget(row, apiKey) {
  const provider = row.aiProvider === 'anthropic' ? 'anthropic' : 'openai';
  return {
    byok: true, guard: true, provider, apiKey,
    baseUrl: provider === 'openai' ? String(row.aiBaseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '') : null,
    model: row.aiModel || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL),
  };
}

/** Which provider a call for this user uses. Throws 503 AI_NOT_CONFIGURED when there is none. */
export async function resolveTarget(user) {
  if (user?.id) {
    const row = await byokRow(user.id);
    if (byokActive(row)) {
      let apiKey = null;
      try { apiKey = decrypt(row.aiKeyEnc); } catch { apiKey = null; }
      if (!apiKey) throw aiError(400, 'Your saved AI key could not be read. Enter it again in Settings → AI.', 'AI_KEY_UNREADABLE');
      return byokTarget(row, apiKey);
    }
  }
  const cfg = await aiConfig();
  if (!cfg.configured) throw notConfiguredError(user);
  return platformTarget(cfg);
}

// ---------------------------------------------------------------------------
// Plan quota for platform calls
// ---------------------------------------------------------------------------

/** Plans need the team membership and time zone; callers outside a request may pass only { id }. */
async function withPlanFields(user) {
  if (user.teamMembership !== undefined && 'timezone' in user) return user;
  return (await prisma.user.findUnique({ where: { id: user.id }, include: { teamMembership: true } })) || user;
}

/** { used, limit } of platform AI calls this month (limit -1 = unlimited). */
export async function platformQuota(user) {
  const full = await withPlanFields(user);
  const [{ plan }, counts] = await Promise.all([effectivePlan(full), planUsage(full, ['aiMonth'])]);
  return { used: counts.aiMonth, limit: plan?.monthlyAiMessages ?? 0 };
}

async function assertQuota(user) {
  const { used, limit } = await platformQuota(user);
  if (limit >= 0 && used >= limit) throw aiError(429, QUOTA_MESSAGE, 'AI_QUOTA', { limit, used });
}

/** Resolve the provider and check the quota before expensive preparation (context, web research). */
export async function assertAiReady(user) {
  const target = await resolveTarget(user);
  if (user?.id && !target.byok) await assertQuota(user);
  return target;
}

// ---------------------------------------------------------------------------
// Calls and usage events
// ---------------------------------------------------------------------------

async function record(userId, target, { purpose, model, inputTokens = 0, outputTokens = 0, ok }) {
  try {
    await prisma.aiUsageEvent.create({
      data: {
        userId, purpose, byok: !!target.byok, provider: target.provider, model: String(model || target.model || '').slice(0, 120) || null,
        inputTokens: Math.max(0, Math.round(Number(inputTokens) || 0)), outputTokens: Math.max(0, Math.round(Number(outputTokens) || 0)), ok,
      },
    });
  } catch (err) {
    console.error('[ai] usage event not recorded:', err.message);
  }
}

/** A platform key or model problem is for the admin to fix, not the user's request. */
function platformSafe(err, target) {
  if (target.byok) return err;
  const code = errCode(err);
  if (code === 'AI_KEY_REJECTED') return aiError(502, 'The AI provider rejected the platform API key. An admin must update it in Admin → System settings → AI.', 'AI_PLATFORM_KEY_REJECTED');
  if (code === 'AI_MODEL_NOT_FOUND') return aiError(502, `${err.message} An admin must update it in Admin → System settings → AI.`, 'AI_MODEL_NOT_FOUND');
  return err;
}

async function callTarget(target, messages, { user = null, purpose = 'other', temperature, maxTokens, json = false, effort } = {}) {
  const p = normPurpose(purpose);
  const impl = target.provider === 'anthropic' ? anthropic : openai;
  try {
    const r = await impl.complete(target, messages, { temperature, maxTokens, json, effort: effort ?? (LOW_EFFORT.has(p) ? 'low' : null) });
    if (user?.id) await record(user.id, target, { purpose: p, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: true });
    return r;
  } catch (err) {
    if (user?.id) await record(user.id, target, { purpose: p, model: err?.details?.model, ...(err?.details?.usage || {}), ok: false });
    throw platformSafe(err, target);
  }
}

/**
 * Chat completion. messages: [{ role: 'system' | 'user' | 'assistant', content }]. Returns the reply text.
 * Options: user (the acting user; omit only for system jobs), purpose (one of AI_PURPOSES, for usage reports),
 * temperature (OpenAI-compatible only), maxTokens (reply budget), json (ask for a JSON object; parse with
 * parseJsonReply). Throws HttpError with a code from providers/common.js.
 */
export async function chat(messages, { user = null, purpose = 'other', temperature = 0.3, maxTokens = 1200, json = false } = {}) {
  const target = await assertAiReady(user);
  return (await callTarget(target, messages, { user, purpose, temperature, maxTokens, json })).text;
}

/**
 * Embeddings for knowledge search with the platform provider only (stored vectors must all come from one model).
 * Returns null when there is no OpenAI-compatible embedding model (callers fall back to keyword search).
 */
export async function embed(texts) {
  const cfg = await aiConfig();
  if (!cfg.configured || cfg.provider !== 'openai' || !cfg.embeddingModel || !texts.length) return null;
  return openai.embed(platformTarget(cfg), texts);
}

/** One tiny real call to check a key. Records a usage event when a user is given. Never throws. */
export async function testConnection(target, { user = null } = {}) {
  const label = target.provider === 'anthropic' ? 'Claude by Anthropic' : 'the OpenAI-compatible provider';
  try {
    const r = await callTarget(target, [{ role: 'user', content: 'Reply with the single word OK.' }], { user, purpose: 'other', temperature: 0, maxTokens: 16, effort: 'low' });
    return { ok: true, message: `Connected to ${label}. Model ${r.model} answered.`, model: r.model };
  } catch (err) {
    const code = errCode(err);
    // The provider accepted the key and ran the model; only the tiny answer was unusable.
    if (code === 'AI_TRUNCATED' || code === 'AI_REFUSED') return { ok: true, message: `Connected to ${label}. The key works with model ${target.model}.`, model: target.model };
    return { ok: false, message: err?.message || 'The AI provider could not be reached', code };
  }
}

/** Admin -> System settings -> Test AI: the platform provider, whichever kind it is. */
export async function testPlatformAi() {
  const cfg = await aiConfig();
  if (!cfg.configured) return { ok: false, message: 'AI API key is not set' };
  return testConnection(platformTarget(cfg));
}

/** What the AI page and Settings show: which provider this user's calls use, and the plan usage for platform calls. */
export async function aiStatus(user) {
  const cfg = await aiConfig();
  const row = user?.id ? await byokRow(user.id) : null;
  const platform = { available: cfg.configured, provider: cfg.configured ? cfg.provider : null, model: cfg.configured ? cfg.model : null };
  if (byokActive(row)) {
    const t = byokTarget(row, '');
    return { available: true, source: 'byok', provider: t.provider, model: t.model, platform, usage: null };
  }
  if (!cfg.configured) return { available: false, source: null, provider: null, model: null, platform, usage: null, message: notConfiguredError(user).message };
  return { available: true, source: 'platform', provider: cfg.provider, model: cfg.model, platform, usage: user?.id ? await platformQuota(user) : null };
}

/** Parse a JSON object from a model reply (tolerates code fences). */
export function parseJsonReply(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}
