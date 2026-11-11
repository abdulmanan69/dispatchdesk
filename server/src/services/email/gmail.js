import { getAccessToken } from './oauth.js';
import { buildMime } from './mime.js';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
// Media upload accepts full messages up to 35 MB (the JSON `raw` form is meant for small messages).
const UPLOAD_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

/**
 * Send through the Gmail API (scope gmail.send). Resolves only on HTTP 200 (message accepted by Gmail).
 * The message carries our own Message-ID so replies can be matched to the Email row.
 */
export async function sendGmail(account, msg) {
  const token = await getAccessToken(account);
  const from = account.fromName ? `"${account.fromName.replace(/"/g, '')}" <${account.fromEmail}>` : account.fromEmail;
  const mime = buildMime({
    from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers,
    messageId: msg.messageId, attachments: msg.attachments || [],
  });
  const res = msg.attachments?.length
    ? await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'message/rfc822' },
      body: mime,
      signal: AbortSignal.timeout(60000),
    })
    : await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
      signal: AbortSignal.timeout(20000),
    });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`Gmail API error ${res.status}: ${data.error?.message || 'send failed'}`);
  return { ok: true, providerMessageId: data.id || null };
}
