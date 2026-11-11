import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, notFound, HttpError } from '../lib/errors.js';
import { parse, z, optStr, optNum, optEmail } from '../lib/validate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { loadCarrier } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { requirePermission, refuseApiToken } from '../middleware/auth.js';
import { queueUserEmail } from '../services/email/compose.js';
import { pickAccount } from '../services/email/index.js';
import {
  DEFAULT_AGREEMENT, DEFAULT_AGREEMENT_TITLE, MERGE_FIELDS, MAX_TEMPLATE_CHARS, MAX_TITLE_CHARS,
  unknownFields, usesField, mergeValues, renderAgreement, normalizeText, agreementHash, dispatcherCompany, percentText,
} from '../services/onboarding/agreement.js';
import {
  DOC_KINDS, DOC_KIND_LABEL, DOC_KIND_PHRASE, LINK_DEFAULT_DAYS, LINK_MAX_DAYS, MAX_PENDING_PER_CARRIER,
  linkDocuments, linkListView, linkDetailView, storedPrefix, encodeRequested,
} from '../services/onboarding/links.js';
import { recordHtml } from '../services/onboarding/record.js';
import { linkContactConsent } from '../services/onboarding/contactConsent.js';

/**
 * Dispatcher side of carrier onboarding links: create (agreement + requested documents), list, view with audit trail,
 * revoke, and the printable signed record. Access follows the carrier: whoever may read the carrier may see its links;
 * creating and revoking need write access. Anyone else gets 404.
 */
const r = Router();
r.use(requirePermission('crm.use'));

const DAY = 86_400_000;
const ownerSelect = { select: { id: true, name: true } };

/** The link plus the carrier access check (404 when the caller cannot see the carrier). */
async function loadLink(user, id, { write = false } = {}) {
  const link = await prisma.onboardingLink.findUnique({ where: { id: String(id) }, include: { owner: ownerSelect } });
  if (!link) throw notFound('Onboarding link not found');
  try {
    const carrier = await loadCarrier(user, link.carrierId, { write });
    return { link, carrier };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw notFound('Onboarding link not found');
    throw err;
  }
}

/** The dispatcher's saved template (or the built-in one) for the editor. */
r.get('/template', ah(async (req, res) => {
  const saved = (await prisma.user.findUnique({ where: { id: req.user.id }, select: { agreementTemplate: true } }))?.agreementTemplate;
  res.json({
    title: DEFAULT_AGREEMENT_TITLE,
    body: saved || DEFAULT_AGREEMENT,
    isDefault: !saved,
    defaultBody: DEFAULT_AGREEMENT,
    fields: MERGE_FIELDS,
    docs: DOC_KINDS.map((kind) => ({ kind, label: DOC_KIND_LABEL[kind] })),
    days: { default: LINK_DEFAULT_DAYS, max: LINK_MAX_DAYS },
  });
}));

const createSchema = z.object({
  carrierId: z.string().trim().min(1).max(40),
  agreementTitle: optStr(MAX_TITLE_CHARS),
  agreementBody: z.string().max(MAX_TEMPLATE_CHARS, `The agreement can be at most ${MAX_TEMPLATE_CHARS.toLocaleString('en-US')} characters`).optional().nullable(),
  feePercent: optNum(0, 100),
  requestedDocs: z.array(z.enum(DOC_KINDS)).max(DOC_KINDS.length).default([]),
  // Optional consent to automated calls and texts on the signing page. The dispatcher's form sends true by default;
  // omitted (older clients) means not asked.
  askContactConsent: z.boolean().default(false),
  days: z.coerce.number().int().min(1).max(LINK_MAX_DAYS).default(LINK_DEFAULT_DAYS),
  sendEmail: z.boolean().default(false),
  toEmail: optEmail,
}).strict();

r.post('/', ah(async (req, res) => {
  refuseApiToken(req, 'create onboarding links');
  const body = parse(createSchema, req.body);
  const carrier = await loadCarrier(req.user, body.carrierId, { write: true, include: { contacts: { select: { email: true, isPrimary: true } } } });
  const now = new Date();
  const pending = await prisma.onboardingLink.count({ where: { carrierId: carrier.id, status: 'pending', expiresAt: { gt: now } } });
  if (pending >= MAX_PENDING_PER_CARRIER) throw badRequest(`This carrier already has ${MAX_PENDING_PER_CARRIER} open onboarding links. Turn one off first.`);

  const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { agreementTemplate: true } });
  const saved = me?.agreementTemplate || null;
  const template = normalizeText(body.agreementBody ?? '') || saved || DEFAULT_AGREEMENT;
  if (template.length < 50) throw badRequest('The agreement text is too short');
  const unknown = unknownFields(template);
  if (unknown.length) throw badRequest(`Unknown merge field ${unknown.map((f) => `{{${f}}}`).join(', ')}. Use ${MERGE_FIELDS.map((f) => `{{${f.key}}}`).join(', ')}.`);

  // Fee: as entered, else the open deal's or the customer's fee.
  let feePercent = body.feePercent ?? null;
  if (feePercent == null) {
    const [opp, cust] = await Promise.all([
      prisma.opportunity.findUnique({ where: { carrierId: carrier.id }, select: { dispatchFeePercent: true } }),
      prisma.customer.findUnique({ where: { carrierId: carrier.id }, select: { dispatchFeePercent: true } }),
    ]);
    feePercent = opp?.dispatchFeePercent ?? cust?.dispatchFeePercent ?? null;
  }
  if (feePercent == null && usesField(template, 'fee_percent')) throw badRequest('Enter the dispatch fee (%) for the agreement');

  const agreementBody = normalizeText(renderAgreement(template, mergeValues({ user: req.user, carrier, feePercent, now })));
  const agreementTitle = body.agreementTitle || DEFAULT_AGREEMENT_TITLE;
  const requestedDocs = [...new Set(body.requestedDocs)];
  const token = randomToken(32);
  const link = await prisma.onboardingLink.create({
    data: {
      ownerId: req.user.id, carrierId: carrier.id, tokenHash: sha256(token), status: 'pending',
      agreementTitle, agreementBody, agreementHash: agreementHash(agreementBody), feePercent,
      requestedDocs: encodeRequested(requestedDocs, body.askContactConsent),
      expiresAt: new Date(now.getTime() + body.days * DAY),
    },
    include: { owner: ownerSelect },
  });
  // The editor's text becomes the dispatcher's template for the next link.
  if (template !== (saved || DEFAULT_AGREEMENT)) {
    await prisma.user.update({ where: { id: req.user.id }, data: { agreementTemplate: template } });
  }
  await logActivity(req.user, { type: 'onboarding', carrierId: carrier.id, summary: `Dispatch agreement link created for ${carrier.companyName}${feePercent != null ? ` at ${percentText(feePercent)}%` : ''}` });

  const url = `${config.appUrl}/onboard/${token}`;
  const company = dispatcherCompany(req.user);
  const docsText = requestedDocs.length ? ` and upload your ${listText(requestedDocs.map((k) => DOC_KIND_PHRASE[k]))}` : '';
  const text = `${company}: please review and sign our dispatch agreement${docsText} here: ${url}`;
  const subject = `Dispatch agreement for ${carrier.companyName}`;
  const toEmail = body.toEmail || carrier.email || carrier.contacts?.find((c) => c.isPrimary && c.email)?.email || carrier.contacts?.find((c) => c.email)?.email || null;
  const message = { text, subject, sms: `sms:?&body=${encodeURIComponent(text)}`, toEmail };

  let email = null;
  if (body.sendEmail) email = await sendLinkEmail(req.user, { carrier, toEmail, subject, url, requestedDocs, expiresAt: link.expiresAt, company });

  res.status(201).json({ link: url, onboardingLink: linkListView(link, [], now), message, email });
}));

const listText = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Email the link from the dispatcher's own mailbox. The link already exists, so a failure here is reported in the
 * response (the dispatcher can still copy or text the link) instead of failing the request.
 */
async function sendLinkEmail(user, { carrier, toEmail, subject, url, requestedDocs, expiresAt, company }) {
  if (!toEmail) return { outcome: 'skipped', message: 'No email address on file for this carrier. Copy or text the link instead.' };
  if (!(await pickAccount(user.id))) return { outcome: 'no_mailbox', message: 'Connect a mailbox to email links. Copy or text the link instead.' };
  const until = new Intl.DateTimeFormat('en-US', { timeZone: user.timezone || 'America/Chicago', month: 'long', day: 'numeric' }).format(expiresAt);
  const body = [
    'Hello,',
    '',
    `Here is the dispatch agreement for ${carrier.companyName}. You can read it and sign it on your phone or computer:`,
    '',
    url,
    '',
    ...(requestedDocs.length ? ['On the same page you can upload:', ...requestedDocs.map((k) => `- ${DOC_KIND_LABEL[k]}`), ''] : []),
    `The link works until ${until}. Reply to this email if you have any questions.`,
    '',
    user.name,
    company && company !== user.name ? company : null,
  ].filter((l) => l !== null).join('\n');
  try {
    const r2 = await queueUserEmail({ user, toEmail, subject, body, carrierId: carrier.id });
    return { outcome: r2.outcome, message: r2.message, emailId: r2.email?.id };
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[onboarding] link email failed', err?.message);
    return { outcome: 'failed', message: err instanceof HttpError ? err.message : 'The email could not be sent. Copy or text the link instead.' };
  }
}

r.get('/', ah(async (req, res) => {
  const { carrierId } = parse(z.object({ carrierId: z.string().trim().min(1).max(40) }), req.query);
  const carrier = await loadCarrier(req.user, carrierId);
  const links = await prisma.onboardingLink.findMany({ where: { carrierId: carrier.id }, orderBy: { createdAt: 'desc' }, take: 50, include: { owner: ownerSelect } });
  const docs = links.length ? await prisma.document.findMany({
    where: { carrierId: carrier.id, source: 'onboarding', storedName: { startsWith: 'onb-' } }, select: { storedName: true }, take: 1000,
  }) : [];
  const now = new Date();
  res.json({ items: links.map((l) => linkListView(l, docs.filter((d) => d.storedName.startsWith(storedPrefix(l.id))), now)) });
}));

r.get('/:id', ah(async (req, res) => {
  const { link } = await loadLink(req.user, req.params.id);
  const docs = await linkDocuments(link);
  res.json({ item: linkDetailView(link, docs) });
}));

r.post('/:id/revoke', ah(async (req, res) => {
  const { link, carrier } = await loadLink(req.user, req.params.id, { write: true });
  if (link.status === 'signed') throw badRequest('This agreement is already signed, so its link cannot be turned off.');
  let updated = link;
  if (link.status !== 'revoked') {
    const { count } = await prisma.onboardingLink.updateMany({ where: { id: link.id, status: 'pending' }, data: { status: 'revoked', revokedAt: new Date() } });
    updated = await prisma.onboardingLink.findUnique({ where: { id: link.id }, include: { owner: ownerSelect } });
    if (!count && updated.status === 'signed') throw badRequest('This agreement was signed just now, so its link cannot be turned off.');
    if (count) await logActivity(req.user, { type: 'onboarding', carrierId: carrier.id, summary: `Dispatch agreement link for ${carrier.companyName} turned off` });
  }
  res.json({ item: linkListView(updated, await linkDocuments(updated, { storedName: true })) });
}));

/** Printable record of the agreement and its signature (open in a new tab and print or save as PDF). */
r.get('/:id/record', ah(async (req, res) => {
  const { link, carrier } = await loadLink(req.user, req.params.id);
  const [documents, contactConsent] = await Promise.all([linkDocuments(link), linkContactConsent(link)]);
  const html = recordHtml({ link, carrier, documents, contactConsent, tz: req.user.timezone || 'UTC' });
  const slug = carrier.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'carrier';
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `inline; filename="dispatch-agreement-${slug}.html"`,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(html);
}));

export default r;
