import nodemailer from 'nodemailer';
import { decrypt } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { resolvePublicHost } from '../../lib/netguard.js';

/**
 * SMTP mailbox providers with known server settings. `key` is stored as EmailAccount.provider.
 * Most consumer providers require an app password (2-step verification on) instead of the normal password.
 * `imap` is the matching incoming server, used only when the user turns on reply and bounce detection.
 */
export const SMTP_PROVIDERS = [
  { key: 'gmail_smtp', name: 'Gmail (app password)', host: 'smtp.gmail.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Turn on 2-Step Verification for the Google account.', 'Create an app password for "Mail".', 'Paste the 16-character app password below.'],
    helpUrl: 'https://support.google.com/accounts/answer/185833',
    imap: { host: 'imap.gmail.com', port: 993, secure: true } },
  { key: 'outlook_smtp', name: 'Outlook / Microsoft 365 (SMTP)', host: 'smtp.office365.com', port: 587, secure: false, dailyLimit: 100, password: 'Password or app password',
    steps: ['Microsoft 365: your admin must allow "Authenticated SMTP" for the mailbox.', 'If 2-step verification is on, create an app password.', 'Use your full email address as the username.'],
    helpUrl: 'https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission',
    imap: { host: 'outlook.office365.com', port: 993, secure: true, note: 'Microsoft has turned off password sign-in for IMAP on most Microsoft 365 and Outlook.com mailboxes. Reply detection works only if your mailbox still allows it.' } },
  { key: 'yahoo', name: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Open Yahoo Account security.', 'Generate an app password.', 'Paste it below.'],
    helpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true } },
  { key: 'aol', name: 'AOL Mail', host: 'smtp.aol.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Open AOL Account security.', 'Generate an app password.', 'Paste it below.'],
    helpUrl: 'https://help.aol.com/articles/Create-and-manage-app-password',
    imap: { host: 'imap.aol.com', port: 993, secure: true } },
  { key: 'zoho', name: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true, dailyLimit: 100, password: 'Password or app password',
    steps: ['Paid organisation accounts use smtppro.zoho.com; change the host if so.', 'With two-factor login on, create an application-specific password.'],
    helpUrl: 'https://www.zoho.com/mail/help/zoho-smtp.html',
    imap: { host: 'imap.zoho.com', port: 993, secure: true, note: 'Paid organisation accounts use imappro.zoho.com. IMAP access must be turned on in Zoho Mail settings.' } },
  { key: 'icloud', name: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, secure: false, dailyLimit: 100, password: 'App-specific password',
    steps: ['Sign in at account.apple.com.', 'Create an app-specific password.', 'Use your full iCloud address as the username.'],
    helpUrl: 'https://support.apple.com/en-us/102654',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true } },
  { key: 'hostinger', name: 'Hostinger email', host: 'smtp.hostinger.com', port: 465, secure: true, dailyLimit: 50, password: 'Mailbox password',
    steps: ['Use the mailbox password set in hPanel → Emails.'],
    helpUrl: 'https://support.hostinger.com/en/articles/4305847-set-up-hostinger-email-on-your-applications-and-devices',
    imap: { host: 'imap.hostinger.com', port: 993, secure: true } },
  { key: 'godaddy', name: 'GoDaddy Workspace email', host: 'smtpout.secureserver.net', port: 465, secure: true, dailyLimit: 50, password: 'Mailbox password',
    steps: ['Workspace email uses smtpout.secureserver.net.', 'GoDaddy Microsoft 365 mailboxes use the Microsoft option instead.'],
    helpUrl: 'https://www.godaddy.com/help/server-and-port-settings-for-workspace-email-6949',
    imap: { host: 'imap.secureserver.net', port: 993, secure: true } },
  { key: 'fastmail', name: 'Fastmail', host: 'smtp.fastmail.com', port: 465, secure: true, dailyLimit: 100, password: 'App password',
    steps: ['Settings → Privacy & Security → App passwords.', 'Create one with SMTP access.'],
    helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true, note: 'The app password needs IMAP access as well as SMTP.' } },
  { key: 'smtp', name: 'Other SMTP server', host: '', port: 587, secure: false, dailyLimit: 50, password: 'Password',
    steps: ['Ask your email host for the SMTP server, port and security type.'], helpUrl: null,
    imap: { host: '', port: 993, secure: true } },
];

export const SMTP_PROVIDER_KEYS = SMTP_PROVIDERS.map((p) => p.key);

/** Back-compat map of key → { host, port, secure }. */
export const SMTP_PRESETS = Object.fromEntries(SMTP_PROVIDERS.filter((p) => p.host).map((p) => [p.key, { host: p.host, port: p.port, secure: p.secure }]));

/** Incoming (IMAP) server preset for a provider key, or the generic one. */
export const imapPresetFor = (key) => (SMTP_PROVIDERS.find((p) => p.key === key) || SMTP_PROVIDERS.find((p) => p.key === 'smtp')).imap;

/** Ports a mail client submits on. Anything else is refused, so the app cannot be used to probe other services. */
export const SMTP_PORTS = [25, 465, 587, 2525];

/**
 * Nodemailer transport with short timeouts. `pool: true` keeps one connection open for several messages
 * (the scheduler sends a mailbox's batch over one connection and closes it at the end of the tick).
 * Low level: `host` is used as given. Everything that connects to a user's server goes through connectSmtpTransport.
 */
export function createSmtpTransport({ host, servername = null, port, secure, user, pass, pool = false }) {
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: !!secure,
    // Connecting to a vetted IP: the certificate is still checked against the server name.
    ...(servername ? { servername, tls: { servername } } : {}),
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    ...(pool ? { pool: true, maxConnections: 1, maxMessages: 100 } : {}),
  });
}

/**
 * Transport to a user's SMTP server: the port must be a mail submission port and the name must resolve to public
 * addresses only (lib/netguard.js). The connection goes to the address that was checked, so DNS cannot answer a
 * different (private) address for the connection.
 */
export async function connectSmtpTransport({ host, port, secure, user, pass, pool = false }) {
  if (!SMTP_PORTS.includes(Number(port))) throw badRequest(`SMTP uses port ${SMTP_PORTS.join(', ')}`);
  const target = await resolvePublicHost(host, { label: 'SMTP server' });
  return createSmtpTransport({ host: target.address, servername: target.servername, port, secure, user, pass, pool });
}

/** A pooled transport for one mailbox, reused for every message it sends in one scheduler tick. Close it after. */
export function openSmtpTransport(account) {
  return connectSmtpTransport({
    host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure, user: account.smtpUser, pass: decrypt(account.secretEnc), pool: true,
  });
}

/** Verify credentials against the SMTP server. Throws; use smtpErrorMessage() for text safe to show the user. */
export async function verifySmtp(cfg) {
  const t = await connectSmtpTransport(cfg);
  try {
    await t.verify();
  } finally {
    t.close?.();
  }
}

const CONNECTION_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EPROTOCOL', 'ETLS', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EGREETING']);

/**
 * User-facing text for an SMTP failure. Our own checks (400s) keep their message; sign-in failures and connection
 * failures get fixed text, so a server's greeting banner or "connection refused" vs "timed out" (which would let the
 * form be used to scan ports) never reaches the user. Errors after the server accepted the connection (a rejected
 * recipient, a message too large) keep the server's text.
 */
export function smtpErrorMessage(err) {
  if (err?.status === 400) return err.message;
  if (err?.code === 'EAUTH' || err?.responseCode === 535 || err?.responseCode === 534) {
    return 'Sign-in failed. Check the username and password (most providers need an app password).';
  }
  const responded = err?.responseCode && err?.command && err.command !== 'CONN';
  if (!responded && (CONNECTION_CODES.has(err?.code) || err?.command === 'CONN' || err?.syscall || /greeting|connect|timed? ?out|socket|tls|ssl|certificate/i.test(err?.message || ''))) {
    return 'Could not connect to the SMTP server. Check the server name, port and security setting.';
  }
  return String(err?.message || 'Sending failed').slice(0, 300);
}

/**
 * Send one message. msg: { to, subject, text, html, headers, messageId?, attachments?: [{ filename, content, contentType }] }.
 * Resolves only after the server accepted at least one recipient.
 */
export async function sendSmtp(account, msg, { transport } = {}) {
  const own = !transport;
  const t = transport || await connectSmtpTransport({
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
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
    });
    // nodemailer resolves only after the server accepted the message; reject if no recipient was accepted.
    if (Array.isArray(info.accepted) && info.accepted.length === 0) {
      throw new Error(`SMTP server rejected recipient(s): ${(info.rejected || []).join(', ')}`);
    }
    return { ok: true, providerMessageId: info.messageId || msg.messageId || null };
  } finally {
    if (own) t.close?.();
  }
}
