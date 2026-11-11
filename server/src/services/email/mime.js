import crypto from 'node:crypto';

const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const b64Lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
// Header values never carry line breaks (header injection).
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ');

/** A globally unique Message-ID on the sender's domain, e.g. <dd.lx2k3.9f1c...@mydispatch.com>. */
export function newMessageId(fromEmail) {
  const domain = String(fromEmail || '').split('@')[1]?.toLowerCase().replace(/[^a-z0-9.-]/g, '') || 'dispatchdesk.local';
  return `<dd.${Date.now().toString(36)}.${crypto.randomBytes(9).toString('hex')}@${domain}>`;
}

/** Content-Type name and Content-Disposition filename parameters (RFC 2231 for non-ASCII names). */
function fileParams(filename) {
  const clean = String(filename || 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'attachment';
  if (/^[\x20-\x7e]*$/.test(clean)) return { type: `name="${clean}"`, disposition: `attachment; filename="${clean}"` };
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { type: `name="${ascii}"`, disposition: `attachment; filename="${ascii}"; filename*=UTF-8''${star}` };
}

/**
 * Build an RFC 5322 message (used by the Gmail API).
 * Without attachments: multipart/alternative (text + optional HTML).
 * With attachments [{ filename, content: Buffer, contentType }]: multipart/mixed wrapping the alternative part.
 */
export function buildMime({ from, to, subject, text, html, headers = {}, messageId, attachments = [], date = new Date() }) {
  const alt = `dd_${crypto.randomBytes(12).toString('hex')}`;
  const head = [
    `From: ${oneLine(from)}`,
    `To: ${oneLine(to)}`,
    `Subject: ${encHeader(oneLine(subject))}`,
    `Date: ${date.toUTCString()}`,
    ...(messageId ? [`Message-ID: ${oneLine(messageId)}`] : []),
    'MIME-Version: 1.0',
    ...Object.entries(headers).map(([k, v]) => `${oneLine(k).replace(/[^A-Za-z0-9-]/g, '')}: ${oneLine(v)}`),
  ];
  const altBody = [
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(Buffer.from(text || '', 'utf8')),
    ...(html ? [`--${alt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64Lines(Buffer.from(html, 'utf8'))] : []),
    `--${alt}--`,
  ];
  if (!attachments?.length) return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...altBody, ''].join('\r\n');

  const mixed = `dm_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [...head, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...altBody];
  for (const a of attachments) {
    const p = fileParams(a.filename);
    lines.push(
      `--${mixed}`,
      `Content-Type: ${oneLine(a.contentType || 'application/octet-stream')}; ${p.type}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${p.disposition}`,
      '',
      b64Lines(Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || '')),
    );
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}
