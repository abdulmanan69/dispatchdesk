import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { registerUser, prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { encrypt } from '../src/lib/crypto.js';
import { usage, invalidatePlans, startOfUserMonth } from '../src/lib/plans.js';
import { setNetLookup } from '../src/lib/netguard.js';
import { chat, embed, aiStatus, invalidateUserAi, testPlatformAi, AI_PURPOSES } from '../src/services/ai/llm.js';
import { sdk, toAnthropicMessages, complete as claudeComplete } from '../src/services/ai/providers/anthropic.js';
import { complete as openaiComplete } from '../src/services/ai/providers/openai.js';
import { guardedFetch, checkPublicHttpsUrl } from '../src/services/ai/providers/http.js';
import { pruneAiUsage, aiUsageCutoff, jobs as retentionJobs } from '../src/jobs/extra/ai-usage-retention.js';

// No test reaches a real AI provider: fetch is stubbed for OpenAI-compatible calls and the Anthropic SDK client is
// replaced through `sdk.createClient`.

const realCreateClient = sdk.createClient;
let claudeCalls = [];

/** Fake Anthropic SDK client. handler(params, endpoint) returns a Message or throws an SDK error. */
function fakeClaude(handler) {
  claudeCalls = [];
  sdk.createClient = (opts) => {
    const make = (endpoint) => vi.fn(async (params) => { claudeCalls.push({ endpoint, opts, params }); return handler(params, endpoint); });
    return { messages: { create: make('messages') }, beta: { messages: { create: make('beta') } } };
  };
}

const claudeReply = (text, extra = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text }],
  stop_reason: 'end_turn', stop_details: null,
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  ...extra,
});

const sdkError = (Cls, status, message) => new Cls(status, { type: 'error', error: { type: 'x', message } }, message, new Headers());

let openaiCalls = [];
/** Fake OpenAI-compatible endpoint. respond(url, body) returns { status, json } or throws. */
function fakeOpenAI(respond = () => ({ status: 200, json: { model: 'gpt-test', choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 7 } } })) {
  openaiCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    openaiCalls.push({ url: String(url), init, body });
    const r = await respond(String(url), body);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function platform({ provider = '', apiKey = '', model = '' } = {}) {
  await setSetting('ai.provider', provider);
  await setSetting('ai.apiKey', apiKey);
  await setSetting('ai.model', model);
  await setSetting('ai.embeddingModel', '');
}

async function ownKey(userId, { provider = 'anthropic', baseUrl = null, model = null, key = 'sk-ant-user-key-9876' } = {}) {
  await prisma.user.update({ where: { id: userId }, data: { aiProvider: provider, aiBaseUrl: baseUrl, aiModel: model, aiKeyEnc: encrypt(key), aiKeyHint: key.slice(-4) } });
  invalidateUserAi(userId);
}

const fullUser = (id) => prisma.user.findUnique({ where: { id }, include: { role: { include: { permissions: { include: { permission: true } } } }, teamMembership: true } });
const events = (userId) => prisma.aiUsageEvent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

afterEach(() => { sdk.createClient = realCreateClient; vi.unstubAllGlobals(); });
afterAll(() => platform());

describe('Claude message mapping', () => {
  it('joins system messages into `system`, merges same-role turns and starts and ends with the user', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: 'You are a dispatcher.' },
      { role: 'system', content: 'Today is Monday.' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'Reply' },
    ], { json: true });
    expect(out.system).toBe('You are a dispatcher.\n\nToday is Monday.\n\nReply with only a JSON object, with no text before or after it.');
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(out.messages[2].content).toBe('First\n\nSecond');
    expect(out.messages.at(-1).content).toBe('Continue.');
  });
});

describe('Claude provider (SDK mocked)', () => {
  const target = { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-opus-5-5' };

  it('sends no sampling or thinking parameters, low effort when asked, and the refusal fallback on Opus 5.5', async () => {
    fakeClaude(() => claudeReply('Draft ready'));
    const r = await claudeComplete(target, [{ role: 'system', content: 'Sys' }, { role: 'user', content: 'Hi' }], { maxTokens: 1200, effort: 'low' });
    expect(r).toMatchObject({ text: 'Draft ready', model: 'claude-opus-5-5', inputTokens: 125, outputTokens: 30 });
    const { endpoint, opts, params } = claudeCalls[0];
    expect(endpoint).toBe('beta');
    expect(opts).toMatchObject({ apiKey: 'sk-ant-test', timeout: 90_000 });
    expect(params).toMatchObject({ model: 'claude-opus-5-5', system: 'Sys', messages: [{ role: 'user', content: 'Hi' }], output_config: { effort: 'low' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(params.max_tokens).toBeGreaterThanOrEqual(4096);
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(params).not.toHaveProperty(k);
  });

  it('leaves effort at the model default unless asked, and skips effort and fallback on models without them', async () => {
    fakeClaude(() => claudeReply('ok'));
    await claudeComplete(target, [{ role: 'user', content: 'Hi' }], {});
    expect(claudeCalls[0].params).not.toHaveProperty('output_config');
    await claudeComplete({ ...target, model: 'claude-haiku-4-5' }, [{ role: 'user', content: 'Hi' }], { effort: 'low' });
    expect(claudeCalls[1].endpoint).toBe('messages');
    expect(claudeCalls[1].params).not.toHaveProperty('output_config');
    expect(claudeCalls[1].params).not.toHaveProperty('fallbacks');
  });

  it('retries once without the fallback beta when the beta request is rejected', async () => {
    fakeClaude((params, endpoint) => {
      if (endpoint === 'beta') throw sdkError(Anthropic.BadRequestError, 400, 'Unexpected value(s) for the anthropic-beta header');
      return claudeReply('Plain answer');
    });
    const r = await claudeComplete(target, [{ role: 'user', content: 'Hi' }], {});
    expect(r.text).toBe('Plain answer');
    expect(claudeCalls.map((c) => c.endpoint)).toEqual(['beta', 'messages']);
    expect(claudeCalls[1].params).not.toHaveProperty('betas');
    expect(claudeCalls[1].params).not.toHaveProperty('fallbacks');
  });

  it('turns a refusal into a readable 502 and handles max_tokens', async () => {
    fakeClaude(() => claudeReply('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }));
    await expect(claudeComplete(target, [{ role: 'user', content: 'x' }], {})).rejects.toMatchObject({ status: 502, details: { code: 'AI_REFUSED', category: 'cyber' } });

    fakeClaude(() => claudeReply('', { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens' }));
    await expect(claudeComplete(target, [{ role: 'user', content: 'x' }], {})).rejects.toMatchObject({ status: 502, details: { code: 'AI_TRUNCATED' } });

    fakeClaude(() => claudeReply('{"subject": "Hi", "bo', { stop_reason: 'max_tokens' }));
    await expect(claudeComplete(target, [{ role: 'user', content: 'x' }], { json: true })).rejects.toMatchObject({ details: { code: 'AI_TRUNCATED' } });

    fakeClaude(() => claudeReply('A long answer that was cut', { stop_reason: 'max_tokens' }));
    expect((await claudeComplete(target, [{ role: 'user', content: 'x' }], {})).text).toBe('A long answer that was cut');
  });

  it('maps SDK error classes to HTTP errors', async () => {
    const cases = [
      [sdkError(Anthropic.AuthenticationError, 401, 'invalid x-api-key'), 400, 'AI_KEY_REJECTED', /rejected the API key/],
      [sdkError(Anthropic.NotFoundError, 404, 'model: nope'), 400, 'AI_MODEL_NOT_FOUND', /does not offer the model/],
      [sdkError(Anthropic.RateLimitError, 429, 'slow down'), 429, 'AI_PROVIDER_RATE_LIMIT', /rate limiting/],
      [sdkError(Anthropic.InternalServerError, 529, 'Overloaded'), 502, 'AI_PROVIDER_ERROR', /having trouble/],
      [new Anthropic.APIConnectionTimeoutError(), 502, 'AI_PROVIDER_ERROR', /did not answer in time/],
      [new Anthropic.APIConnectionError({ message: 'socket hang up' }), 502, 'AI_PROVIDER_ERROR', /unreachable/],
    ];
    for (const [err, status, code, msg] of cases) {
      fakeClaude(() => { throw err; });
      const p = claudeComplete({ ...target, model: 'claude-sonnet-4-6' }, [{ role: 'user', content: 'x' }], {});
      await expect(p).rejects.toMatchObject({ status, details: { code } });
      await expect(claudeComplete({ ...target, model: 'claude-sonnet-4-6' }, [{ role: 'user', content: 'x' }], {})).rejects.toThrow(msg);
    }
  });
});

describe('OpenAI-compatible provider (unchanged behaviour)', () => {
  it('posts the same chat completion request as before and returns the trimmed text', async () => {
    await platform({ apiKey: 'sk-platform', model: 'test-model' });
    fakeOpenAI(() => ({ status: 200, json: { choices: [{ message: { content: '  {"a":1}  ' } }] } }));
    const text = await chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { temperature: 0.4, maxTokens: 900, json: true });
    expect(text).toBe('{"a":1}');
    const { url, init, body } = openaiCalls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-platform', 'Content-Type': 'application/json' });
    expect(body).toEqual({ model: 'test-model', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], temperature: 0.4, max_tokens: 900, response_format: { type: 'json_object' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps provider failures to 502 (and a rejected key to 400 for the key owner)', async () => {
    const t = { provider: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm' };
    fakeOpenAI(() => ({ status: 500, json: { error: { message: 'boom' } } }));
    await expect(openaiComplete(t, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 502, message: 'AI provider error: boom' });
    fakeOpenAI(() => { throw new Error('ECONNREFUSED'); });
    await expect(openaiComplete(t, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 502, message: 'AI provider unreachable: ECONNREFUSED' });
    fakeOpenAI(() => ({ status: 200, json: { choices: [{ message: { content: '  ' } }] } }));
    await expect(openaiComplete(t, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 502, message: 'AI provider returned an empty response' });
    fakeOpenAI(() => ({ status: 401, json: { error: { message: 'Incorrect API key' } } }));
    await expect(openaiComplete(t, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 400, message: 'The AI provider rejected the API key', details: { code: 'AI_KEY_REJECTED' } });
    fakeOpenAI(() => ({ status: 429, json: {} }));
    await expect(openaiComplete(t, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 429, details: { code: 'AI_PROVIDER_RATE_LIMIT' } });

    // A rejected PLATFORM key is the admin's to fix: users get a 502 that says so.
    await platform({ apiKey: 'sk-bad', model: 'test-model' });
    fakeOpenAI(() => ({ status: 401, json: {} }));
    await expect(chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 502, details: { code: 'AI_PLATFORM_KEY_REJECTED' } });
  });
});

describe('provider resolution, quota and usage events', () => {
  beforeEach(() => platform());

  it('returns 503 AI_NOT_CONFIGURED with advice for the user, or for an admin', async () => {
    const { user } = await registerUser();
    const { user: admin } = await registerUser({ role: 'super_admin' });
    await expect(chat([{ role: 'user', content: 'x' }], { user: await fullUser(user.id) })).rejects.toMatchObject({ status: 503, details: { code: 'AI_NOT_CONFIGURED' }, message: expect.stringContaining('Settings → AI') });
    await expect(chat([{ role: 'user', content: 'x' }], { user: await fullUser(admin.id) })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('Admin → System settings → AI') });
    expect(await events(user.id)).toEqual([]);
    expect((await aiStatus(await fullUser(user.id))).available).toBe(false);
  });

  it('uses the user\'s own key before the platform provider, without quota, and records the call', async () => {
    await platform({ apiKey: 'sk-platform', model: 'test-model' });
    fakeOpenAI();
    fakeClaude(() => claudeReply('From your own Claude key'));
    const { user } = await registerUser();
    await ownKey(user.id, { provider: 'anthropic', key: 'sk-ant-own-1234' });
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    await prisma.plan.update({ where: { key: 'free' }, data: { monthlyAiMessages: 0 } });
    invalidatePlans();
    try {
      const u = await fullUser(user.id);
      expect(await chat([{ role: 'user', content: 'x' }], { user: u, purpose: 'draft_email' })).toBe('From your own Claude key');
      expect(openaiCalls).toHaveLength(0);
      expect(claudeCalls[0].opts.apiKey).toBe('sk-ant-own-1234');
      expect(claudeCalls[0].params.output_config).toEqual({ effort: 'low' }); // short drafting purpose
      const [ev] = await events(user.id);
      expect(ev).toMatchObject({ purpose: 'draft_email', byok: true, provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 125, outputTokens: 30, ok: true });
      expect((await usage(u, ['aiMonth'])).aiMonth).toBe(0); // own-key calls are not counted
      expect(await aiStatus(u)).toMatchObject({ available: true, source: 'byok', provider: 'anthropic' });
    } finally {
      await prisma.plan.update({ where: { key: 'free' }, data: { monthlyAiMessages: free.monthlyAiMessages } });
      invalidatePlans();
    }
  });

  it('counts platform calls against the plan, answers 429 AI_QUOTA at the limit, and records failures with ok=false', async () => {
    await platform({ apiKey: 'sk-platform', model: 'test-model' });
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    await prisma.plan.update({ where: { key: 'free' }, data: { monthlyAiMessages: 2 } });
    invalidatePlans();
    try {
      const { user } = await registerUser();
      const u = await fullUser(user.id);
      fakeOpenAI();
      await chat([{ role: 'user', content: 'one' }], { user: u, purpose: 'chat' });
      fakeOpenAI(() => ({ status: 500, json: { error: { message: 'down' } } }));
      await expect(chat([{ role: 'user', content: 'fails' }], { user: u, purpose: 'objection' })).rejects.toMatchObject({ status: 502 });
      fakeOpenAI();
      await chat([{ role: 'user', content: 'two' }], { user: u, purpose: 'not-a-purpose' });
      expect((await usage(u, ['aiMonth'])).aiMonth).toBe(2);
      await expect(chat([{ role: 'user', content: 'three' }], { user: u })).rejects.toMatchObject({ status: 429, details: { code: 'AI_QUOTA', limit: 2, used: 2 }, message: 'Monthly AI limit reached for your plan. Upgrade or add your own key in Settings → AI.' });
      const evs = await events(user.id);
      expect(evs.map((e) => [e.purpose, e.byok, e.ok, e.inputTokens, e.outputTokens])).toEqual([
        ['chat', false, true, 50, 7], ['objection', false, false, 0, 0], ['other', false, true, 50, 7],
      ]);
      expect(evs.every((e) => e.provider === 'openai' && AI_PURPOSES.includes(e.purpose))).toBe(true);
      expect(await aiStatus(u)).toMatchObject({ source: 'platform', usage: { used: 2, limit: 2 } });

      // Adding an own key lifts the limit for this user at once (cache dropped on change).
      fakeClaude(() => claudeReply('own'));
      await ownKey(user.id);
      expect(await chat([{ role: 'user', content: 'four' }], { user: u })).toBe('own');
    } finally {
      await prisma.plan.update({ where: { key: 'free' }, data: { monthlyAiMessages: free.monthlyAiMessages } });
      invalidatePlans();
    }
  });

  it('plans aiMonth counts successful platform calls since the start of the user month only', async () => {
    const { user } = await registerUser();
    const u = await fullUser(user.id);
    const start = startOfUserMonth(u.timezone);
    await prisma.aiUsageEvent.createMany({
      data: [
        { userId: user.id, purpose: 'chat', createdAt: new Date(start.getTime() - 60_000) },
        { userId: user.id, purpose: 'chat', createdAt: new Date(start.getTime() + 60_000) },
        { userId: user.id, purpose: 'chat', byok: true },
        { userId: user.id, purpose: 'chat', ok: false },
      ],
    });
    expect((await usage(u, ['aiMonth'])).aiMonth).toBe(1);
  });

  it('system calls without a user skip the quota and record nothing', async () => {
    await platform({ apiKey: 'sk-platform', model: 'test-model' });
    fakeOpenAI();
    const before = await prisma.aiUsageEvent.count();
    expect(await chat([{ role: 'user', content: 'x' }])).toBe('Hello there');
    expect(await prisma.aiUsageEvent.count()).toBe(before);
  });

  it('runs the platform on Claude when ai.provider is anthropic (Claude model default, no embeddings)', async () => {
    await platform({ provider: 'anthropic', apiKey: 'sk-ant-platform', model: '' });
    await setSetting('ai.embeddingModel', 'text-embedding-3-small');
    fakeClaude(() => claudeReply('Platform Claude'));
    const { user } = await registerUser();
    expect(await chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'x' }], { user: await fullUser(user.id), purpose: 'analyze_load', temperature: 0.9 })).toBe('Platform Claude');
    expect(claudeCalls[0].opts.apiKey).toBe('sk-ant-platform');
    expect(claudeCalls[0].params.model).toBe('claude-opus-5-5');
    expect(claudeCalls[0].params).not.toHaveProperty('temperature');
    expect(claudeCalls[0].params).not.toHaveProperty('output_config'); // analysis keeps the model's default effort
    expect(await embed(['a', 'b'])).toBeNull();
    expect((await events(user.id))[0]).toMatchObject({ byok: false, provider: 'anthropic', purpose: 'analyze_load' });

    fakeClaude(() => claudeReply('OK'));
    expect(await testPlatformAi()).toMatchObject({ ok: true, message: expect.stringContaining('Claude by Anthropic') });
    fakeClaude(() => { throw sdkError(Anthropic.AuthenticationError, 401, 'invalid x-api-key'); });
    expect(await testPlatformAi()).toMatchObject({ ok: false, message: expect.stringContaining('platform API key') });
  });
});

describe('user base URLs (guarded fetch)', () => {
  it('accepts only https URLs on public hosts', async () => {
    await expect(checkPublicHttpsUrl('http://api.example.test/v1')).rejects.toMatchObject({ status: 400 });
    await expect(checkPublicHttpsUrl('https://user:pw@api.example.test/v1')).rejects.toMatchObject({ status: 400 });
    await expect(checkPublicHttpsUrl('https://127.0.0.1/v1')).rejects.toMatchObject({ status: 400 });
    await expect(checkPublicHttpsUrl('https://localhost/v1')).rejects.toMatchObject({ status: 400 });
    await expect(checkPublicHttpsUrl('https://llm.private-net.test/v1')).rejects.toMatchObject({ status: 400 });
    await expect(guardedFetch('https://169.254.169.254/latest/meta-data', { body: '{}' })).rejects.toMatchObject({ status: 400 });
    const ok = await checkPublicHttpsUrl('https://api.groq.com/openai/v1');
    expect(ok.target.address).toBe('93.184.215.14');
  });

  it('refuses a host that resolves to a private address at call time', async () => {
    const prev = setNetLookup(async () => [{ address: '10.1.2.3', family: 4 }]);
    try {
      await expect(guardedFetch('https://rebind.example.test/v1/chat/completions', { body: '{}' })).rejects.toMatchObject({ status: 400 });
    } finally { setNetLookup(prev); }
  });
});

describe('AI usage retention job', () => {
  it('deletes events older than 13 months in batches and keeps newer ones', async () => {
    const { user } = await registerUser();
    const now = new Date('2026-11-12T10:00:00Z');
    expect(aiUsageCutoff(now).toISOString()).toBe('2025-10-12T10:00:00.000Z');
    const old = new Date('2025-09-30T00:00:00Z');
    await prisma.aiUsageEvent.createMany({ data: [...Array(7)].map(() => ({ userId: user.id, purpose: 'chat', createdAt: old })) });
    await prisma.aiUsageEvent.create({ data: { userId: user.id, purpose: 'chat', createdAt: new Date('2025-11-01T00:00:00Z') } });
    expect(await pruneAiUsage(now, { batch: 3 })).toBeGreaterThanOrEqual(7);
    expect(await prisma.aiUsageEvent.count({ where: { userId: user.id } })).toBe(1);
    expect(retentionJobs).toEqual([expect.objectContaining({ name: 'ai-usage-retention', dailyAtUtc: expect.any(Number), run: expect.any(Function) })]);
  });
});
