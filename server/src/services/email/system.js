import nodemailer from 'nodemailer';
import { prisma } from '../../db.js';
import { getSettings } from '../../lib/settings.js';
import { onBroadcast } from '../../lib/broadcast.js';

/**
 * Transactional mail (verification, password reset, invitations, notifications)
 * using the platform SMTP account configured by an admin or via SMTP_* env vars, or Brevo's HTTPS API when a Brevo
 * API key is set (setting `brevo.apiKey` / env BREVO_API_KEY; then only the From address is needed).
 * Returns { sent: true, messageId } only when the SMTP server accepted the message.
 *
 * Daily budget: free SMTP plans cap the platform at a few hundred messages a day (Brevo free: 300), shared by every
 * user. The counter (SystemSetting `mail.platformBudget`, per UTC day, updated with compare-and-set so every process
 * shares it) lets non-auth mail (category 'notice' or 'digest') use only `limit - reserve` messages, so verification,
 * password-reset and invitation mail (category 'auth', the default) always has room. Auth mail is never refused by
 * the counter; the provider has the last word.
 * Limit: setting `smtp.dailyLimit`, else env PLATFORM_MAIL_DAILY_LIMIT, else 300. Reserve: PLATFORM_MAIL_AUTH_RESERVE,
 * else 30% of the limit.
 */
const BUDGET_KEY = 'mail.platformBudget';
export const SYSTEM_MAIL_CATEGORIES = ['auth', 'notice', 'digest'];

export async function systemMailConfigured() {
  const s = await getSettings(['smtp.host', 'smtp.from', 'brevo.apiKey']);
  return !!((s['smtp.host'] || s['brevo.apiKey']) && s['smtp.from']);
}

/** "Name <email>" or "email" -> { name?, email }. */
export function parseFrom(from) {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(String(from || ''));
  if (m) return { ...(m[1]?.trim() ? { name: m[1].trim() } : {}), email: m[2] };
  return { email: String(from || '').trim() };
}

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** Send one message through Brevo's transactional API (HTTPS, no SMTP key needed). Throws with Brevo's message on failure. */
export async function sendViaBrevo(apiKey, { from, to, subject, text, html }) {
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: parseFrom(from),
      to: [{ email: String(to) }],
      subject,
      ...(text ? { textContent: text } : {}),
      ...(html ? { htmlContent: html } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(`Brevo ${res.status}: ${body?.message || res.statusText || 'request failed'}`);
    err.code = body?.code || `HTTP_${res.status}`;
    throw err;
  }
  return { messageId: body?.messageId || null };
}

// One pooled transport per process, rebuilt when SMTP settings change (settings broadcast) or differ.
let cached = null; // { sig, transport }
function dropTransport() {
  if (!cached) return;
  try { cached.transport.close?.(); } catch { /* already closed */ }
  cached = null;
}
onBroadcast('settings', dropTransport);

function transportFor(s) {
  const sig = JSON.stringify([s['smtp.host'], s['smtp.port'], s['smtp.secure'], s['smtp.user'], s['smtp.pass']]);
  if (cached?.sig === sig) return cached.transport;
  dropTransport();
  const transport = nodemailer.createTransport({
    host: s['smtp.host'], port: Number(s['smtp.port'] || 587), secure: s['smtp.secure'] === 'true',
    auth: s['smtp.user'] ? { user: s['smtp.user'], pass: s['smtp.pass'] } : undefined,
    pool: true, maxConnections: 2, maxMessages: 100,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
  });
  cached = { sig, transport };
  return transport;
}

export async function platformMailLimits() {
  const s = await getSettings(['smtp.dailyLimit']);
  const limit = Math.max(1, Number(s['smtp.dailyLimit']) || Number(process.env.PLATFORM_MAIL_DAILY_LIMIT) || 300);
  const wanted = Number(process.env.PLATFORM_MAIL_AUTH_RESERVE) || Math.ceil(limit * 0.3);
  const reserve = Math.max(0, Math.min(limit - 1, wanted));
  return { limit, reserve, otherLimit: limit - reserve };
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const fresh = () => ({ day: utcDay(), sent: 0, other: 0, refused: 0, failed: 0 });

async function readBudget() {
  const row = await prisma.systemSetting.findUnique({ where: { key: BUDGET_KEY } });
  let v = null;
  try { v = row ? JSON.parse(row.value) : null; } catch { v = null; }
  if (!v || v.day !== utcDay()) v = fresh();
  return { row, v };
}

/** Apply `fn` to today's counters with compare-and-set (several processes send platform mail). Best effort. */
async function updateBudget(fn) {
  for (let i = 0; i < 6; i++) {
    const { row, v } = await readBudget();
    const value = JSON.stringify(fn({ ...v }));
    if (!row) {
      try {
        await prisma.systemSetting.create({ data: { key: BUDGET_KEY, value, secret: false } });
        return;
      } catch (err) {
        if (err.code !== 'P2002') throw err;
        continue;
      }
    }
    const res = await prisma.systemSetting.updateMany({ where: { key: BUDGET_KEY, value: row.value }, data: { value } });
    if (res.count) return;
  }
}

/** Today's platform mail use, for Admin → Setup: { limit, reserve, otherLimit, sent, other, refused, failed, lastError }. */
export async function platformMailStatus() {
  const [{ v }, limits] = await Promise.all([readBudget(), platformMailLimits()]);
  return { ...limits, ...v };
}

/**
 * sendSystemMail({ to, subject, text, html, category = 'auth' }) -> { sent, messageId?, reason?, budget? }
 * category: 'auth' (verification, reset, invitations; reserved capacity), 'notice' or 'digest' (budgeted).
 */
export async function sendSystemMail({ to, subject, text, html, category = 'auth' }) {
  const s = await getSettings(['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass', 'smtp.from', 'app.name', 'brevo.apiKey']);
  const useBrevo = !!s['brevo.apiKey'];
  if ((!s['smtp.host'] && !useBrevo) || !s['smtp.from']) {
    console.warn(`[mail] Platform email not configured — not sending "${subject}" to ${to}`);
    return { sent: false, reason: 'Platform email (SMTP or Brevo) is not configured' };
  }
  const auth = category === 'auth';
  if (!auth) {
    const [{ v }, { otherLimit }] = await Promise.all([readBudget(), platformMailLimits()]);
    if (v.sent >= otherLimit) {
      await updateBudget((b) => ({ ...b, refused: (b.refused || 0) + 1 })).catch(() => {});
      return { sent: false, budget: true, reason: 'The platform email budget for today is used up; the rest is kept for sign-in and password emails' };
    }
  }
  try {
    const info = useBrevo
      ? await sendViaBrevo(s['brevo.apiKey'], { from: s['smtp.from'], to, subject, text, html })
      : await transportFor(s).sendMail({ from: s['smtp.from'], to, subject, text, html: html || undefined });
    await updateBudget((b) => ({ ...b, sent: (b.sent || 0) + 1, other: (b.other || 0) + (auth ? 0 : 1) })).catch(() => {});
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error('[mail] send failed', err.message);
    await updateBudget((b) => ({ ...b, failed: (b.failed || 0) + 1, lastError: String(err.message).slice(0, 300), lastErrorAt: new Date().toISOString() })).catch(() => {});
    if (/ECONNECTION|ETIMEDOUT|ESOCKET|closed/i.test(`${err.code || ''} ${err.message}`)) dropTransport();
    return { sent: false, reason: err.message };
  }
}
