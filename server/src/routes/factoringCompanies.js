import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, forbidden, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr, optEmail, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { canReadOwner, canWriteOwner, loadCarrier, loadOwned, readableOwnerIds } from '../lib/access.js';
import { audit } from '../lib/audit.js';

/**
 * Factoring companies: who buys a carrier's invoices. Kept per owner and shared by that owner's carriers (Customer
 * .factoringCompanyId). Same access rules as brokers: read your own and, with team rights, the team's; write your own,
 * or a teammate's as a team owner or manager.
 *   GET    /           list ({ customerId } lists the companies a customer can use: its owner's), with carrierCount
 *   POST   /           create ({ ownerId } to add one for a teammate's carriers, with write access to their data)
 *   PATCH  /:id        edit
 *   DELETE /:id        delete (carriers that used it keep working; their link is cleared by the foreign key)
 */
const r = Router();
r.use(requirePermission('crm.use'));

const MAX_LIST = 500;
const website = z.preprocess(
  (v) => (v === '' || v === null ? null : typeof v === 'string' ? v.trim() : v),
  z.string().max(300).url('Enter a full web address, e.g. https://example.com')
    .refine((s) => /^https?:\/\//i.test(s), 'Use a web address that starts with http:// or https://').nullable().optional(),
);
const fields = {
  name: reqStr(120),
  submitEmail: optEmail,
  remitTo: optStr(500),
  phone: optStr(40),
  website,
  notes: optStr(2000),
};

const select = {
  id: true, ownerId: true, name: true, submitEmail: true, remitTo: true, phone: true, website: true, notes: true, createdAt: true, updatedAt: true,
  owner: { select: { id: true, name: true } },
  _count: { select: { customers: true } },
};
const view = ({ _count, ...c }) => ({ ...c, carrierCount: _count?.customers ?? 0 });

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({ customerId: z.string().max(40).optional(), scope: z.enum(['mine', 'team']).default('team') }), req.query);
  let where;
  if (q.customerId) {
    // The companies a customer can be linked to are its owner's; anyone who may open the customer may pick from them.
    const customer = await prisma.customer.findUnique({ where: { id: q.customerId }, select: { carrierId: true, ownerId: true } });
    if (!customer) throw notFound('Customer not found');
    await loadCarrier(req.user, customer.carrierId);
    where = { ownerId: customer.ownerId };
  } else {
    const ids = await readableOwnerIds(req.user, q.scope);
    where = ids.length === 1 ? { ownerId: ids[0] } : { ownerId: { in: ids } };
  }
  const rows = await prisma.factoringCompany.findMany({ where, orderBy: [{ name: 'asc' }, { createdAt: 'asc' }], take: MAX_LIST, select });
  res.json({ items: rows.map(view) });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(z.object({ ...fields, ownerId: z.string().max(40).optional() }), req.body);
  const { ownerId: wanted, ...data } = body;
  const ownerId = wanted || req.user.id;
  if (ownerId !== req.user.id) {
    // Another owner's list: hidden (404) without read access, read-only (403) without write access.
    if (!(await canReadOwner(req.user, ownerId))) throw notFound();
    if (!(await canWriteOwner(req.user, ownerId))) throw forbidden('Read-only access');
  }
  const company = await prisma.factoringCompany.create({ data: { ...clean(data), ownerId }, select });
  res.status(201).json({ company: view(company) });
}));

r.patch('/:id', ah(async (req, res) => {
  const company = await loadOwned('factoringCompany', req.user, req.params.id, { write: true });
  const body = parse(z.object(fields).partial(), req.body);
  const updated = await prisma.factoringCompany.update({ where: { id: company.id }, data: clean(body), select });
  res.json({ company: view(updated) });
}));

r.delete('/:id', ah(async (req, res) => {
  const company = await loadOwned('factoringCompany', req.user, req.params.id, { write: true, include: { _count: { select: { customers: true } } } });
  await prisma.factoringCompany.delete({ where: { id: company.id } });
  await audit(req, 'factoring_company.deleted', { entityType: 'factoring_company', entityId: company.id, details: { name: company.name, carriers: company._count.customers } });
  res.json({ ok: true, carriersCleared: company._count.customers });
}));

export default r;
