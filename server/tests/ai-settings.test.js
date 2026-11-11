import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { registerUser, createAdmin, prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { decrypt } from '../src/lib/crypto.js';
import { sdk } from '../src/services/ai/providers/anthropic.js';

// Calls to a user's own OpenAI-compatible base URL go through guardedFetch (public https hosts only). Here it keeps
// the real address check and hands the request to the stubbed global fetch, so no test reaches the network.
vi.mock('../src/services/ai/providers/http.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    guardedFetch: vi.fn(async (url, init) => {
      await actual.checkPublicHttpsUrl(url);
      return globalThis.fetch(url, { method: init.method, headers: init.headers, body: init.body });
    }),
  };
});

const realCreateClient = sdk.createClient;
let claudeCalls = [];
function fakeClaude(handler) {
  claudeCalls = [];
  sdk.createClient = (opts) => {
    const make = (endpoint) => vi.fn(async (params) => { claudeCalls.push({ endpoint, opts, params }); return handler(params); });
    return { messages: { create: make('messages') }, beta: { messages: { create: make('beta') } } };
  };
}
const claudeOk = () => ({ model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 2 } });

let fetchCalls = [];
function fakeOpenAI(status = 200) {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const json = status === 200 ? { model: 'llama-test', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 9, completion_tokens: 1 } } : { error: { message: 'Invalid API Key' } };
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }));
}

afterEach(() => { sdk.createClient = realCreateClient; vi.unstubAllGlobals(); });
afterAll(async () => { await setSetting('ai.apiKey', ''); await setSetting('ai.provider', ''); });

const KEY = 'sk-ant-api03-secret-value-AbCd';

describe('/api/ai-settings: bring your own key', () => {
  it('validates input: provider, https only, public hosts, model and key rules', async () => {
    const { agent: a, user } = await registerUser();
    const put = (body) => a.put('/api/ai-settings').send(body);
    expect((await put({ provider: 'cohere', apiKey: KEY })).status).toBe(400);
    expect((await put({ provider: 'anthropic' })).body.error).toMatch(/Enter your API key/);
    expect((await put({ provider: 'anthropic', apiKey: 'short' })).status).toBe(400);
    expect((await put({ provider: 'anthropic', apiKey: 'has a space in it' })).status).toBe(400);
    expect((await put({ provider: 'anthropic', apiKey: KEY, model: 'gpt-4o' })).body.error).toMatch(/claude-/);
    expect((await put({ provider: 'openai', apiKey: KEY, baseUrl: 'http://api.groq.com/openai/v1', model: 'llama' })).body.error).toMatch(/https/);
    expect((await put({ provider: 'openai', apiKey: KEY, baseUrl: 'https://127.0.0.1:8080/v1', model: 'llama' })).body.error).toMatch(/public/);
    expect((await put({ provider: 'openai', apiKey: KEY, baseUrl: 'https://localhost/v1', model: 'llama' })).status).toBe(400);
    expect((await put({ provider: 'openai', apiKey: KEY, baseUrl: 'https://llm.private-net.test/v1', model: 'llama' })).body.error).toMatch(/public/);
    expect((await put({ provider: 'openai', apiKey: KEY, baseUrl: 'https://api.groq.com/openai/v1' })).body.error).toMatch(/model name/);
    expect((await put({ provider: 'openai', apiKey: KEY, baseUrl: 'https://api.groq.com/openai/v1?x=1', model: 'llama' })).status).toBe(400);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).aiKeyEnc).toBeNull();
  });

  it('stores the key encrypted, never returns it, and keeps it only for the same provider and URL', async () => {
    const { agent: a, user } = await registerUser();
    const saved = await a.put('/api/ai-settings').send({ provider: 'anthropic', apiKey: KEY });
    expect(saved.status).toBe(200);
    expect(saved.body.mine).toEqual({ provider: 'anthropic', baseUrl: null, model: null, keyHint: 'AbCd', active: true });
    expect(JSON.stringify(saved.body)).not.toContain('secret-value');
    const got = await a.get('/api/ai-settings');
    expect(JSON.stringify(got.body)).not.toContain('secret-value');
    expect(got.body).toMatchObject({ platform: { available: expect.any(Boolean) }, usage: { thisMonth: 0, limit: expect.any(Number), byokThisMonth: 0 } });

    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row.aiKeyEnc).not.toContain('secret-value');
    expect(row.aiKeyEnc.startsWith('v1.')).toBe(true);
    expect(decrypt(row.aiKeyEnc)).toBe(KEY);

    // Model change without the key: allowed. Provider or base URL change without the key: refused.
    const model = await a.put('/api/ai-settings').send({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: '' });
    expect(model.status).toBe(200);
    expect(model.body.mine).toMatchObject({ model: 'claude-sonnet-5-5', keyHint: 'AbCd', active: true });
    expect((await a.put('/api/ai-settings').send({ provider: 'openai', model: 'gpt-4o-mini' })).body.error).toMatch(/key again/);
    expect(decrypt((await prisma.user.findUnique({ where: { id: user.id } })).aiKeyEnc)).toBe(KEY);

    // Owner only: another user sees and changes nothing of it.
    const { agent: b } = await registerUser();
    expect((await b.get('/api/ai-settings')).body.mine).toMatchObject({ provider: null, keyHint: null, active: false });
    await b.delete('/api/ai-settings').expect(200);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).aiKeyEnc).toBeTruthy();

    // The AI page reports the user's own key, and calls use it (no quota).
    await setSetting('ai.apiKey', '');
    const st = await a.get('/api/ai/status');
    expect(st.body).toMatchObject({ configured: true, source: 'byok', provider: 'anthropic', model: 'claude-sonnet-5-5', usage: null });

    const del = await a.delete('/api/ai-settings');
    expect(del.body.mine).toEqual({ provider: null, baseUrl: null, model: null, keyHint: null, active: false });
    const cleared = await prisma.user.findUnique({ where: { id: user.id } });
    expect([cleared.aiProvider, cleared.aiKeyEnc, cleared.aiKeyHint, cleared.aiModel, cleared.aiBaseUrl]).toEqual([null, null, null, null, null]);
    const off = await a.get('/api/ai/status');
    expect(off.body).toMatchObject({ configured: false, source: null });
    expect(off.body.message).toMatch(/Settings → AI/);
  });

  it('tests a key with one tiny real call (mocked provider) and records it as an own-key call', async () => {
    const { agent: a, user } = await registerUser();
    expect((await a.post('/api/ai-settings/test').send({})).status).toBe(400);

    // A key being entered, OpenAI-compatible provider on a custom base URL: nothing is saved.
    fakeOpenAI();
    const t1 = await a.post('/api/ai-settings/test').send({ provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1/', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_test_key_12345' });
    expect(t1.body).toMatchObject({ ok: true, model: 'llama-test' });
    expect(fetchCalls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(fetchCalls[0].init.headers.Authorization).toBe('Bearer gsk_test_key_12345');
    expect((await prisma.user.findUnique({ where: { id: user.id } })).aiKeyEnc).toBeNull();

    fakeOpenAI(401);
    const bad = await a.post('/api/ai-settings/test').send({ provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama', apiKey: 'gsk_wrong_key_000' });
    expect(bad.body).toMatchObject({ ok: false, message: 'The AI provider rejected the API key' });

    // The saved Claude key.
    await a.put('/api/ai-settings').send({ provider: 'anthropic', apiKey: KEY }).expect(200);
    fakeClaude(() => claudeOk());
    const t2 = await a.post('/api/ai-settings/test').send({});
    expect(t2.body).toMatchObject({ ok: true });
    expect(claudeCalls[0].opts.apiKey).toBe(KEY);
    expect(claudeCalls[0].params.output_config).toEqual({ effort: 'low' });

    fakeClaude(() => { throw new Anthropic.AuthenticationError(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()); });
    expect((await a.post('/api/ai-settings/test').send({})).body).toMatchObject({ ok: false, message: 'The AI provider rejected the API key' });

    const evs = await prisma.aiUsageEvent.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(evs.map((e) => [e.provider, e.byok, e.purpose, e.ok])).toEqual([
      ['openai', true, 'other', true], ['openai', true, 'other', false], ['anthropic', true, 'other', true], ['anthropic', true, 'other', false],
    ]);
    expect((await a.get('/api/ai-settings')).body.usage).toMatchObject({ thisMonth: 0, byokThisMonth: 2 });
  });

  it('lets only admins read the AI usage overview (counts only)', async () => {
    const { agent: user, user: u } = await registerUser();
    expect((await user.get('/api/ai-settings/admin-usage')).status).toBe(403);
    await prisma.aiUsageEvent.createMany({
      data: [
        ...[...Array(15)].map(() => ({ userId: u.id, purpose: 'chat', byok: false, provider: 'openai', inputTokens: 100, outputTokens: 20 })),
        { userId: u.id, purpose: 'chat', byok: true, provider: 'anthropic', inputTokens: 10, outputTokens: 2 },
        { userId: u.id, purpose: 'draft_email', byok: false, ok: false },
      ],
    });
    const { agent: admin } = await createAdmin();
    const res = await admin.get('/api/ai-settings/admin-usage');
    expect(res.status).toBe(200);
    const chat = res.body.byPurpose.find((p) => p.purpose === 'chat');
    expect(chat).toMatchObject({ calls: expect.any(Number), platform: expect.any(Number), byok: expect.any(Number) });
    expect(chat.calls).toBeGreaterThanOrEqual(16);
    expect(chat.inputTokens).toBeGreaterThanOrEqual(1510);
    expect(res.body.totals.failed).toBeGreaterThanOrEqual(1);
    const me = res.body.topUsers.find((t) => t.id === u.id);
    expect(me).toMatchObject({ platformCalls: 16 });
    expect(Object.keys(me).sort()).toEqual(['email', 'id', 'name', 'platformCalls']);
  });

  it('requires a session', async () => {
    const { agent } = await import('./helpers.js');
    const anon = await agent();
    expect((await anon.get('/api/ai-settings')).status).toBe(401);
  });
});
