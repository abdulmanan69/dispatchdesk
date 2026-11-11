import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../db.js';
import { config } from '../../config.js';

/**
 * Carrier portal links: a random token in the URL, only its SHA-256 stored on Customer.portalTokenHash (unique),
 * with an expiry. Creating a link replaces (rotates) the previous one; revoking clears it.
 */
export const PORTAL_DEFAULT_DAYS = 90;
export const PORTAL_MAX_DAYS = 365;
const DAY = 86_400_000;

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
export const portalUrl = (token) => `${String(config.appUrl || '').replace(/\/+$/, '')}/portal/${token}`;

export async function createPortalLink(customer, { days = PORTAL_DEFAULT_DAYS, now = new Date() } = {}) {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + Math.min(Math.max(1, days), PORTAL_MAX_DAYS) * DAY);
  await prisma.customer.update({ where: { id: customer.id }, data: { portalTokenHash: hashToken(token), portalExpiresAt: expiresAt } });
  return { token, url: portalUrl(token), expiresAt };
}

export async function revokePortalLink(customer) {
  await prisma.customer.update({ where: { id: customer.id }, data: { portalTokenHash: null, portalExpiresAt: null } });
}

// Tokens are base64url (createPortalLink); anything else is refused before hashing or a lookup.
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

/** Customer (with carrier and owner) for a live token, else null. Links of a suspended or deleted account stop working. */
export async function customerForToken(token, now = new Date()) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const customer = await prisma.customer.findUnique({
    where: { portalTokenHash: hashToken(token) },
    include: {
      carrier: { select: { id: true, companyName: true, mcNumber: true, dotNumber: true } },
      owner: { select: { id: true, name: true, email: true, phone: true, timezone: true, status: true, teamMembership: { select: { team: { select: { name: true } } } } } },
    },
  });
  if (!customer || !customer.portalExpiresAt || customer.portalExpiresAt <= now || customer.status === 'churned') return null;
  if (customer.owner?.status !== 'active') return null;
  return customer;
}

export const portalStatus = (customer, now = new Date()) => ({
  active: !!(customer.portalTokenHash && customer.portalExpiresAt && customer.portalExpiresAt > now),
  expiresAt: customer.portalTokenHash ? customer.portalExpiresAt : null,
});
