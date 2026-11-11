/**
 * Print-friendly HTML (the browser's Print / Save as PDF) and plain-text versions of invoices and weekly
 * statements. Every value is HTML-escaped; the pages carry no scripts (the CSP allows inline styles only). The
 * account's logo, when it has one, is embedded as a data: image (the app CSP allows img-src data:).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../db.js';
import { config } from '../../config.js';

/** Upload subdirectory of invoice logos (written by routes/settings.js). */
export const LOGO_DIR = 'logos';
const LOGO_FILE_MAX = 600 * 1024; // the upload limit is 500 KB; anything larger on disk is not embedded
const LOGO_CACHE_MAX = 32;
const LOGO_CACHE_MAX_CHARS = 8 * 1024 * 1024;
// storedName -> data: URI, least recently used first. A new upload gets a new name, so entries never go stale.
const logoCache = new Map();
let logoCacheChars = 0;

function logoMime(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** A stored logo as a data: URI (cached per process), or null when the file is missing or not a PNG or JPEG. */
export async function logoDataUri(storedName) {
  if (!storedName) return null;
  const key = path.basename(String(storedName));
  const hit = logoCache.get(key);
  if (hit) {
    logoCache.delete(key);
    logoCache.set(key, hit);
    return hit;
  }
  let buf;
  try { buf = await fsp.readFile(path.join(config.uploadDir, LOGO_DIR, key)); } catch { return null; }
  const mime = buf.length <= LOGO_FILE_MAX ? logoMime(buf) : null;
  if (!mime) return null;
  const uri = `data:${mime};base64,${buf.toString('base64')}`;
  if (!logoCache.has(key)) {
    logoCache.set(key, uri);
    logoCacheChars += uri.length;
    while (logoCache.size > LOGO_CACHE_MAX || logoCacheChars > LOGO_CACHE_MAX_CHARS) {
      const [oldKey, oldUri] = logoCache.entries().next().value;
      logoCache.delete(oldKey);
      logoCacheChars -= oldUri.length;
    }
  }
  return uri;
}

/**
 * The logo printed on an account's invoices and statements: { src, alt } or null. alt is the team name, else the
 * company name from Settings, else the user's name. Pass the record owner's id (not the viewer's).
 */
export async function brandLogo(ownerId) {
  if (!ownerId) return null;
  const u = await prisma.user.findUnique({
    where: { id: String(ownerId) },
    select: { name: true, companyName: true, invoiceLogo: true, teamMembership: { select: { team: { select: { name: true } } } } },
  });
  if (!u?.invoiceLogo) return null;
  const src = await logoDataUri(u.invoiceLogo);
  return src ? { src, alt: u.teamMembership?.team?.name || u.companyName || u.name || 'Company logo' } : null;
}

const DATA_IMAGE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/;
/** Logo block for the top of a page; empty (no markup at all) without a logo. Only PNG or JPEG data: URIs render. */
const logoBlock = (logo) => (logo?.src && DATA_IMAGE.test(logo.src)
  ? `<div class="brand"><img src="${esc(logo.src)}" alt="${esc(logo.alt || 'Company logo')}"></div>`
  : '');

const esc =(v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const usd = (cents) => (cents == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100));

function safeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'America/Chicago'; }
}
export function day(d, tz = 'America/Chicago') {
  if (!d) return '—';
  const plain = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const x = new Date(plain ? `${d}T12:00:00Z` : d);
  if (Number.isNaN(x.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: plain ? 'UTC' : safeZone(tz), month: 'short', day: 'numeric', year: 'numeric' }).format(x);
}
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
const qty = (q) => (Number.isInteger(q) ? String(q) : Number(q).toFixed(2));

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #1b1f24; font: 14px/1.5 "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .page { max-width: 820px; margin: 0 auto; padding: 36px 28px 48px; }
  .hint { margin: 0 0 20px; padding: 8px 12px; border: 1px solid #d8dde3; border-radius: 8px; background: #f6f8fa; color: #4b5563; font-size: 13px; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 20px; border-bottom: 2px solid #1b1f24; padding-bottom: 16px; }
  .brand { margin: 0 0 12px; }
  .brand img { display: block; width: auto; height: auto; max-width: 240px; max-height: 80px; }
  h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; }
  h2 { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #4b5563; text-transform: none; }
  .muted { color: #4b5563; }
  .small { font-size: 12px; }
  .meta { text-align: right; }
  .meta div { white-space: nowrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 20px; }
  .box { border: 1px solid #d8dde3; border-radius: 8px; padding: 12px 14px; }
  table { width: 100%; border-collapse: collapse; margin-top: 22px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid #e5e8ec; text-align: left; vertical-align: top; }
  th { font-size: 12px; font-weight: 600; color: #4b5563; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .totals { margin: 14px 0 0 auto; width: 300px; max-width: 100%; }
  .totals div { display: flex; justify-content: space-between; padding: 3px 0; font-variant-numeric: tabular-nums; }
  .totals .grand { margin-top: 6px; padding-top: 8px; border-top: 2px solid #1b1f24; font-size: 16px; font-weight: 600; }
  .badge { display: inline-block; margin-top: 6px; padding: 1px 8px; border: 1px solid #b8c0ca; border-radius: 999px; font-size: 12px; }
  .notes { margin-top: 22px; white-space: pre-wrap; }
  footer { margin-top: 32px; font-size: 12px; color: #4b5563; }
  @media (max-width: 560px) { .page { padding: 20px 14px 32px; } .meta { text-align: left; } th:nth-child(2), td:nth-child(2) { display: none; } }
  @media print { .hint { display: none; } .page { padding: 0; max-width: none; } @page { margin: 14mm; } }
`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main class="page"><p class="hint">Use your browser's Print command (Ctrl+P or Cmd+P) to print or save this page as a PDF.</p>${body}</main></body></html>`;

const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', partial: 'Partly paid', paid: 'Paid', void: 'Void' };

/**
 * Invoice page. `from` is who issues it: { name, lines: [] } (the carrier for freight invoices, the dispatcher for
 * dispatch-fee invoices); `preparedBy` names the dispatcher for freight invoices.
 */
export function invoiceHtml(inv, { from, preparedBy, tz, logo } = {}) {
  const m = inv.meta || {};
  const rows = (inv.items || []).map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${esc(qty(l.quantity))}</td><td class="num">${usd(l.unitCents)}</td><td class="num">${usd(l.amountCents)}</td></tr>`).join('');
  const payments = (m.payments || []).map((p) => `<div><span>Payment ${esc(day(p.at, tz))}${p.method ? ` · ${esc(p.method)}` : ''}${p.reference ? ` · ${esc(p.reference)}` : ''}</span><span>−${usd(p.amountCents)}</span></div>`).join('');
  const load = [m.reference && `Reference ${esc(m.reference)}`, m.lane && esc(m.lane), m.pickupDate && `Picked up ${esc(day(m.pickupDate))}`, m.deliveryDate && `Delivered ${esc(day(m.deliveryDate))}`].filter(Boolean).join('<br>');
  const body = `
<header>
  <div>
    ${logoBlock(logo)}
    <h1>${inv.kind === 'dispatch_fee' ? 'Dispatch fee invoice' : 'Invoice'}</h1>
    <div><strong>${esc(from?.name || '')}</strong></div>
    ${(from?.lines || []).filter(Boolean).map((x) => `<div class="muted small">${esc(x)}</div>`).join('')}
  </div>
  <div class="meta">
    <div><strong>Invoice #${esc(inv.number)}</strong></div>
    <div class="muted">Issued ${esc(day(inv.issuedAt || inv.createdAt, tz))}</div>
    <div class="muted">Due ${esc(day(inv.dueAt, tz))}${m.terms ? ` · ${esc(m.terms)}` : ''}</div>
    <span class="badge">${esc(STATUS_LABEL[inv.status] || inv.status)}</span>
  </div>
</header>
<section class="grid">
  <div class="box"><h2>Bill to</h2><div><strong>${esc(inv.billToName)}</strong></div>${inv.billToEmail ? `<div class="muted small">${esc(inv.billToEmail)}</div>` : ''}</div>
  ${load ? `<div class="box"><h2>Load</h2><div class="small">${load}</div></div>` : ''}
  ${m.remitTo ? `<div class="box"><h2>Remit to</h2><div class="small">${nl2br(m.remitTo)}</div></div>` : ''}
</section>
<table>
  <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" class="muted">No line items</td></tr>'}</tbody>
</table>
<div class="totals">
  <div><span>Total</span><span>${usd(inv.amountCents)}</span></div>
  ${payments}
  <div class="grand"><span>Balance due</span><span>${usd(Math.max(0, inv.amountCents - (inv.paidCents || 0)))}</span></div>
</div>
${inv.notes ? `<div class="notes"><h2>Notes</h2>${esc(inv.notes)}</div>` : ''}
${preparedBy ? `<footer>Prepared by ${esc(preparedBy)}${inv.kind === 'freight' && m.carrier?.name ? ` on behalf of ${esc(m.carrier.name)}` : ''}.</footer>` : ''}`;
  return page(`Invoice ${inv.number} · ${inv.billToName}`, body);
}

/** Plain-text invoice for an email body. */
export function invoiceText(inv, { from, tz } = {}) {
  const m = inv.meta || {};
  const lines = [
    `Invoice #${inv.number}${from?.name ? ` from ${from.name}` : ''}`,
    `Bill to: ${inv.billToName}`,
    `Issued: ${day(inv.issuedAt || new Date(), tz)} · Due: ${day(inv.dueAt, tz)}${m.terms ? ` (${m.terms})` : ''}`,
  ];
  const load = [m.reference && `Ref ${m.reference}`, m.lane, m.deliveryDate && `delivered ${day(m.deliveryDate)}`].filter(Boolean).join(' · ');
  if (load) lines.push(`Load: ${load}`);
  if (inv.kind === 'freight' && m.carrier?.name) lines.push(`Carrier: ${m.carrier.name}${m.carrier.mc ? ` (MC ${m.carrier.mc})` : ''}`);
  lines.push('');
  for (const l of inv.items || []) lines.push(`${l.description}: ${usd(l.amountCents)}`);
  lines.push('', `Total: ${usd(inv.amountCents)}`);
  if (inv.paidCents) lines.push(`Paid: ${usd(inv.paidCents)}`);
  lines.push(`Balance due: ${usd(Math.max(0, inv.amountCents - (inv.paidCents || 0)))}`);
  if (m.remitTo) lines.push('', 'Remit to:', m.remitTo);
  if (inv.notes) lines.push('', inv.notes);
  return lines.join('\n');
}

/** Weekly statement page (also used by the carrier portal). */
export function statementHtml(st, { from, tz, logo } = {}) {
  const end = new Date(new Date(st.periodEnd).getTime() - 1);
  const rows = st.lines.map((l) => `<tr>
    <td>${esc(day(l.date, tz))}</td>
    <td>${esc(l.lane)}${l.reference ? `<div class="muted small">Ref ${esc(l.reference)}${l.broker ? ` · ${esc(l.broker)}` : ''}</div>` : l.broker ? `<div class="muted small">${esc(l.broker)}</div>` : ''}</td>
    <td class="num">${usd(l.grossCents)}</td>
    <td class="num">${l.ratePerMile != null ? `$${l.ratePerMile.toFixed(2)}` : '—'}</td>
    <td class="num">${l.feePercent != null ? `${esc(l.feePercent)}%` : '—'}</td>
    <td class="num">${usd(l.feeCents)}</td>
    <td class="num">${usd(l.netCents)}</td></tr>`).join('');
  const t = st.totals;
  const body = `
<header>
  <div>
    ${logoBlock(logo)}
    <h1>Dispatch statement</h1>
    <div><strong>${esc(st.carrier.companyName)}</strong></div>
    <div class="muted small">${[st.carrier.mcNumber && `MC ${st.carrier.mcNumber}`, st.carrier.dotNumber && `USDOT ${st.carrier.dotNumber}`].filter(Boolean).map(esc).join(' · ')}</div>
  </div>
  <div class="meta">
    <div><strong>Week of ${esc(day(st.periodStart, tz))}</strong></div>
    <div class="muted">${esc(day(st.periodStart, tz))} to ${esc(day(end, tz))}</div>
    ${from?.name ? `<div class="muted small">From ${esc(from.name)}</div>` : ''}
  </div>
</header>
<table>
  <thead><tr><th>Delivered</th><th>Load</th><th class="num">Gross</th><th class="num">RPM</th><th class="num">Fee %</th><th class="num">Fee</th><th class="num">Net</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" class="muted">No delivered loads this week</td></tr>'}</tbody>
</table>
<div class="totals">
  <div><span>Loads</span><span>${t.loads}</span></div>
  <div><span>Loaded miles</span><span>${t.loadedMiles.toLocaleString('en-US')}</span></div>
  <div><span>Gross</span><span>${usd(t.grossCents)}</span></div>
  <div><span>Dispatch fee</span><span>${usd(t.feeCents)}</span></div>
  <div class="grand"><span>Net to carrier</span><span>${usd(t.netCents)}</span></div>
</div>
${t.missingFee ? `<p class="muted small">${t.missingFee} load${t.missingFee === 1 ? ' has' : 's have'} no fee percent set and ${t.missingFee === 1 ? 'is' : 'are'} not included in the fee.</p>` : ''}`;
  return page(`Statement · ${st.carrier.companyName} · week of ${st.weekStart}`, body);
}

/** Plain-text statement for an email body. */
export function statementText(st, { from, tz, portalUrl } = {}) {
  const t = st.totals;
  const end = new Date(new Date(st.periodEnd).getTime() - 1);
  const lines = [
    `Dispatch statement for ${st.carrier.companyName}`,
    `Week of ${day(st.periodStart, tz)} to ${day(end, tz)}${from?.name ? ` · from ${from.name}` : ''}`,
    '',
  ];
  for (const l of st.lines) {
    lines.push(`${day(l.date, tz)} · ${l.lane}${l.reference ? ` · ref ${l.reference}` : ''}: gross ${usd(l.grossCents)}, fee ${l.feePercent != null ? `${l.feePercent}% ` : ''}${usd(l.feeCents)}, net ${usd(l.netCents)}`);
  }
  if (!st.lines.length) lines.push('No delivered loads this week.');
  lines.push('', `Loads: ${t.loads}`, `Gross: ${usd(t.grossCents)}`, `Dispatch fee: ${usd(t.feeCents)}`, `Net to carrier: ${usd(t.netCents)}`);
  if (portalUrl) lines.push('', `Your statements and load documents: ${portalUrl}`);
  return lines.join('\n');
}
