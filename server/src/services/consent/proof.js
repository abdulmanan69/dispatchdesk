import { consentHash, formatPhone, channelsLabel, SOURCE_LABEL } from './index.js';

/**
 * Printable proof of one consent to automated calls and texts: the exact wording, its SHA-256 hash (checked against the
 * stored text), the phone number, channels, when and how it was given, IP address and browser, who recorded it, and the
 * revocation. Every value is escaped; served with a CSP that allows no scripts.
 */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inZone(d, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(d));
  } catch {
    return new Date(d).toUTCString();
  }
}
const utc = (d) => (d ? `${new Date(d).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '');
const both = (d, tz) => (d ? `${esc(utc(d))}<br><span class="muted">${esc(inZone(d, tz))}</span>` : '<span class="muted">None</span>');
const none = '<span class="muted">Not recorded</span>';

/**
 * @param consent      ContactConsent row
 * @param carrier      { companyName, mcNumber, dotNumber }
 * @param recordedBy   name of the workspace user who recorded a manual consent (from the activity log), optional
 * @param revokedBy    name of the workspace user who recorded the revocation, optional
 * @param proofDocument { originalName, type, createdAt } of the attached proof, optional
 * @param link         onboarding link { agreementTitle, signedAt, signerEmail, signerTitle } for onboarding consents, optional
 */
export function proofHtml({ consent, carrier, recordedBy = null, revokedBy = null, proofDocument = null, link = null, tz = 'UTC', generatedAt = new Date() }) {
  const hashOk = consentHash(consent.consentText) === consent.consentHash;
  const status = consent.revokedAt ? 'Revoked' : 'Active';
  const rows = (pairs) => pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('');
  const how = [
    esc(SOURCE_LABEL[consent.source] || consent.source),
    ...(link ? [`<br><span class="muted small">${esc(link.agreementTitle || 'Dispatch agreement')}${link.signedAt ? `, signed ${esc(utc(link.signedAt))}` : ''}${link.signerEmail ? ` by ${esc(link.signerEmail)}` : ''}</span>`] : []),
  ].join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Consent to calls and texts - ${esc(carrier.companyName)}</title>
<style>
  body { font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; background: #fff; margin: 0; }
  main { max-width: 800px; margin: 0 auto; padding: 32px 24px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 15px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; font-weight: 600; }
  .muted { color: #555; } .small { font-size: 12px; }
  .wording { white-space: pre-wrap; word-wrap: break-word; border: 1px solid #ddd; border-radius: 6px; padding: 16px; background: #fafafa; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #eee; }
  table.kv th { width: 34%; color: #444; font-weight: 500; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #eee; font-size: 12px; }
  .ok { color: #116329; } .bad { color: #b42318; }
  @media print { main { padding: 0; } h2 { break-after: avoid; } .wording { background: #fff; } }
</style>
</head>
<body>
<main>
  <h1>Consent to automated calls and texts</h1>
  <p class="muted">${esc(carrier.companyName)}${carrier.mcNumber ? ` · MC ${esc(carrier.mcNumber)}` : ''}${carrier.dotNumber ? ` · USDOT ${esc(carrier.dotNumber)}` : ''} · <span class="badge">${esc(status)}</span></p>

  <h2>Wording the person agreed to</h2>
  <div class="wording">${esc(consent.consentText)}</div>

  <h2>Consent</h2>
  <table class="kv">${rows([
    ['Phone number', esc(formatPhone(consent.phone))],
    ['Channels', esc(channelsLabel(consent.channels))],
    ['Given by', consent.grantedByName ? esc(consent.grantedByName) : none],
    ['Given', both(consent.grantedAt, tz)],
    ['How', how],
    ...(recordedBy ? [['Recorded by', esc(recordedBy)]] : []),
    ...(consent.note ? [['Note on how consent was obtained', esc(consent.note)]] : []),
    ...(consent.proofDocumentId ? [['Proof document', proofDocument ? `${esc(proofDocument.originalName)}${proofDocument.createdAt ? `<br><span class="muted small">Uploaded ${esc(utc(proofDocument.createdAt))}</span>` : ''}` : '<span class="muted">Document no longer on file</span>']] : []),
    ['IP address', consent.ip ? esc(consent.ip) : none],
    ['Browser (user agent)', consent.userAgent ? `<code>${esc(consent.userAgent)}</code>` : none],
  ])}</table>

  <h2>Integrity</h2>
  <table class="kv">${rows([
    ['SHA-256 of the wording', `<code>${esc(consent.consentHash)}</code>`],
    ['Check of the wording above', hashOk ? '<span class="ok">Matches the stored hash</span>' : '<span class="bad">Does not match the stored hash</span>'],
    ['Record created', both(consent.createdAt, tz)],
  ])}</table>

  <h2>Revocation</h2>
  ${consent.revokedAt ? `<table class="kv">${rows([
    ['Revoked', both(consent.revokedAt, tz)],
    ['Reason or how it was revoked', consent.revokeReason ? esc(consent.revokeReason) : none],
    ...(revokedBy ? [['Recorded by', esc(revokedBy)]] : []),
  ])}</table>` : '<p class="muted">Not revoked. The person can revoke this consent at any time by any reasonable means.</p>'}

  <p class="muted small" style="margin-top:28px">Electronic record generated ${esc(utc(generatedAt))}. Use your browser's print command to save it as a PDF.</p>
</main>
</body>
</html>`;
}
