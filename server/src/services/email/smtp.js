import nodemailer from 'nodemailer';
import { decrypt } from '../../lib/crypto.js';

/** Known provider presets. Users can override host/port/secure for generic SMTP. */
/**
 * SMTP mailbox providers with known server settings. `key` is stored as EmailAccount.provider.
 * Most consumer providers require an app password (2-step verification on) instead of the normal password.
 */
export const SMTP_PROVIDERS = [
  { key: 'gmail_smtp', name: 'Gmail (app password)', host: 'smtp.gmail.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Turn on 2-Step Verification for the Google account.', 'Create an app password for "Mail".', 'Paste the 16-character app password below.'],
    helpUrl: 'https://support.google.com/accounts/answer/185833' },
  { key: 'outlook_smtp', name: 'Outlook / Microsoft 365 (SMTP)', host: 'smtp.office365.com', port: 587, secure: false, dailyLimit: 100, password: 'Password or app password',
    steps: ['Microsoft 365: your admin must allow "Authenticated SMTP" for the mailbox.', 'If 2-step verification is on, create an app password.', 'Use your full email address as the username.'],
    helpUrl: 'https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission' },
  { key: 'yahoo', name: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Open Yahoo Account security.', 'Generate an app password.', 'Paste it below.'],
    helpUrl: 'https://help.yahoo.com/kb/SLN15241.html' },
  { key: 'aol', name: 'AOL Mail', host: 'smtp.aol.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Open AOL Account security.', 'Generate an app password.', 'Paste it below.'],
    helpUrl: 'https://help.aol.com/articles/Create-and-manage-app-password' },
  { key: 'zoho', name: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true, dailyLimit: 100, password: 'Password or app password',
    steps: ['Paid organisation accounts use smtppro.zoho.com; change the host if so.', 'With two-factor login on, create an application-specific password.'],
    helpUrl: 'https://www.zoho.com/mail/help/zoho-smtp.html' },
  { key: 'icloud', name: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, secure: false, dailyLimit: 100, password: 'App-specific password',
    steps: ['Sign in at account.apple.com.', 'Create an app-specific password.', 'Use your full iCloud address as the username.'],
    helpUrl: 'https://support.apple.com/en-us/102654' },
  { key: 'hostinger', name: 'Hostinger email', host: 'smtp.hostinger.com', port: 465, secure: true, dailyLimit: 50, password: 'Mailbox password',
    steps: ['Use the mailbox password set in hPanel → Emails.'],
    helpUrl: 'https://support.hostinger.com/en/articles/4305847-set-up-hostinger-email-on-your-applications-and-devices' },
  { key: 'godaddy', name: 'GoDaddy Workspace email', host: 'smtpout.secureserver.net', port: 465, secure: true, dailyLimit: 50, password: 'Mailbox password',
    steps: ['Workspace email uses smtpout.secureserver.net.', 'GoDaddy Microsoft 365 mailboxes use the Microsoft option instead.'],
    helpUrl: 'https://www.godaddy.com/help/server-and-port-settings-for-workspace-email-6949' },
  { key: 'fastmail', name: 'Fastmail', host: 'smtp.fastmail.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Settings → Privacy & Security → App passwords.', 'Create one with SMTP access.'],
    helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854' },
  { key: 'smtp', name: 'Other SMTP server', host: '', port: 587, secure: false, dailyLimit: 50, password: 'Password',
    steps: ['Ask your email host for the SMTP server, port and security type.'], helpUrl: null },
];

export const SMTP_PROVIDER_KEYS = SMTP_PROVIDERS.map((p) => p.key);

/** Back-compat map of key → { host, port, secure }. */
export const SMTP_PRESETS = Object.fromEntries(SMTP_PROVIDERS.filter((p) => p.host).map((p) => [p.key, { host: p.host, port: p.port, secure: p.secure }]));

export function createSmtpTransport({ host, port, secure, user, pass }) {
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: !!secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

/** Verify credentials against the SMTP server (throws with the server's message on failure). */
export async function verifySmtp(cfg) {
  const t = createSmtpTransport(cfg);
  try {
    await t.verify();
  } finally {
    t.close?.();
  }
}

export async function sendSmtp(account, msg) {
  const t = createSmtpTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    user: account.smtpUser,
    pass: decrypt(account.secretEnc),
  });
  try {
    const info = await t.sendMail({
      from: account.fromName ? `"${account.fromName.replace(/"/g, '')}" <${account.fromEmail}>` : account.fromEmail,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
    });
    // nodemailer resolves only after the server accepted the message; reject if no recipient was accepted.
    if (Array.isArray(info.accepted) && info.accepted.length === 0) {
      throw new Error(`SMTP server rejected recipient(s): ${(info.rejected || []).join(', ')}`);
    }
    return { ok: true, providerMessageId: info.messageId || null };
  } finally {
    t.close?.();
  }
}
