import { decodeSignature, signatureSvg } from './signature.js';
import { agreementHash } from './agreement.js';
import { DOC_KIND_LABEL, kindOfStored, auditTrail, linkStatus } from './links.js';

/**
 * Printable record of an onboarding link: the exact agreement text, the signer, the signature, times (UTC and the
 * viewer's zone), IP address, browser, consent time, document hash and the documents uploaded. Every value is escaped;
 * the drawn signature is rebuilt from validated path data. Served with a CSP that allows no scripts.
 */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inZone(d, tz) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(d));
  } catch {
    return new Date(d).toUTCString();
  }
}
const utc = (d) => (d ? `${new Date(d).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '');
const both = (d, tz) => (d ? `${utc(d)}<br><span class="muted">${esc(inZone(d, tz))}</span>` : '<span class="muted">Not yet</span>');
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const STATUS_TEXT = { pending: 'Not signed yet', viewed: 'Opened, not signed yet', signed: 'Signed', revoked: 'Link turned off', expired: 'Expired without a signature' };

export function recordHtml({ link, carrier, documents = [], tz = 'UTC', generatedAt = new Date() }) {
  const status = linkStatus(link, generatedAt);
  const sig = decodeSignature(link.signatureData);
  const textHash = agreementHash(link.agreementBody);
  const hashOk = textHash === link.agreementHash;
  const sigHtml = !sig ? '<p class="muted">No signature.</p>'
    : sig.type === 'typed' ? `<p class="typed">${esc(sig.value)}</p><p class="muted small">Typed signature</p>`
      : `<div class="drawn">${signatureSvg(sig.value, { width: 300 })}</div><p class="muted small">Drawn signature</p>`;
  const rows = (pairs) => pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
  const docs = documents.length
    ? `<table class="list"><thead><tr><th>Document</th><th>File</th><th>Size</th><th>Uploaded</th></tr></thead><tbody>${documents.map((d) => `<tr><td>${esc(DOC_KIND_LABEL[kindOfStored(d.storedName)] || d.type)}</td><td>${esc(d.originalName)}</td><td>${esc(kb(d.sizeBytes))}</td><td>${both(d.createdAt, tz)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No documents uploaded through this link.</p>';
  const audit = auditTrail(link, documents).map((e) => `<tr><td>${both(e.at, tz)}</td><td>${esc(e.text)}${e.ip ? `<br><span class="muted small">IP ${esc(e.ip)}</span>` : ''}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(link.agreementTitle)} - ${esc(carrier.companyName)}</title>
<style>
  body { font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; background: #fff; margin: 0; }
  main { max-width: 800px; margin: 0 auto; padding: 32px 24px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 15px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; font-weight: 600; }
  .muted { color: #555; } .small { font-size: 12px; }
  .agreement { white-space: pre-wrap; word-wrap: break-word; border: 1px solid #ddd; border-radius: 6px; padding: 16px; background: #fafafa; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #eee; }
  table.kv th { width: 34%; color: #444; font-weight: 500; }
  table.list th { color: #444; font-weight: 500; }
  .typed { font: italic 30px/1.2 "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive; margin: 8px 0 0; }
  .drawn svg { max-width: 100%; height: auto; border-bottom: 1px solid #999; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #eee; font-size: 12px; }
  .ok { color: #116329; } .bad { color: #b42318; }
  @media print { main { padding: 0; } h2 { break-after: avoid; } .agreement { background: #fff; } }
</style>
</head>
<body>
<main>
  <h1>${esc(link.agreementTitle)}</h1>
  <p class="muted">${esc(carrier.companyName)}${carrier.mcNumber ? ` · MC ${esc(carrier.mcNumber)}` : ''}${carrier.dotNumber ? ` · USDOT ${esc(carrier.dotNumber)}` : ''} · <span class="badge">${esc(STATUS_TEXT[status] || status)}</span></p>

  <h2>Agreement text</h2>
  <div class="agreement">${esc(link.agreementBody)}</div>

  <h2>Signature</h2>
  ${sigHtml}
  <table class="kv">${rows([
    ['Signer name', esc(link.signerName || '')],
    ['Signer title', esc(link.signerTitle || '')],
    ['Signer email', esc(link.signerEmail || '')],
    ['Signed', link.signedAt ? both(link.signedAt, tz) : '<span class="muted">Not signed</span>'],
    ['Consent to sign electronically', both(link.consentAt, tz)],
    ['IP address', esc(link.signerIp || '')],
    ['Browser (user agent)', `<code>${esc(link.signerUserAgent || '')}</code>`],
  ])}</table>

  <h2>Document integrity</h2>
  <table class="kv">${rows([
    ['SHA-256 of the agreement text', `<code>${esc(link.agreementHash)}</code>`],
    ['Check of the text above', hashOk ? '<span class="ok">Matches the hash the signer agreed to</span>' : '<span class="bad">Does not match the stored hash</span>'],
    ['Dispatch fee', link.feePercent != null ? `${esc(String(link.feePercent))}% of gross line haul` : ''],
    ['Link created', both(link.createdAt, tz)],
    ['Link valid until', both(link.expiresAt, tz)],
  ])}</table>

  <h2>Documents uploaded</h2>
  ${docs}

  <h2>Audit trail</h2>
  <table class="list"><thead><tr><th>Time</th><th>Event</th></tr></thead><tbody>${audit}</tbody></table>

  <p class="muted small" style="margin-top:28px">Electronic record generated ${esc(utc(generatedAt))}. Use your browser's print command to save it as a PDF.</p>
</main>
</body>
</html>`;
}
