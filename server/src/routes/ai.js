import { Router } from 'express';
import fs from 'node:fs';
import { prisma } from '../db.js';
import { ah, badRequest, notFound, forbidden } from '../lib/errors.js';
import { parse, z, reqStr, optStr, optNum } from '../lib/validate.js';
import { loadCarrier, loadOwned } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { aiLimiter } from '../middleware/security.js';
import { uploader, verifyFileSignature, removeFile } from '../middleware/upload.js';
import { aiConfig, aiStatus, assertAiReady, chat, parseJsonReply } from '../services/ai/llm.js';
import { retrieve, ingestDocument } from '../services/ai/rag.js';
import { webSearch, searchConfig } from '../services/ai/search.js';
import { SYSTEM_PROMPT, SUGGESTED_QUESTIONS, EMAIL_PURPOSES } from '../services/ai/prompts.js';
import { analyzeLoadNumbers } from '../services/ai/loadMath.js';

const r = Router();
r.use(requirePermission('ai.use'));
r.post('*', aiLimiter);

const knowledgeUpload = uploader('knowledge', 'knowledge', 20);
const dateStr = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// AI errors carry a code (services/ai/providers/common.js): 503 AI_NOT_CONFIGURED, 429 AI_QUOTA (plan limit, platform
// calls only), 429 AI_PROVIDER_RATE_LIMIT, 400 AI_KEY_REJECTED, 502 AI_REFUSED / AI_TRUNCATED / AI_PROVIDER_ERROR.
// assertAiReady() checks the provider and the plan quota before context and web research are gathered; chat() checks
// again, records the usage event and counts the call.

/** The requesting user's own pipeline summary — counts only, never other users' data. */
async function pipelineContext(user) {
  const rows = await prisma.carrier.groupBy({ by: ['stageId'], where: { ownerId: user.id }, _count: true });
  const stages = await prisma.pipelineStage.findMany();
  const name = Object.fromEntries(stages.map((s) => [s.id, s.name]));
  const pendingFollowUps = await prisma.followUp.count({ where: { userId: user.id, status: 'pending' } });
  const parts = rows.map((r0) => `${name[r0.stageId]}: ${r0._count}`);
  return `Current user's pipeline (counts): ${parts.length ? parts.join(', ') : 'no carriers yet'}; pending follow-ups: ${pendingFollowUps}.`;
}

async function carrierContext(user, carrierId) {
  const c = await loadCarrier(user, carrierId, {
    include: {
      stage: true,
      notes: { orderBy: { createdAt: 'desc' }, take: 5 },
      calls: { orderBy: { calledAt: 'desc' }, take: 5 },
      contacts: { take: 3 },
    },
  });
  const lines = [
    `Selected carrier: ${c.companyName}${c.dbaName ? ` (DBA ${c.dbaName})` : ''}`,
    `MC: ${c.mcNumber || 'unknown'}, USDOT: ${c.dotNumber || 'unknown'}, location: ${[c.city, c.state].filter(Boolean).join(', ') || 'unknown'}`,
    `Equipment: ${c.equipment || 'unknown'}, fleet size: ${c.fleetSize ?? 'unknown'}, pipeline stage: ${c.stage?.name}`,
    `Authority status on file: ${c.authorityStatus || 'unknown'} (source: ${c.source}${c.verifiedAt ? `, last verified ${dateStr(c.verifiedAt)}` : ', not verified'})`,
    c.contacts.length ? `Contacts: ${c.contacts.map((x) => `${x.name}${x.title ? ` (${x.title})` : ''}`).join('; ')}` : null,
    c.calls.length ? `Recent calls: ${c.calls.map((x) => `${dateStr(x.calledAt)} ${x.outcome}${x.notes ? ` — ${x.notes.slice(0, 120)}` : ''}`).join(' | ')}` : null,
    c.notes.length ? `Recent notes: ${c.notes.map((n) => n.body.slice(0, 160)).join(' | ')}` : null,
  ].filter(Boolean);
  return { carrier: c, text: lines.join('\n') };
}

async function brokerContext(user, brokerId) {
  const b = await loadOwned('broker', user, brokerId);
  return { broker: b, text: `Broker: ${b.companyName}${b.contactName ? `, contact ${b.contactName}` : ''}${b.mcNumber ? `, MC ${b.mcNumber}` : ''}${b.paymentTerms ? `, terms ${b.paymentTerms}` : ''}` };
}

/** Gather numbered sources (knowledge + web). Web failures are reported, never hidden. */
async function gatherSources(user, query, { useKnowledge, useWeb }) {
  const sources = [];
  const notes = [];
  if (useKnowledge) {
    for (const k of await retrieve(user.id, query, 5)) {
      sources.push({ kind: 'knowledge', title: k.title, date: dateStr(k.date), content: k.content, documentId: k.documentId });
    }
  }
  if (useWeb) {
    const sc = await searchConfig();
    if (!sc.configured) notes.push('Web research was requested but no search provider is configured.');
    else {
      try {
        for (const w of await webSearch(query, { max: 5 })) sources.push({ kind: 'web', title: w.title, url: w.url, date: w.date ? String(w.date).slice(0, 10) : null, content: w.snippet });
      } catch (err) {
        notes.push(`Web research failed: ${err.message}`);
      }
    }
  }
  return { sources, notes };
}

function sourcesBlock(sources) {
  if (!sources.length) return null;
  return `Numbered sources (cite as [n]):\n${sources.map((s, i) => `[${i + 1}] (${s.kind}) ${s.title}${s.url ? ` <${s.url}>` : ''}${s.date ? ` — dated ${s.date}` : ''}\n${s.content}`).join('\n\n')}`;
}

const publicSources = (sources) => sources.map(({ kind, title, url, date, documentId }) => ({ kind, title, url: url || null, date: date || null, documentId: documentId || null }));

// ---------------------------------------------------------------------------
// Status & conversations
// ---------------------------------------------------------------------------
r.get('/status', async (req, res, next) => {
  try {
    const [st, cfg, sc, own, global] = await Promise.all([
      aiStatus(req.user), aiConfig(), searchConfig(),
      prisma.aIKnowledgeDocument.count({ where: { ownerId: req.user.id, scope: 'private' } }),
      prisma.aIKnowledgeDocument.count({ where: { scope: 'global', approved: true } }),
    ]);
    res.json({
      // source: 'byok' (the user's own key, no plan quota) | 'platform' (usage: { used, limit }, -1 = unlimited) | null
      configured: st.available, model: st.model, provider: st.provider, source: st.source, usage: st.usage,
      embeddings: !!(cfg.configured && cfg.embeddingModel),
      webSearch: sc.configured, searchProvider: sc.configured ? sc.provider : null,
      knowledge: { own, global }, suggestions: SUGGESTED_QUESTIONS, message: st.available ? null : st.message,
    });
  } catch (err) { next(err); }
});

r.get('/conversations', ah(async (req, res) => {
  const items = await prisma.aIConversation.findMany({
    where: { userId: req.user.id }, orderBy: { updatedAt: 'desc' }, take: 100,
    include: { _count: { select: { messages: true } } },
  });
  res.json({ items });
}));

r.post('/conversations', ah(async (req, res) => {
  const b = parse(z.object({ title: optStr(120) }), req.body);
  const conv = await prisma.aIConversation.create({ data: { userId: req.user.id, title: b.title || 'New conversation' } });
  res.status(201).json({ conversation: conv });
}));

async function ownConversation(req) {
  const c = await prisma.aIConversation.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
  if (!c) throw notFound('Conversation not found');
  return c;
}

const serializeMessage = (m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [] });

r.get('/conversations/:id', ah(async (req, res) => {
  const c = await ownConversation(req);
  const messages = await prisma.aIMessage.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: 'asc' } });
  res.json({ conversation: c, messages: messages.map(serializeMessage) });
}));

r.patch('/conversations/:id', ah(async (req, res) => {
  const c = await ownConversation(req);
  const b = parse(z.object({ title: reqStr(120) }), req.body);
  res.json({ conversation: await prisma.aIConversation.update({ where: { id: c.id }, data: { title: b.title } }) });
}));

r.delete('/conversations/:id', ah(async (req, res) => {
  const c = await ownConversation(req);
  await prisma.aIConversation.delete({ where: { id: c.id } });
  res.json({ ok: true });
}));

r.post('/conversations/:id/messages', ah(async (req, res) => {
  const c = await ownConversation(req);
  const b = parse(z.object({
    content: reqStr(8000),
    useWeb: z.boolean().default(false),
    useKnowledge: z.boolean().default(true),
    carrierId: optStr(60),
  }), req.body);
  await assertAiReady(req.user);

  const context = [await pipelineContext(req.user)];
  if (b.carrierId) context.push((await carrierContext(req.user, b.carrierId)).text);
  const { sources, notes } = await gatherSources(req.user, b.content, b);
  const history = await prisma.aIMessage.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: 'desc' }, take: 12 });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Today is ${dateStr(new Date())}.\n${context.join('\n')}` },
    ...(sourcesBlock(sources) ? [{ role: 'system', content: sourcesBlock(sources) }] : []),
    ...(notes.length ? [{ role: 'system', content: `Notes for the assistant: ${notes.join(' ')} Tell the user if this affects the answer.` }] : []),
    ...history.reverse().map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: b.content },
  ];
  const answer = await chat(messages, { user: req.user, purpose: 'chat', temperature: 0.3, maxTokens: 1400 });

  const userMsg = await prisma.aIMessage.create({ data: { conversationId: c.id, role: 'user', content: b.content } });
  const assistant = await prisma.aIMessage.create({
    data: { conversationId: c.id, role: 'assistant', content: answer, sources: sources.length ? JSON.stringify(publicSources(sources)) : null },
  });
  await prisma.aIConversation.update({
    where: { id: c.id },
    data: { updatedAt: new Date(), ...(c.title === 'New conversation' ? { title: b.content.slice(0, 60) } : {}) },
  });
  res.status(201).json({ userMessage: serializeMessage(userMsg), message: serializeMessage(assistant), notes });
}));

// ---------------------------------------------------------------------------
// One-shot tools (stored in a per-tool conversation so they appear in history and count toward usage)
// ---------------------------------------------------------------------------
async function runTool(req, toolTitle, prompt, { purpose = 'other', json = false, temperature = 0.4, maxTokens = 1200, extraSystem = [] } = {}) {
  const answer = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    ...extraSystem.map((content) => ({ role: 'system', content })),
    { role: 'user', content: prompt },
  ], { user: req.user, purpose, json, temperature, maxTokens });
  let conv = await prisma.aIConversation.findFirst({ where: { userId: req.user.id, title: toolTitle } });
  if (!conv) conv = await prisma.aIConversation.create({ data: { userId: req.user.id, title: toolTitle } });
  await prisma.aIMessage.createMany({
    data: [
      { conversationId: conv.id, role: 'user', content: prompt.slice(0, 8000) },
      { conversationId: conv.id, role: 'assistant', content: answer },
    ],
  });
  await prisma.aIConversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } });
  return answer;
}

r.post('/draft-email', ah(async (req, res) => {
  const b = parse(z.object({
    purpose: z.enum(Object.keys(EMAIL_PURPOSES)).default('carrier_intro'),
    carrierId: optStr(60), brokerId: optStr(60), notes: optStr(3000),
    tone: z.enum(['professional', 'friendly', 'direct']).default('professional'),
  }), req.body);
  const ctx = [];
  let carrier = null;
  if (b.carrierId) { const cc = await carrierContext(req.user, b.carrierId); carrier = cc.carrier; ctx.push(cc.text); }
  if (b.brokerId) ctx.push((await brokerContext(req.user, b.brokerId)).text);
  const prompt = `Write ${EMAIL_PURPOSES[b.purpose]}. Tone: ${b.tone}. Keep it under 160 words, plain text, no placeholders in square brackets except where information is truly unknown.
Sender: ${req.user.name}${req.user.phone ? `, phone ${req.user.phone}` : ''}. Do not include a signature block (it is added automatically).
${ctx.length ? `Context:\n${ctx.join('\n')}` : ''}
${b.notes ? `Dispatcher notes: ${b.notes}` : ''}
Return JSON: {"subject": "...", "body": "..."}`;
  const answer = await runTool(req, 'Tool: Email drafts', prompt, { purpose: 'draft_email', json: true, temperature: 0.5 });
  const parsed = parseJsonReply(answer);
  if (!parsed?.subject || !parsed?.body) throw badRequest('The AI response could not be parsed into an email. Try again.');
  if (carrier) await logActivity(req.user, { type: 'ai', carrierId: carrier.id, summary: `AI drafted an email for ${carrier.companyName}` });
  res.json({ subject: String(parsed.subject).slice(0, 300), body: String(parsed.body), aiGenerated: true });
}));

r.post('/call-script', ah(async (req, res) => {
  const b = parse(z.object({
    carrierId: optStr(60),
    scenario: z.enum(['cold_call', 'follow_up', 'voicemail', 'onboarding', 'custom']).default('cold_call'),
    notes: optStr(2000),
  }), req.body);
  const ctx = b.carrierId ? (await carrierContext(req.user, b.carrierId)).text : 'No specific carrier selected — write a general script.';
  const prompt = `Write a ${b.scenario.replace('_', ' ')} phone script for a truck dispatcher calling a carrier.
Structure: opener (first 15 seconds), qualifying questions (equipment, lanes, current load sources, MC age), value pitch, 3 likely objections with responses, close with a concrete next step. Use markdown headings and bullets.
${ctx}
${b.notes ? `Dispatcher notes: ${b.notes}` : ''}`;
  res.json({ script: await runTool(req, 'Tool: Call scripts', prompt, { purpose: 'call_script', temperature: 0.5, maxTokens: 1400 }) });
}));

r.post('/objection', ah(async (req, res) => {
  const b = parse(z.object({ objection: reqStr(1000), carrierId: optStr(60) }), req.body);
  const ctx = b.carrierId ? (await carrierContext(req.user, b.carrierId)).text : '';
  const prompt = `A carrier said: "${b.objection}". Give 3 short, honest responses a dispatcher can say on the phone (no pressure tactics, no false promises about rates), plus one question to keep the conversation going. ${ctx}`;
  res.json({ answer: await runTool(req, 'Tool: Objection handling', prompt, { purpose: 'objection', temperature: 0.5 }) });
}));

r.post('/analyze-load', ah(async (req, res) => {
  const b = parse(z.object({
    loadId: optStr(60),
    origin: optStr(120), destination: optStr(120), equipment: optStr(60), commodity: optStr(120), weightLbs: optNum(0, 200000),
    rate: optNum(0, 1e7), loadedMiles: optNum(0, 20000), deadheadMiles: optNum(0, 5000),
    fuelPricePerGallon: optNum(0, 50), mpg: optNum(0, 50), detentionHours: optNum(0, 500), detentionRate: optNum(0, 1000),
    otherCosts: optNum(0, 1e6), dispatchFeePercent: optNum(0, 100), notes: optStr(2000),
  }), req.body);
  let input = { ...b };
  if (b.loadId) {
    const l = await loadOwned('load', req.user, b.loadId);
    input = {
      ...input,
      origin: `${l.originCity}, ${l.originState}`, destination: `${l.destCity}, ${l.destState}`, equipment: l.equipment, commodity: l.commodity,
      weightLbs: l.weightLbs, rate: l.rateCents / 100, loadedMiles: l.loadedMiles, deadheadMiles: l.deadheadMiles,
      fuelPricePerGallon: l.fuelPricePerGallon ?? input.fuelPricePerGallon, mpg: l.mpg ?? input.mpg, detentionHours: l.detentionHours,
      detentionRate: l.detentionRateCents / 100, otherCosts: l.otherCostsCents / 100, dispatchFeePercent: l.dispatchFeePercent ?? input.dispatchFeePercent,
    };
  }
  if (!input.rate || !input.loadedMiles) throw badRequest('Rate and loaded miles are required');
  const numbers = analyzeLoadNumbers(input);
  const prompt = `Analyze this load for a carrier I dispatch. Comment on whether the rate per mile and all-in rate per mile look workable, deadhead impact, fuel and net, and what to negotiate. Do not quote market rates as facts — say what to check on a rate tool.
Load: ${input.origin || '?'} to ${input.destination || '?'}, ${input.equipment || 'equipment unknown'}, ${input.commodity || 'commodity unknown'}${input.weightLbs ? `, ${input.weightLbs} lbs` : ''}.
Computed values (authoritative, do not recompute):
${JSON.stringify(numbers, null, 2)}
${input.notes ? `Notes: ${input.notes}` : ''}`;
  const commentary = await runTool(req, 'Tool: Load analysis', prompt, { purpose: 'analyze_load', temperature: 0.3 });
  res.json({ numbers, commentary });
}));

// ---------------------------------------------------------------------------
// Knowledge base (RAG)
// ---------------------------------------------------------------------------
const canManageGlobal = (req) => hasPermission(req, 'admin.settings');

r.get('/knowledge', ah(async (req, res) => {
  const where = canManageGlobal(req)
    ? { OR: [{ ownerId: req.user.id }, { scope: 'global' }] }
    : { OR: [{ ownerId: req.user.id, scope: 'private' }, { scope: 'global', approved: true }] };
  const items = await prisma.aIKnowledgeDocument.findMany({ where, orderBy: { createdAt: 'desc' }, include: { owner: { select: { name: true } } } });
  res.json({
    items: items.map((d) => ({ ...d, storedName: undefined, ownerName: d.owner.name, owner: undefined, canDelete: d.ownerId === req.user.id || (d.scope === 'global' && canManageGlobal(req)) })),
    canManageGlobal: canManageGlobal(req),
  });
}));

r.post('/knowledge', knowledgeUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload (.pdf, .txt, .md or .csv)');
  verifyFileSignature(req.file);
  const b = parse(z.object({ title: optStr(200), scope: z.enum(['private', 'global']).default('private') }), req.body);
  if (b.scope === 'global' && !canManageGlobal(req)) {
    fs.rmSync(req.file.path, { force: true });
    throw forbidden('Only administrators can add documents to the shared knowledge base');
  }
  const doc = await prisma.aIKnowledgeDocument.create({
    data: {
      ownerId: req.user.id, scope: b.scope, approved: true, title: b.title || req.file.originalname.replace(/\.[^.]+$/, ''),
      originalName: req.file.originalname.slice(0, 200), storedName: req.file.filename, mimeType: req.file.mimetype, status: 'processing',
      sizeBytes: req.file.size || 0, // summed for the storage quota (lib/plans.js)
    },
  });
  const processed = await ingestDocument(doc.id);
  if (b.scope === 'global') await audit(req, 'ai.knowledge_global_added', { entityType: 'ai_document', entityId: doc.id });
  res.status(201).json({ document: { ...processed, storedName: undefined } });
}));

async function manageableDoc(req) {
  const d = await prisma.aIKnowledgeDocument.findUnique({ where: { id: String(req.params.id) } });
  if (!d) throw notFound('Document not found');
  if (d.ownerId === req.user.id) return d;
  if (d.scope === 'global' && canManageGlobal(req)) return d;
  throw notFound('Document not found');
}

r.post('/knowledge/:id/reprocess', ah(async (req, res) => {
  const d = await manageableDoc(req);
  await prisma.aIKnowledgeDocument.update({ where: { id: d.id }, data: { status: 'processing', error: null } });
  const doc = await ingestDocument(d.id);
  res.json({ document: { ...doc, storedName: undefined } });
}));

r.patch('/knowledge/:id', ah(async (req, res) => {
  const d = await manageableDoc(req);
  const b = parse(z.object({ title: z.string().trim().min(1).max(200).optional(), approved: z.boolean().optional() }), req.body);
  if (b.approved !== undefined && !(d.scope === 'global' && canManageGlobal(req))) throw forbidden('Only administrators can approve shared documents');
  const doc = await prisma.aIKnowledgeDocument.update({ where: { id: d.id }, data: { ...(b.title ? { title: b.title } : {}), ...(b.approved !== undefined ? { approved: b.approved } : {}) } });
  if (b.approved !== undefined) await audit(req, b.approved ? 'ai.knowledge_approved' : 'ai.knowledge_unapproved', { entityType: 'ai_document', entityId: d.id });
  res.json({ document: { ...doc, storedName: undefined } });
}));

r.delete('/knowledge/:id', ah(async (req, res) => {
  const d = await manageableDoc(req);
  await prisma.aIKnowledgeDocument.delete({ where: { id: d.id } });
  removeFile('knowledge', d.storedName);
  if (d.scope === 'global') await audit(req, 'ai.knowledge_global_deleted', { entityType: 'ai_document', entityId: d.id });
  res.json({ ok: true });
}));

export default r;
