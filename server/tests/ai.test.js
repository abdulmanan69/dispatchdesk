import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser, createAdmin, prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { analyzeLoadNumbers } from '../src/services/ai/loadMath.js';
import { chunkText } from '../src/services/ai/rag.js';

const realFetch = globalThis.fetch;
let llmCalls = [];

/** Fake OpenAI-compatible provider + Tavily; records request bodies. */
function installFetch({ reply = 'Answer from model [1].', tavily } = {}) {
  llmCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/chat/completions')) {
      const body = JSON.parse(opts.body);
      llmCalls.push(body);
      const content = typeof reply === 'function' ? reply(body) : reply;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.tavily.com/')) {
      return new Response(JSON.stringify(tavily || { results: [{ title: 'Diesel report', url: 'https://example.test/diesel', content: 'Average diesel was reported.', published_date: '2026-11-01' }] }), { status: 200 });
    }
    return realFetch(url, opts);
  }));
}

const configure = async () => { await setSetting('ai.apiKey', 'sk-test'); await setSetting('ai.model', 'test-model'); };
const unconfigure = async () => { await setSetting('ai.apiKey', ''); await setSetting('search.provider', ''); await setSetting('search.apiKey', ''); };

afterEach(() => vi.unstubAllGlobals());
afterAll(unconfigure);

describe('AI when not configured', () => {
  beforeAll(unconfigure);
  it('reports status and returns 503 without storing or faking an answer', async () => {
    const { agent: a } = await registerUser();
    const st = await a.get('/api/ai/status');
    expect(st.body.configured).toBe(false);
    expect(st.body.message).toMatch(/AI not configured/);
    const conv = await a.post('/api/ai/conversations').send({});
    const res = await a.post(`/api/ai/conversations/${conv.body.conversation.id}/messages`).send({ content: 'Hello' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/AI not configured/);
    expect(await prisma.aIMessage.count({ where: { conversationId: conv.body.conversation.id } })).toBe(0);
    expect((await a.post('/api/ai/draft-email').send({ purpose: 'carrier_intro' })).status).toBe(503);
  });
});

describe('AI dispatcher', () => {
  beforeAll(configure);

  it('answers with knowledge sources and keeps each user\'s documents private', async () => {
    installFetch();
    const A = await registerUser();
    const B = await registerUser();
    const up = await A.agent.post('/api/ai/knowledge')
      .field('title', 'Secret rate sheet')
      .attach('file', Buffer.from('Our private reefer lane from Fresno to Dallas pays well. Zebracode 7741.'), { filename: 'lanes.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);
    expect(up.body.document.status).toBe('ready');

    const convA = (await A.agent.post('/api/ai/conversations').send({})).body.conversation;
    const resA = await A.agent.post(`/api/ai/conversations/${convA.id}/messages`).send({ content: 'What about the Fresno reefer lane zebracode?' });
    expect(resA.status).toBe(201);
    expect(resA.body.message.content).toBe('Answer from model [1].');
    expect(resA.body.message.sources[0]).toMatchObject({ kind: 'knowledge', title: 'Secret rate sheet' });
    expect(JSON.stringify(llmCalls[0].messages)).toContain('Zebracode 7741');

    const convB = (await B.agent.post('/api/ai/conversations').send({})).body.conversation;
    const resB = await B.agent.post(`/api/ai/conversations/${convB.id}/messages`).send({ content: 'What about the Fresno reefer lane zebracode?' });
    expect(resB.status).toBe(201);
    expect(resB.body.message.sources).toEqual([]);
    expect(JSON.stringify(llmCalls[1].messages)).not.toContain('Zebracode');

    expect((await B.agent.get(`/api/ai/conversations/${convA.id}`)).status).toBe(404);
    expect((await B.agent.delete(`/api/ai/knowledge/${up.body.document.id}`)).status).toBe(404);
    expect((await B.agent.get('/api/ai/knowledge')).body.items).toHaveLength(0);

    const conv = await A.agent.get(`/api/ai/conversations/${convA.id}`);
    expect(conv.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conv.body.conversation.title).toMatch(/Fresno/);
  });

  it('only admins can publish shared knowledge, which everyone can then retrieve', async () => {
    installFetch();
    const U = await registerUser();
    const denied = await U.agent.post('/api/ai/knowledge').field('scope', 'global')
      .attach('file', Buffer.from('x y z'), { filename: 'g.txt', contentType: 'text/plain' });
    expect(denied.status).toBe(403);
    const admin = await createAdmin();
    const ok = await admin.agent.post('/api/ai/knowledge').field('scope', 'global').field('title', 'Carrier packet checklist')
      .attach('file', Buffer.from('A carrier packet includes the W-9, COI and MC authority letter. Quokkaword.'), { filename: 'packet.md', contentType: 'text/markdown' });
    expect(ok.status).toBe(201);
    const conv = (await U.agent.post('/api/ai/conversations').send({})).body.conversation;
    const res = await U.agent.post(`/api/ai/conversations/${conv.id}/messages`).send({ content: 'What is in a carrier packet quokkaword?' });
    expect(res.body.message.sources.some((s) => s.title === 'Carrier packet checklist')).toBe(true);
    await admin.agent.patch(`/api/ai/knowledge/${ok.body.document.id}`).send({ approved: false }).expect(200);
    const res2 = await U.agent.post(`/api/ai/conversations/${conv.id}/messages`).send({ content: 'What is in a carrier packet quokkaword?' });
    expect(res2.body.message.sources.some((s) => s.title === 'Carrier packet checklist')).toBe(false);
    await admin.agent.delete(`/api/ai/knowledge/${ok.body.document.id}`).expect(200);
  });

  it('adds web sources with dates when research is enabled, and reports when it is not configured', async () => {
    installFetch();
    const { agent: a } = await registerUser();
    const conv = (await a.post('/api/ai/conversations').send({})).body.conversation;
    const noWeb = await a.post(`/api/ai/conversations/${conv.id}/messages`).send({ content: 'diesel price today', useWeb: true });
    expect(noWeb.body.notes[0]).toMatch(/no search provider/);
    await setSetting('search.provider', 'tavily');
    await setSetting('search.apiKey', 'tvly-test');
    const web = await a.post(`/api/ai/conversations/${conv.id}/messages`).send({ content: 'diesel price today', useWeb: true });
    expect(web.body.message.sources[0]).toMatchObject({ kind: 'web', url: 'https://example.test/diesel', date: '2026-11-01' });
    await setSetting('search.provider', '');
  });

  it('includes only the requesting user\'s carrier context', async () => {
    installFetch();
    const A = await registerUser();
    const B = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    const carrier = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: stage.id, companyName: 'Hidden Haulers', mcNumber: '1010' } });
    const conv = (await B.agent.post('/api/ai/conversations').send({})).body.conversation;
    const res = await B.agent.post(`/api/ai/conversations/${conv.id}/messages`).send({ content: 'Tell me about this carrier', carrierId: carrier.id });
    expect(res.status).toBe(404);
    const convA = (await A.agent.post('/api/ai/conversations').send({})).body.conversation;
    await A.agent.post(`/api/ai/conversations/${convA.id}/messages`).send({ content: 'Tell me about this carrier', carrierId: carrier.id }).expect(201);
    expect(JSON.stringify(llmCalls.at(-1).messages)).toContain('Hidden Haulers');
  });

  it('drafts emails, scripts and objection responses', async () => {
    const { agent: a } = await registerUser();
    installFetch({ reply: (body) => (body.response_format ? '```json\n{"subject":"Freight for your truck","body":"Hi there"}\n```' : '## Script') });
    const d = await a.post('/api/ai/draft-email').send({ purpose: 'carrier_intro', notes: 'dry van, TX' });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ subject: 'Freight for your truck', body: 'Hi there', aiGenerated: true });
    expect((await a.post('/api/ai/call-script').send({ scenario: 'cold_call' })).body.script).toBe('## Script');
    expect((await a.post('/api/ai/objection').send({ objection: 'I already have a dispatcher' })).status).toBe(200);
    const convs = await a.get('/api/ai/conversations');
    expect(convs.body.items.map((c) => c.title)).toEqual(expect.arrayContaining(['Tool: Email drafts', 'Tool: Call scripts']));
  });

  it('analyzes loads with deterministic numbers', async () => {
    installFetch({ reply: 'Looks workable.' });
    const { agent: a } = await registerUser();
    const res = await a.post('/api/ai/analyze-load').send({ rate: 2500, loadedMiles: 1000, deadheadMiles: 250, mpg: 6.5, fuelPricePerGallon: 3.9, dispatchFeePercent: 8 });
    expect(res.status).toBe(200);
    expect(res.body.numbers.ratePerMile).toBe(2.5);
    expect(res.body.numbers.allInRatePerMile).toBe(2);
    expect(res.body.commentary).toBe('Looks workable.');
    expect(llmCalls[0].messages.at(-1).content).toContain('"ratePerMile": 2.5');
  });

  it('enforces the monthly AI message limit', async () => {
    installFetch();
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    await prisma.plan.update({ where: { key: 'free' }, data: { monthlyAiMessages: 1 } });
    try {
      const { agent: a } = await registerUser();
      const conv = (await a.post('/api/ai/conversations').send({})).body.conversation;
      await a.post(`/api/ai/conversations/${conv.id}/messages`).send({ content: 'one' }).expect(201);
      const second = await a.post(`/api/ai/conversations/${conv.id}/messages`).send({ content: 'two' });
      expect(second.status).toBe(402);
    } finally {
      await prisma.plan.update({ where: { key: 'free' }, data: { monthlyAiMessages: free.monthlyAiMessages } });
    }
  });

  it('requires a session', async () => {
    const { agent } = await import('./helpers.js');
    const anon = await agent();
    expect((await anon.get('/api/ai/status')).status).toBe(401);
  });
});

describe('pure helpers', () => {
  it('computes load economics', () => {
    const n = analyzeLoadNumbers({ rate: 3000, loadedMiles: 1200, deadheadMiles: 0, detentionHours: 2, detentionRate: 50 });
    expect(n).toMatchObject({ ratePerMile: 2.5, detentionPay: 100, grossRevenue: 3100, fuelCost: null });
  });
  it('chunks text into bounded pieces', () => {
    const chunks = chunkText('para one.\n\n'.repeat(400));
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(1500);
  });
});
