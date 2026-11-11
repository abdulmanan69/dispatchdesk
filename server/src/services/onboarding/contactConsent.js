import { prisma } from '../../db.js';
import { CHANNELS, consentParts, consentText, normalizePhone, formatPhone } from '../consent/index.js';
import { dispatcherCompany } from './agreement.js';
import { asksContactConsent } from './links.js';

/**
 * Optional consent to automated calls and texts on the carrier's signing page. The link creator's team or company name is
 * the party the carrier agrees to hear from. The page shows before + "(214) 555-0188" + after; the server rebuilds the
 * same sentence for the number sent and stores it only when it matches what was shown.
 */

const who = (link) => ({ dispatcherName: link.owner?.name, dispatcherCompany: dispatcherCompany(link.owner) });

export const onboardingConsentParts = (link) => consentParts({ ...who(link), channels: CHANNELS });
export const onboardingConsentText = (link, phone) => consentText({ ...who(link), phone, channels: CHANNELS });

/** The consent given through this link, or null. */
export function linkContactConsent(link) {
  return prisma.contactConsent.findFirst({ where: { onboardingLinkId: link.id, carrierId: link.carrierId }, orderBy: { grantedAt: 'asc' } });
}

/** Number to prefill: the carrier's phone (from FMCSA or entered), else its primary contact's, else any contact's. */
export async function prefillPhone(carrierId) {
  const c = await prisma.carrier.findUnique({
    where: { id: carrierId },
    select: { phone: true, contacts: { where: { phone: { not: null } }, select: { phone: true, isPrimary: true }, orderBy: { createdAt: 'asc' }, take: 20 } },
  });
  if (!c) return '';
  const contacts = [...c.contacts.filter((x) => x.isPrimary), ...c.contacts.filter((x) => !x.isPrimary)];
  for (const p of [c.phone, ...contacts.map((x) => x.phone)]) {
    const d = normalizePhone(p);
    if (d) return d;
  }
  return '';
}

/**
 * The public page's `contactConsent` block, only on links that ask for it:
 *   before signing: { asked: true, phone: '2145550188' | '', before, after }
 *   after signing:  { asked: true, given: { phone: '(214) 555-0188', at, revoked } | null }
 */
export async function withContactConsent(view, link) {
  if (!asksContactConsent(link)) return view;
  if (link.status !== 'signed') {
    const { before, after } = onboardingConsentParts(link);
    return { ...view, contactConsent: { asked: true, phone: await prefillPhone(link.carrierId), before, after } };
  }
  const given = await linkContactConsent(link);
  return { ...view, contactConsent: { asked: true, given: given ? { phone: formatPhone(given.phone), at: given.grantedAt, revoked: !!given.revokedAt } : null } };
}
