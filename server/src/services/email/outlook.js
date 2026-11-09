import { getAccessToken } from './oauth.js';

/** Send through Microsoft Graph. Graph returns 202 Accepted on success (no message id). */
export async function sendOutlook(account, msg) {
  const token = await getAccessToken(account);
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: msg.html ? { contentType: 'HTML', content: msg.html } : { contentType: 'Text', content: msg.text },
        toRecipients: [{ emailAddress: { address: msg.to } }],
        internetMessageHeaders: Object.entries(msg.headers || {})
          .filter(([k]) => k.toLowerCase().startsWith('x-'))
          .map(([name, value]) => ({ name, value: String(value) })),
      },
      saveToSentItems: true,
    }),
  });
  if (res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Microsoft Graph error ${res.status}: ${data.error?.message || 'send failed'}`);
  }
  return { ok: true, providerMessageId: res.headers.get('request-id') || null };
}
