import { getAccessToken } from './oauth.js';
import { buildMime } from './mime.js';

/** Send through the Gmail API. Resolves only on HTTP 200 (message accepted by Gmail). */
export async function sendGmail(account, msg) {
  const token = await getAccessToken(account);
  const from = account.fromName ? `"${account.fromName.replace(/"/g, '')}" <${account.fromEmail}>` : account.fromEmail;
  const raw = Buffer.from(buildMime({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers })).toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`Gmail API error ${res.status}: ${data.error?.message || 'send failed'}`);
  return { ok: true, providerMessageId: data.id || null };
}
