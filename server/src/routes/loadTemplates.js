import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { ownerWhere } from '../lib/access.js';
import { requirePermission } from '../middleware/auth.js';
import {
  MAX_TEMPLATES, checkTemplateRefs, generateForTemplate, templateBodySchema, templateColumns, templateNames, templateView,
} from '../services/loads/templates.js';

/**
 * Load templates and recurring dedicated lanes (/api/load-templates). Templates are private to their owner: every
 * query is scoped to the signed-in user, and anyone else gets 404. Carrier and broker ids are checked with the same
 * access rules as saving a load before they are stored. See services/loads/templates.js for the schedule.
 */
const r = Router();
r.use(requirePermission('crm.use'));

async function findOwned(user, id) {
  const t = await prisma.loadTemplate.findFirst({ where: { id: String(id), ...(await ownerWhere(user, 'mine')) } });
  if (!t) throw notFound('Template not found');
  return t;
}

async function viewOne(t, user) {
  return templateView(t, { names: await templateNames([t]), ownerTz: user.timezone });
}

/** Create the loads a newly saved dedicated lane needs now; a failure here never fails the save (the job retries). */
async function generateNow(t, user) {
  try {
    return (await generateForTemplate(t, { owner: user })) || 0;
  } catch (err) {
    console.error(`[load-templates] generate ${t.id}: ${err.message}`);
    return 0;
  }
}

r.get('/', ah(async (req, res) => {
  const rows = await prisma.loadTemplate.findMany({
    where: await ownerWhere(req.user, 'mine'),
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    take: MAX_TEMPLATES,
  });
  const names = await templateNames(rows);
  const now = new Date();
  res.json({ items: rows.map((t) => templateView(t, { now, names, ownerTz: req.user.timezone })), max: MAX_TEMPLATES });
}));

r.get('/:id', ah(async (req, res) => {
  const t = await findOwned(req.user, req.params.id);
  res.json({ template: await viewOne(t, req.user) });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(templateBodySchema, req.body);
  const count = await prisma.loadTemplate.count({ where: { ownerId: req.user.id } });
  if (count >= MAX_TEMPLATES) throw badRequest(`You can keep up to ${MAX_TEMPLATES} load templates. Delete one you no longer use first.`, { code: 'TEMPLATE_LIMIT', limit: MAX_TEMPLATES });
  await checkTemplateRefs(req.user, body);
  const data = templateColumns(body, null, req.user.timezone);
  const created = await prisma.loadTemplate.create({ data: { ...data, ownerId: req.user.id } });
  const generated = await generateNow(created, req.user);
  const t = await prisma.loadTemplate.findUnique({ where: { id: created.id } });
  res.status(201).json({ template: await viewOne(t, req.user), generated });
}));

r.patch('/:id', ah(async (req, res) => {
  const existing = await findOwned(req.user, req.params.id);
  const body = parse(templateBodySchema.partial(), req.body);
  await checkTemplateRefs(req.user, body);
  const data = templateColumns(body, existing, req.user.timezone);
  const updated = await prisma.loadTemplate.update({ where: { id: existing.id }, data });
  const generated = await generateNow(updated, req.user);
  const t = await prisma.loadTemplate.findUnique({ where: { id: existing.id } });
  res.json({ template: await viewOne(t, req.user), generated });
}));

/** Delete a template. Loads it created stay (they are ordinary loads) and lose the link. */
r.delete('/:id', ah(async (req, res) => {
  const t = await findOwned(req.user, req.params.id);
  await prisma.loadTemplate.delete({ where: { id: t.id } });
  await prisma.load.updateMany({ where: { templateId: t.id, ownerId: t.ownerId }, data: { templateId: null } });
  res.json({ ok: true });
}));

export default r;
