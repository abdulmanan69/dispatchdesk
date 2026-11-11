import { getAccessToken } from './oauth.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
// A sendMail request must stay under 4 MB, base64 included. Larger attachments go through an upload session.
const INLINE_LIMIT = 3 * 1024 * 1024;
// Upload-session chunks must be multiples of 320 KiB.
const CHUNK = 320 * 1024 * 9;

function graph(token, method, path, body, timeoutMs = 30000) {
  return fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function graphError(res, what) {
  const data = await res.json().catch(() => ({}));
  return new Error(`Microsoft Graph error ${res.status}: ${data.error?.message || `${what} failed`}`);
}

function messageBody(msg) {
  // Graph accepts custom headers only when they start with x-.
  const headers = Object.entries(msg.headers || {})
    .filter(([k]) => k.toLowerCase().startsWith('x-'))
    .map(([name, value]) => ({ name, value: String(value) }));
  return {
    subject: msg.subject,
    body: msg.html ? { contentType: 'HTML', content: msg.html } : { contentType: 'Text', content: msg.text },
    toRecipients: [{ emailAddress: { address: msg.to } }],
    ...(headers.length ? { internetMessageHeaders: headers } : {}),
  };
}

const fileAttachment = (a) => ({
  '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType || 'application/octet-stream',
  contentBytes: Buffer.from(a.content).toString('base64'),
});

/**
 * Send through Microsoft Graph (scope Mail.Send). Graph assigns its own Message-ID:
 * - small messages use /me/sendMail (202 Accepted, no id returned);
 * - messages with more than 3 MB of attachments are created as a draft, attachments are uploaded in chunks,
 *   then the draft is sent. The draft's internetMessageId is returned for reply matching.
 */
export async function sendOutlook(account, msg) {
  const token = await getAccessToken(account);
  const atts = msg.attachments || [];
  const total = atts.reduce((n, a) => n + (a.content?.length || 0), 0);

  if (total <= INLINE_LIMIT) {
    const message = { ...messageBody(msg), ...(atts.length ? { attachments: atts.map(fileAttachment) } : {}) };
    const res = await graph(token, 'POST', '/me/sendMail', { message, saveToSentItems: true }, atts.length ? 60000 : 20000);
    if (res.status !== 202) throw await graphError(res, 'send');
    return { ok: true, providerMessageId: res.headers.get('request-id') || null };
  }

  const draftRes = await graph(token, 'POST', '/me/messages', messageBody(msg));
  if (draftRes.status !== 201) throw await graphError(draftRes, 'draft');
  const draft = await draftRes.json();
  try {
    for (const a of atts) {
      const size = a.content.length;
      if (size <= INLINE_LIMIT) {
        const r = await graph(token, 'POST', `/me/messages/${draft.id}/attachments`, fileAttachment(a), 60000);
        if (r.status !== 201) throw await graphError(r, 'attachment');
        continue;
      }
      const s = await graph(token, 'POST', `/me/messages/${draft.id}/attachments/createUploadSession`, {
        AttachmentItem: { attachmentType: 'file', name: a.filename, size, contentType: a.contentType || 'application/octet-stream' },
      });
      if (s.status !== 201) throw await graphError(s, 'upload session');
      const { uploadUrl } = await s.json();
      for (let start = 0; start < size; start += CHUNK) {
        const end = Math.min(size, start + CHUNK);
        // The upload URL is pre-authorized: it must not carry the Authorization header.
        const put = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end - 1}/${size}`, 'Content-Length': String(end - start) },
          body: a.content.subarray(start, end),
          signal: AbortSignal.timeout(60000),
        });
        if (put.status !== 200 && put.status !== 201) throw await graphError(put, 'attachment upload');
      }
    }
    const sent = await graph(token, 'POST', `/me/messages/${draft.id}/send`, undefined);
    if (sent.status !== 202) throw await graphError(sent, 'send');
  } catch (err) {
    await graph(token, 'DELETE', `/me/messages/${draft.id}`).catch(() => {}); // do not leave a half-built draft behind
    throw err;
  }
  return { ok: true, providerMessageId: draft.id || null, internetMessageId: draft.internetMessageId || null };
}
