import nodemailer from 'nodemailer';
import { getSettings } from '../../lib/settings.js';

/**
 * Transactional mail (verification, password reset, invitations, notifications)
 * using the platform SMTP account configured by an admin or via SMTP_* env vars.
 * Returns { sent: true, messageId } only when the SMTP server accepted the message.
 */
export async function systemMailConfigured() {
  const s = await getSettings(['smtp.host', 'smtp.from']);
  return !!(s['smtp.host'] && s['smtp.from']);
}

export async function sendSystemMail({ to, subject, text, html }) {
  const s = await getSettings(['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass', 'smtp.from', 'app.name']);
  if (!s['smtp.host'] || !s['smtp.from']) {
    console.warn(`[mail] Platform SMTP not configured — not sending "${subject}" to ${to}`);
    return { sent: false, reason: 'Platform email (SMTP) is not configured' };
  }
  try {
    const transport = nodemailer.createTransport({
      host: s['smtp.host'], port: Number(s['smtp.port'] || 587), secure: s['smtp.secure'] === 'true',
      auth: s['smtp.user'] ? { user: s['smtp.user'], pass: s['smtp.pass'] } : undefined,
    });
    const info = await transport.sendMail({ from: s['smtp.from'], to, subject, text, html: html || undefined });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error('[mail] send failed', err.message);
    return { sent: false, reason: err.message };
  }
}
