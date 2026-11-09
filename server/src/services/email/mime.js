import crypto from 'node:crypto';

const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

/** Build a minimal RFC 822 multipart/alternative message (used by the Gmail API). */
export function buildMime({ from, to, subject, text, html, headers = {} }) {
  const boundary = `dd_${crypto.randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encHeader(subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text || '', 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  if (html) {
    lines.push(
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}
