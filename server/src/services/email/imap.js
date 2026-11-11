import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prisma } from '../../db.js';
import { decrypt } from '../../lib/crypto.js';
import { resolvePublicHost } from '../../lib/netguard.js';
import { withLock, LockBusyError } from '../../lib/locks.js';
import { imapPresetFor } from './smtp.js';
import { recordReply, recordBounce, recordGoogleVoice, contactsForAddresses } from './replies.js';

/**
 * Reply, bounce and Google Voice detection over IMAP (opt-in per mailbox, EmailAccount.imapEnabled).
 *
 * - Works for mailboxes connected with an app password (Gmail with 2-Step Verification, Yahoo, AOL, Zoho, iCloud,
 *   Hostinger, GoDaddy, Fastmail, other IMAP hosts). Mailboxes connected with Google or Microsoft sign-in only have
 *   permission to SEND mail (gmail.send / Mail.Send), which cannot open IMAP, so they are not polled.
 * - Read-only: the inbox is opened with EXAMINE, messages are read with BODY.PEEK (nothing is marked read), and
 *   nothing is ever sent back.
 * - Incremental: only UIDs above EmailAccount.imapLastUid; headers first, the body only for bounces and Google Voice.
 * - Bounded: at most N mailboxes per run, a few in parallel, a per-mailbox lock and time budget, connection timeouts,
 *   and back-off after errors.
 */
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const IMAP_LIMITS = {
  mailboxesPerRun: 80,
  concurrency: 8,
  messagesPerMailbox: 150,
  firstRunLookback: 50, // the newest messages checked the first time a mailbox is polled
  minIntervalMs: 5 * MIN, // the job runs every 3 minutes; each mailbox is checked at most this often
  activeWindowMs: 14 * DAY, // poll only mailboxes that sent mail recently (or were just enabled)
  authBackoffMs: 6 * HOUR,
  errorBackoffMs: 30 * MIN,
  runBudgetMs: 150000, // network-bound: email sending and reminders run on their own loop meanwhile
  bodyBytes: 256 * 1024,
};

const OAUTH = new Set(['gmail', 'outlook']);

/** Can this mailbox use reply detection? { supported, note } — honest about why not. */
export function imapSupport(account) {
  if (OAUTH.has(account.provider)) {
    return {
      supported: false,
      note: `${account.provider === 'gmail' ? 'Google' : 'Microsoft'} sign-in connections can only send mail. To detect replies and bounces, connect this mailbox with an app password (IMAP) instead.`,
    };
  }
  if (!account.secretEnc) return { supported: false, note: 'Reconnect the mailbox first.' };
  const preset = imapPresetFor(account.provider);
  return { supported: true, note: preset?.note || null };
}

/** Effective IMAP server settings: saved values, else the provider preset. */
export function imapSettings(account, override = {}) {
  const preset = imapPresetFor(account.provider) || {};
  return {
    host: override.host || account.imapHost || preset.host || '',
    port: Number(override.port || account.imapPort || preset.port || 993),
    secure: override.secure ?? (account.imapHost ? account.imapSecure : preset.secure ?? true),
  };
}

/**
 * `settings.address` / `settings.servername` come from assertPublicHost(): the client connects to the vetted address
 * and checks the certificate against the name. Without them it connects to `settings.host` (tests, low-level use).
 */
export function createImapClient(account, settings) {
  return new ImapFlow({
    host: settings.address || settings.host,
    ...(settings.servername ? { servername: settings.servername } : {}),
    port: settings.port,
    secure: !!settings.secure,
    auth: { user: account.smtpUser || account.fromEmail, pass: decrypt(account.secretEnc) },
    // Port 143: STARTTLS is required, so the password never crosses the wire in clear text (no silent downgrade).
    ...(settings.secure ? {} : { doSTARTTLS: true }),
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
}

/**
 * The server must be a public host: the app connects to whatever the user types, so loopback, private, link-local
 * and other reserved addresses (this server's own network) are refused, and so are names that do not resolve.
 * Returns { address, servername }: connect to that address (lib/netguard.js explains why).
 */
export async function assertPublicHost(host) {
  return resolvePublicHost(host, { label: 'IMAP server' });
}

/** Settings plus the vetted address to connect to. */
async function vetted(settings) {
  const target = await assertPublicHost(settings.host);
  return { ...settings, address: target.address, servername: target.servername };
}

const isAuthError = (err) => !!(err?.authenticationFailed || /auth|login|credential|password|invalid user/i.test(`${err?.responseText || ''} ${err?.message || ''}`));

/** Sign in and open INBOX read-only; used by "Test connection". Returns { ok, message, exists }. */
export async function testImap(account, override = {}, { clientFactory = createImapClient } = {}) {
  const settings = imapSettings(account, override);
  if (!settings.host) return { ok: false, message: 'Enter the IMAP server for this mailbox' };
  const client = clientFactory(account, await vetted(settings));
  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    return { ok: true, message: `Signed in to ${settings.host}:${settings.port}. The inbox has ${box.exists ?? 0} messages.`, exists: box.exists ?? 0, settings };
  } catch (err) {
    return { ok: false, message: `${isAuthError(err) ? 'Sign-in failed' : 'Could not connect'} (${settings.host}:${settings.port}): ${err.responseText || err.message}`, settings };
  } finally {
    await client.logout().catch(() => client.close?.());
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Parse a raw header block into lower-case name -> unfolded value (first occurrence). */
export function parseHeaders(raw) {
  const out = {};
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in out)) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

/** Message-IDs (<...>) found in a header value, normalized to lower case. */
export function messageIds(value) {
  return [...new Set((String(value || '').match(/<[^<>\s]+>/g) || []).map((x) => x.toLowerCase()))].slice(0, 30);
}

const AUTO_SUBJECT = /^(auto(matic)?[ -]?(reply|response)|out of (the )?office|ooo\b|away from (the )?office|on vacation|abwesenheit|r[eé]ponse automatique)/i;

/** Out-of-office and other automatic replies (RFC 3834 Auto-Submitted, common vendor headers, subjects). */
export function isAutoReply(headers, subject) {
  const auto = String(headers['auto-submitted'] || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['x-autoresponse']) return true;
  if (/^(auto_reply|auto-reply|bulk|junk)$/i.test(String(headers.precedence || '').trim())) return true;
  return AUTO_SUBJECT.test(String(subject || '').trim());
}

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;
const BOUNCE_SUBJECT = /(undeliverable|undelivered mail|delivery status notification|delivery (has )?failed|failure notice|returned mail|mail delivery failed|could not be delivered|delivery failure)/i;

/** Delivery status notifications (multipart/report) and classic bounce mail. */
export function looksLikeBounce({ from, subject, headers }) {
  const ct = String(headers?.['content-type'] || '').toLowerCase();
  if (ct.includes('multipart/report') && ct.includes('delivery-status')) return true;
  if (BOUNCE_FROM.test(String(from || ''))) return true;
  return BOUNCE_SUBJECT.test(String(subject || '')) && !!headers?.['x-failed-recipients'];
}

/**
 * Read a bounce: failed recipient, permanence and the original Message-ID.
 * `parts` = text of message/delivery-status parts; `text` = readable body; `headers` = outer headers.
 * Returns null for temporary (4.x.x / delayed) notices.
 */
export function parseBounce({ parts = [], text = '', headers = {}, originalHeaders = '' }) {
  // mailparser folds message/delivery-status parts into the text body, so the fields are looked up in both.
  const dsn = [...parts, String(text || '')].join('\n');
  const field = (name, src) => {
    const m = String(src).match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
    return m ? m[1].trim() : null;
  };
  const action = (field('Action', dsn) || '').toLowerCase();
  const status = field('Status', dsn);
  if (action && action !== 'failed') return null; // delayed / delivered / relayed
  if (status && /^4\./.test(status)) return null;
  const finalRcpt = field('Final-Recipient', dsn) || field('Original-Recipient', dsn);
  let recipient = finalRcpt ? finalRcpt.replace(/^rfc822;\s*/i, '').trim() : null;
  if (!recipient && headers['x-failed-recipients']) recipient = headers['x-failed-recipients'].split(',')[0].trim();
  if (!recipient) {
    const m = String(text).match(/(?:to|recipient|address)[^@\n]{0,80}?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    recipient = m ? m[1] : null;
  }
  if (!recipient) return null;
  const diagnostic = field('Diagnostic-Code', dsn);
  const original = messageIds(field('Message-ID', originalHeaders) || field('Message-Id', originalHeaders) || '')[0]
    || messageIds(String(text).match(/^Message-ID:.*$/im)?.[0] || '')[0] || null;
  return {
    recipient: recipient.replace(/[<>]/g, '').toLowerCase(),
    status: status || null,
    reason: (diagnostic ? diagnostic.replace(/^smtp;\s*/i, '') : status ? `Status ${status}` : 'Delivery failed').slice(0, 300),
    originalMessageId: original,
  };
}

const GV_FROM = /(^voice-noreply@google\.com$)|(@txt\.voice\.google\.com$)/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;

/** Google Voice notification email -> { kind: 'missed_call'|'voicemail'|'text', phone, name, text } or null. */
export function parseGoogleVoice({ from, subject, text }) {
  if (!GV_FROM.test(String(from || '').trim())) return null;
  const s = String(subject || '');
  const kind = /voicemail/i.test(s) ? 'voicemail' : /text message|new message|\bsms\b/i.test(s) || /@txt\.voice\.google\.com$/i.test(from) ? 'text' : /missed call/i.test(s) ? 'missed_call' : null;
  if (!kind) return null;
  const m = s.match(PHONE) || String(text || '').match(PHONE);
  if (!m) return null;
  const nameMatch = s.match(/from\s+([^()\d][^()]*?)(?:\s*\(|\s+at\s|$)/i);
  const body = String(text || '')
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/google voice|play message|reply to this|you received|unsubscribe|https?:\/\//i.test(l))
    .join(' ').slice(0, 500) || null;
  return { kind, phone: `${m[1]}${m[2]}${m[3]}`, name: nameMatch ? nameMatch[1].trim() : null, text: kind === 'missed_call' ? null : body };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

const HEADER_FIELDS = ['in-reply-to', 'references', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'x-autoresponse', 'precedence', 'content-type', 'x-failed-recipients'];

async function readBody(client, uid) {
  const msg = await client.fetchOne(String(uid), { source: { maxLength: IMAP_LIMITS.bodyBytes } }, { uid: true });
  if (!msg?.source) return null;
  return simpleParser(msg.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
}

/** Message-IDs a message answers (In-Reply-To, then References). */
function refsOf(msg, headers = parseHeaders(msg.headers)) {
  return [...messageIds(headers['in-reply-to'] || msg.envelope?.inReplyTo), ...messageIds(headers.references)];
}

const MAX_THREAD_REFS = 1000;
/**
 * The user's sent emails the batch's messages refer to, in one indexed query (Email.messageId): Map(messageId -> email).
 * Returns null when the batch refers to too many ids (handleMessage then looks each message up on its own).
 */
async function threadsFor(user, batch) {
  const ids = [...new Set(batch.flatMap((m) => refsOf(m)))];
  if (ids.length > MAX_THREAD_REFS) return null;
  const map = new Map();
  if (!ids.length) return map;
  for (const e of await prisma.email.findMany({ where: { userId: user.id, messageId: { in: ids } } })) map.set(e.messageId, e);
  return map;
}

/** Handle one fetched message for `account` (owner `user`). `senders` = contactsForAddresses() of the batch. */
async function handleMessage({ client, account, user, msg, stats, senders, threads = null }) {
  const env = msg.envelope || {};
  const from = (env.from?.[0]?.address || '').toLowerCase();
  if (!from || from === account.fromEmail.toLowerCase()) return null;
  const headers = parseHeaders(msg.headers);
  const subject = env.subject || '';
  const at = msg.internalDate ? new Date(msg.internalDate) : new Date();

  if (GV_FROM.test(from)) {
    const parsed = await readBody(client, msg.uid);
    const gv = parseGoogleVoice({ from, subject, text: parsed?.text || '' });
    if (gv && await recordGoogleVoice({ user, ...gv, at })) { stats.googleVoice++; return 'google_voice'; }
    return null;
  }

  if (looksLikeBounce({ from, subject, headers })) {
    const parsed = await readBody(client, msg.uid);
    if (!parsed) return null;
    const parts = [];
    let originalHeaders = '';
    for (const a of parsed.attachments || []) {
      const ct = String(a.contentType || '').toLowerCase();
      if (ct === 'message/delivery-status' || ct === 'message/global-delivery-status') parts.push(a.content.toString('utf8'));
      if (ct === 'text/rfc822-headers' || ct === 'message/rfc822') originalHeaders = a.content.toString('utf8').slice(0, 20000);
    }
    const b = parseBounce({ parts, text: parsed.text || '', headers, originalHeaders });
    if (!b) return null;
    // Anyone can mail a fake "Undelivered" notice, so a bounce counts only for a message this user really sent to
    // that address: matched by its Message-ID, or (a real DSN without one) the latest send to it in the last week.
    // A Message-ID that matches nothing never falls back to the address lookup.
    const email = b.originalMessageId
      ? await prisma.email.findFirst({ where: { userId: user.id, messageId: b.originalMessageId } })
      : parts.length
        ? await prisma.email.findFirst({ where: { userId: user.id, status: 'sent', sentAt: { gte: new Date(Date.now() - 7 * DAY) }, toEmail: b.recipient }, orderBy: { sentAt: 'desc' } })
        : null;
    if (!email || String(email.toEmail || '').toLowerCase() !== b.recipient) return null;
    await recordBounce({ user, email, recipient: b.recipient, reason: b.reason, at });
    stats.bounces++;
    return 'bounce';
  }

  const refs = refsOf(msg, headers);
  let email = null;
  if (refs.length && threads) {
    // Looked up for the whole batch at once (threadsFor): the newest of this user's emails the message refers to.
    email = refs.map((r) => threads.get(r)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  } else if (refs.length) {
    email = await prisma.email.findFirst({ where: { userId: user.id, messageId: { in: refs } }, orderBy: { createdAt: 'desc' } });
  }
  let carrier = null;
  let broker = null;
  if (!email) {
    ({ carrier = null, broker = null } = senders.get(from) || {});
    if (!carrier && !broker) return null; // not one of the user's contacts
    email = await prisma.email.findFirst({
      where: { userId: user.id, status: 'sent', sentAt: { gte: new Date(Date.now() - 30 * DAY) }, toEmail: from }, orderBy: { sentAt: 'desc' },
    });
    // Unsolicited mail from a contact (a broker's load list, a customer's paperwork) is not a reply: without a thread
    // match it counts only when the user emailed that address recently or the carrier is in a running sequence.
    if (!email) {
      const running = carrier && await prisma.sequenceEnrollment.findFirst({ where: { carrierId: carrier.id, status: { in: ['active', 'paused'] } }, select: { id: true } });
      if (!running) return null;
    }
  }
  const auto = isAutoReply(headers, subject);
  await recordReply({ user, email, carrierId: carrier?.id || email?.carrierId || null, brokerId: broker?.id || email?.brokerId || null, fromEmail: from, subject, at, auto });
  stats[auto ? 'autoReplies' : 'replies']++;
  return auto ? 'auto_reply' : 'reply';
}

/**
 * Poll one mailbox once. Returns { checked, replies, autoReplies, bounces, googleVoice, lastUid }.
 * `clientFactory` is injectable for tests.
 */
export async function pollMailbox(account, { clientFactory = createImapClient, now = new Date() } = {}) {
  const stats = { checked: 0, replies: 0, autoReplies: 0, bounces: 0, googleVoice: 0, lastUid: account.imapLastUid ?? null };
  const settings = imapSettings(account);
  if (!settings.host) throw new Error('IMAP server is not set');
  const target = await vetted(settings);
  const user = await prisma.user.findUnique({ where: { id: account.userId }, include: { teamMembership: true } });
  if (!user) return stats;
  const client = clientFactory(account, target);
  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    const top = Math.max(0, Number(box.uidNext || 1) - 1);
    let last = account.imapLastUid;
    // First run, or the server renumbered the mailbox (UIDVALIDITY change): start from the newest messages.
    if (last == null || last > top) last = Math.max(0, top - IMAP_LIMITS.firstRunLookback);
    if (top > last) {
      const end = Math.min(top, last + IMAP_LIMITS.messagesPerMailbox);
      const batch = [];
      for await (const m of client.fetch(`${last + 1}:${end}`, { uid: true, envelope: true, internalDate: true, headers: HEADER_FIELDS }, { uid: true })) {
        if (m.uid > last) batch.push(m);
      }
      batch.sort((a, b) => a.uid - b.uid);
      // Replies that answer one of the user's emails are matched by Message-ID; only the other senders need the
      // (unindexed by email) carrier and contact lookup.
      const threads = await threadsFor(user, batch);
      const unthreaded = threads ? batch.filter((m) => !refsOf(m).some((r) => threads.has(r))) : batch;
      const senders = await contactsForAddresses(user, unthreaded.map((m) => m.envelope?.from?.[0]?.address));
      for (const msg of batch) {
        try {
          await handleMessage({ client, account, user, msg, stats, senders, threads });
        } catch (err) {
          console.error(`[imap] ${account.id} uid ${msg.uid}: ${err.message}`);
        }
        stats.checked++;
        stats.lastUid = msg.uid;
      }
      stats.lastUid = Math.max(stats.lastUid ?? 0, end);
    } else {
      stats.lastUid = last;
    }
    await prisma.emailAccount.update({ where: { id: account.id }, data: { imapLastUid: stats.lastUid, imapCheckedAt: now, imapError: null } });
    return stats;
  } finally {
    await client.logout().catch(() => client.close?.());
  }
}

const AUTH_ERROR_PREFIX = 'Sign-in failed';

/**
 * Mailboxes due for a poll: enabled, connected, recently active, not checked in the last few minutes, not backing off.
 * The back-off is part of the query (not a filter after `take`), so mailboxes in back-off can never fill the batch and
 * starve healthy ones. Least recently checked first.
 */
export async function dueMailboxes(now = new Date()) {
  const ago = (ms) => new Date(now.getTime() - ms);
  return prisma.emailAccount.findMany({
    where: {
      imapEnabled: true, status: 'connected', provider: { notIn: [...OAUTH] }, secretEnc: { not: null },
      AND: [
        {
          OR: [
            { imapCheckedAt: null },
            { imapError: null, imapCheckedAt: { lt: ago(IMAP_LIMITS.minIntervalMs) } },
            { imapError: { startsWith: AUTH_ERROR_PREFIX }, imapCheckedAt: { lt: ago(IMAP_LIMITS.authBackoffMs) } },
            { imapError: { not: null }, NOT: { imapError: { startsWith: AUTH_ERROR_PREFIX } }, imapCheckedAt: { lt: ago(IMAP_LIMITS.errorBackoffMs) } },
          ],
        },
        { OR: [{ imapLastUid: null }, { lastSentAt: { gte: ago(IMAP_LIMITS.activeWindowMs) } }] },
      ],
    },
    orderBy: { imapCheckedAt: 'asc' },
    take: IMAP_LIMITS.mailboxesPerRun,
  });
}

/** One polling run over due mailboxes (the `imap-replies` job). */
export async function pollDueMailboxes(now = new Date(), { clientFactory } = {}) {
  const started = Date.now();
  const due = await dueMailboxes(now);
  const total = { mailboxes: 0, errors: 0, checked: 0, replies: 0, autoReplies: 0, bounces: 0, googleVoice: 0 };
  let i = 0;
  const worker = async () => {
    while (i < due.length && Date.now() - started < IMAP_LIMITS.runBudgetMs) {
      const account = due[i++];
      try {
        const s = await withLock(`imap.${account.id}`, 5 * MIN, () => pollMailbox(account, { clientFactory, now }));
        total.mailboxes++;
        for (const k of ['checked', 'replies', 'autoReplies', 'bounces', 'googleVoice']) total[k] += s[k];
      } catch (err) {
        if (err instanceof LockBusyError) continue;
        total.errors++;
        const msg = `${isAuthError(err) ? AUTH_ERROR_PREFIX : 'Could not check the inbox'}: ${err.responseText || err.message}`.slice(0, 500);
        await prisma.emailAccount.update({ where: { id: account.id }, data: { imapCheckedAt: now, imapError: msg } }).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAP_LIMITS.concurrency, due.length) }, worker));
  return total;
}
