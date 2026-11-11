import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { limitMonthStart } from '../lib/plans.js';
import { requirePermission } from '../middleware/auth.js';
import { makeLimiter, userOrIpKey } from '../middleware/security.js';
import { checkPublicHttpsUrl } from '../services/ai/providers/http.js';
import {
  aiConfig, platformQuota, byokActive, byokTarget, invalidateUserAi, testConnection,
  AI_PROVIDERS, AI_PURPOSES, DEFAULT_OPENAI_BASE_URL,
} from '../services/ai/llm.js';

/**
 * Per-user AI settings (/api/ai-settings, signed-in users; personal API tokens are refused by middleware/auth.js).
 *
 * Bring your own key: a user may store their own provider key (OpenAI-compatible or Claude by Anthropic). Calls then
 * use that key, are billed by their provider and do not count against the plan's monthly AI limit. The key is
 * encrypted at rest (lib/crypto.js) and never returned: only its last 4 characters (keyHint).
 *
 * An OpenAI-compatible base URL must be https on a public host (lib/netguard.js); calls to it connect to the vetted
 * address without following redirects (services/ai/providers/http.js). A saved key is only reused with the provider and
 * base URL it was saved for: changing either needs the key again, so a stolen session cannot send the key elsewhere.
 */
const r = Router();

const BYOK_SELECT = { aiProvider: true, aiBaseUrl: true, aiModel: true, aiKeyEnc: true, aiKeyHint: true };
const KEY_RE = /^[\x21-\x7e]{8,500}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

// A real call to the provider per test: a few per minute per user is plenty.
const testLimiter = makeLimiter('ai-key-test', 60_000, 5, 'Too many key tests. Try again in a minute.', { key: userOrIpKey });

const optText = (max) => z.string().trim().max(max).nullable().optional();
const configSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  baseUrl: optText(300),
  model: optText(120),
  apiKey: optText(500), // empty = keep the saved key
});

const ownRow = (userId) => prisma.user.findUnique({ where: { id: userId }, select: BYOK_SELECT });

/** https://host/path without a trailing slash, query or fragment. The host must be public. */
async function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || sameUrl(value, DEFAULT_OPENAI_BASE_URL)) return DEFAULT_OPENAI_BASE_URL;
  const { url } = await checkPublicHttpsUrl(value);
  if (url.search || url.hash) throw badRequest('Remove the ?query or #fragment from the base URL');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const sameUrl = (a, b) => String(a || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '') === String(b || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');

/** Validate provider settings against what is saved. Returns { provider, baseUrl, model, apiKey } (apiKey '' = keep). */
async function checkConfig(b, stored) {
  const provider = b.provider;
  const baseUrl = provider === 'openai' ? await normalizeBaseUrl(b.baseUrl) : null;
  const model = String(b.model || '').trim() || null;
  if (model && !MODEL_RE.test(model)) throw badRequest('The model name has characters that are not allowed');
  if (provider === 'anthropic' && model && !/^claude-/i.test(model)) throw badRequest('Claude model names start with claude-, for example claude-opus-5-5');
  if (provider === 'openai' && !model && new URL(baseUrl).hostname !== 'api.openai.com') {
    throw badRequest('Enter the model name your provider uses, for example llama-3.3-70b-versatile on Groq');
  }
  const apiKey = String(b.apiKey || '').trim();
  if (apiKey && !KEY_RE.test(apiKey)) throw badRequest('Paste the whole API key, without spaces');
  if (!apiKey) {
    if (!stored?.aiKeyEnc) throw badRequest('Enter your API key');
    if (stored.aiProvider !== provider || (provider === 'openai' && !sameUrl(stored.aiBaseUrl, baseUrl))) {
      throw badRequest('Enter your API key again: a saved key is only used with the provider and base URL it was saved for');
    }
  }
  return { provider, baseUrl, model, apiKey };
}

async function view(user) {
  const [row, cfg, quota, monthStart] = await Promise.all([ownRow(user.id), aiConfig(), platformQuota(user), limitMonthStart(user)]);
  const byokThisMonth = await prisma.aiUsageEvent.count({ where: { userId: user.id, byok: true, ok: true, createdAt: { gte: monthStart } } });
  return {
    platform: { available: cfg.configured, provider: cfg.configured ? cfg.provider : null, model: cfg.configured ? cfg.model : null },
    mine: {
      provider: row?.aiProvider || null,
      baseUrl: row?.aiProvider === 'openai' ? (row.aiBaseUrl || DEFAULT_OPENAI_BASE_URL) : null,
      model: row?.aiModel || null,
      keyHint: row?.aiKeyEnc ? row.aiKeyHint || null : null,
      active: byokActive(row),
    },
    // Platform calls this month against the plan limit (-1 = unlimited), and calls made with the user's own key.
    usage: { thisMonth: quota.used, limit: quota.limit, byokThisMonth },
  };
}

r.get('/', ah(async (req, res) => {
  res.json(await view(req.user));
}));

r.put('/', ah(async (req, res) => {
  const b = parse(configSchema, req.body);
  const stored = await ownRow(req.user.id);
  const c = await checkConfig(b, stored);
  await prisma.user.update({
    where: { id: req.user.id },
    data: {
      aiProvider: c.provider, aiBaseUrl: c.baseUrl, aiModel: c.model,
      ...(c.apiKey ? { aiKeyEnc: encrypt(c.apiKey), aiKeyHint: c.apiKey.slice(-4) } : {}),
    },
  });
  invalidateUserAi(req.user.id);
  await audit(req, 'ai.own_key_saved', { entityType: 'user', entityId: req.user.id, details: { provider: c.provider, newKey: !!c.apiKey } });
  res.json(await view(req.user));
}));

r.delete('/', ah(async (req, res) => {
  await prisma.user.update({ where: { id: req.user.id }, data: { aiProvider: null, aiBaseUrl: null, aiModel: null, aiKeyEnc: null, aiKeyHint: null } });
  invalidateUserAi(req.user.id);
  await audit(req, 'ai.own_key_removed', { entityType: 'user', entityId: req.user.id });
  res.json(await view(req.user));
}));

/**
 * One tiny real call with the key being entered (body with provider and apiKey), the saved key with changed model
 * (body with provider, no apiKey), or the saved settings (empty body). Nothing is saved. Counts as a call made with
 * the user's own key (purpose 'other').
 */
r.post('/test', testLimiter, ah(async (req, res) => {
  const b = parse(configSchema.partial(), req.body || {});
  const stored = await ownRow(req.user.id);
  let target;
  if (b.provider) {
    const c = await checkConfig(b, stored);
    let key = c.apiKey;
    if (!key) { try { key = decrypt(stored.aiKeyEnc); } catch { key = null; } }
    if (!key) throw badRequest('Your saved key could not be read. Enter it again.');
    target = byokTarget({ aiProvider: c.provider, aiBaseUrl: c.baseUrl, aiModel: c.model }, key);
  } else if (byokActive(stored)) {
    let key = null;
    try { key = decrypt(stored.aiKeyEnc); } catch { key = null; }
    if (!key) throw badRequest('Your saved key could not be read. Enter it again.');
    target = byokTarget(stored, key);
  } else {
    throw badRequest('Enter an API key to test');
  }
  const result = await testConnection(target, { user: req.user });
  res.json({ ok: result.ok, message: result.message, model: result.model || target.model, testedAt: new Date() });
}));

/** Admin cost overview: AI calls this calendar month (UTC) by purpose, and the users with the most platform calls. Counts only. */
r.get('/admin-usage', requirePermission('admin.access', 'admin.settings'), ah(async (req, res) => {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const where = { createdAt: { gte: since } };
  const [groups, top] = await Promise.all([
    prisma.aiUsageEvent.groupBy({ by: ['purpose', 'byok', 'ok'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true } }),
    prisma.aiUsageEvent.groupBy({ by: ['userId'], where: { ...where, byok: false }, _count: { userId: true }, orderBy: { _count: { userId: 'desc' } }, take: 10 }),
  ]);
  const byPurpose = new Map();
  const totals = { calls: 0, platform: 0, byok: 0, failed: 0, inputTokens: 0, outputTokens: 0, platformInputTokens: 0, platformOutputTokens: 0 };
  for (const g of groups) {
    const key = AI_PURPOSES.includes(g.purpose) ? g.purpose : 'other';
    const p = byPurpose.get(key) || { purpose: key, calls: 0, platform: 0, byok: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
    for (const t of [p, totals]) {
      t.calls += g._count._all;
      t[g.byok ? 'byok' : 'platform'] += g._count._all;
      if (!g.ok) t.failed += g._count._all;
      t.inputTokens += g._sum.inputTokens || 0;
      t.outputTokens += g._sum.outputTokens || 0;
    }
    if (!g.byok) {
      totals.platformInputTokens += g._sum.inputTokens || 0;
      totals.platformOutputTokens += g._sum.outputTokens || 0;
    }
    byPurpose.set(key, p);
  }
  const users = top.length ? await prisma.user.findMany({ where: { id: { in: top.map((t) => t.userId) } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  res.json({
    since,
    totals,
    byPurpose: [...byPurpose.values()].sort((a, b) => b.calls - a.calls),
    topUsers: top.map((t) => ({ id: t.userId, name: byId.get(t.userId)?.name || null, email: byId.get(t.userId)?.email || null, platformCalls: t._count.userId })),
  });
}));

export default r;
