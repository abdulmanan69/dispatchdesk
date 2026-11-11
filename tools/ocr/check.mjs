#!/usr/bin/env node
/**
 * Real check of the self-hosted OCR files (run after tools/ocr/vendor.mjs or after upgrading tesseract.js/pdfjs-dist):
 *
 *   node tools/ocr/check.mjs
 *
 * Needs client/node_modules and Playwright's Chromium from e2e/node_modules (cd e2e && npm install && npx playwright
 * install chromium). Nothing here touches the app server or the database.
 *
 * 1. Draws a scanned-looking rate con (slightly rotated, blurred, speckled) with Chromium and saves it as a PNG and as
 *    an image-only PDF (one JPEG page, no text layer).
 * 2. Node: tesseract.js reads the PNG with the vendored model client/public/ocr/eng.traineddata.gz.
 * 3. Browser: Chromium runs the real client/src/components/dispatch/ocr.js and pdfText.js against a local server that
 *    serves client/public/ocr at /ocr/ with the production Content-Security-Policy, and reads the PNG (SIMD and plain
 *    engine) and the scanned PDF, cancels a run, and records every request (all must stay on the origin). The same
 *    photo is then tried with the old CSP (no 'wasm-unsafe-eval'), which must block it.
 * Exits with code 1 when "RATE CONFIRMATION" or the $2,350.00 total is not recognized, or a check fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT = path.join(ROOT, 'client');
const OCR_DIR = path.join(CLIENT, 'public', 'ocr');
const fromClient = createRequire(path.join(CLIENT, 'package.json'));
const fromE2e = createRequire(path.join(ROOT, 'e2e', 'package.json'));

// Mirrors the helmet directives in server/src/app.js (server/tests/csp.test.js pins script-src and worker-src).
const CSP = [
  "default-src 'self'", "base-uri 'self'", "font-src 'self' data:", "form-action 'self'", "frame-ancestors 'self'",
  "img-src 'self' data: blob: https:", "object-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'", "connect-src 'self' https://tiles.openfreemap.org", "worker-src 'self' blob:", "media-src 'self' blob:",
].join('; ');
const OLD_CSP = CSP.replace(" 'wasm-unsafe-eval'", '');

const RATE_CON = `
  <div class="head"><b>SUMMIT LOGISTICS LLC</b><span>MC# 123456 &nbsp; (214) 555-0142</span></div>
  <h1>RATE CONFIRMATION</h1>
  <p>Load # 48213 &nbsp;&nbsp; Date: 11/10/2026</p>
  <p>Carrier: Lone Star Haulers Inc &nbsp; MC# 987654</p>
  <div class="cols"><div><b>SHIPPER</b><br>Big Box DC<br>1200 Industrial Blvd<br>Dallas, TX 75201<br>Pickup: 11/12/2026 08:00 - 14:00</div>
  <div><b>CONSIGNEE</b><br>Corner Market<br>55 Peachtree St<br>Atlanta, GA 30303<br>Delivery: 11/13/2026 16:00</div></div>
  <p>Equipment: 53' Dry Van &nbsp; Weight: 42,000 lbs &nbsp; Miles: 781</p>
  <table><tr><td>Line haul</td><td>$2,150.00</td></tr><tr><td>Fuel surcharge</td><td>$200.00</td></tr>
  <tr><td><b>Total carrier pay</b></td><td><b>$2,350.00</b></td></tr></table>
  <p class="small">Carrier agrees to the terms above. Sign and return by fax or email.</p>`;
const PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #ece9df; }
  .sheet { width: 1275px; height: 1650px; box-sizing: border-box; padding: 110px 120px; color: #26241f;
    font: 25px/1.5 "Times New Roman", serif; transform: rotate(0.6deg); filter: blur(0.55px) contrast(0.92);
    background: radial-gradient(circle at 20% 30%, rgba(0,0,0,.05) 0 2px, transparent 3px) 0 0 / 37px 41px,
      radial-gradient(circle at 70% 60%, rgba(0,0,0,.06) 0 1px, transparent 2px) 0 0 / 23px 29px, #f4f2ea; }
  .head { display: flex; justify-content: space-between; font-size: 22px; }
  h1 { font-size: 46px; letter-spacing: 2px; margin: 50px 0 30px; }
  .cols { display: flex; gap: 60px; margin: 24px 0; } .cols > div { flex: 1; border: 2px solid #444; padding: 12px 16px; }
  table { margin-top: 30px; border-collapse: collapse; } td { padding: 6px 40px 6px 0; }
  .small { font-size: 19px; margin-top: 60px; }
</style></head><body><div class="sheet">${RATE_CON}</div></body></html>`;

/** An image-only PDF: one US Letter page showing a JPEG (like a scanner or phone scan app writes). */
function jpegPdf(jpeg, width, height) {
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    parts.push(buf);
    length += buf.length;
  };
  const obj = (n, dict, stream) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${dict}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  const content = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q');
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  obj(5, `<< /Length ${content.length} >>`, content);
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const recognized = (text) => ({
  title: /RATE\s+CONFIRMATION/i.test(text),
  total: /\$\s?2,?350\.00/.test(text),
});

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.png': 'image/png', '.pdf': 'application/pdf', '.html': 'text/html', '.txt': 'text/plain' };

const CHECK_JS = `
import { ocrFile, fileKind, needsOcr, OcrCancelled } from '/src/ocr.js';
import { pdfToText } from '/src/pdfText.js';
const get = async (url, name, type) => new File([await (await fetch(url)).blob()], name, { type });
const out = {};
async function step(name, fn) {
  const t0 = performance.now();
  try { out[name] = { ok: true, ...(await fn()), ms: Math.round(performance.now() - t0) }; }
  catch (err) { out[name] = { ok: false, error: String(err?.message || err), cause: String(err?.cause ?? ''), ms: Math.round(performance.now() - t0) }; }
}
const only = new URLSearchParams(location.search).get('only');
await step('photo, SIMD engine', async () => {
  const file = await get('/sample.png', 'rate-con.png', 'image/png');
  const progress = [];
  const res = await ocrFile(file, fileKind(file), { onProgress: (p) => progress.push(p) });
  return { kind: fileKind(file), text: res.text, phases: [...new Set(progress.map((p) => p.phase))], lastPercent: progress.at(-1)?.percent };
});
if (!only) {
  await step('photo, plain engine', async () => {
    const file = await get('/sample.png', 'rate-con.png', 'image/png');
    return { text: (await ocrFile(file, 'image', { simd: false })).text };
  });
  await step('scanned PDF', async () => {
    const file = await get('/scan.pdf', 'scan.pdf', 'application/pdf');
    const layer = (await pdfToText(file)).text;
    const progress = [];
    const res = await ocrFile(file, 'pdf', { onProgress: (p) => progress.push(p) });
    return { kind: fileKind(file), textLayerChars: layer.length, needsOcr: needsOcr('pdf', layer), text: res.text, pages: res.pages, labels: [...new Set(progress.map((p) => p.phase + ' ' + p.page + '/' + p.count))] };
  });
  await step('cancel', async () => {
    const file = await get('/sample.png', 'rate-con.png', 'image/png');
    const ctrl = new AbortController();
    let abortedAt = 0;
    try {
      await ocrFile(file, 'image', { signal: ctrl.signal, onProgress: (p) => { if (p.phase === 'reading' && p.percent > 0 && !abortedAt) { abortedAt = performance.now(); ctrl.abort(); } } });
      return { cancelled: false };
    } catch (err) {
      return { cancelled: err instanceof OcrCancelled, settledAfterAbortMs: Math.round(performance.now() - abortedAt) };
    }
  });
}
window.__ocr = out;
`;

function serve(dir, csp) {
  const files = {
    '/check.html': ['<!doctype html><meta charset="utf-8"><title>OCR check</title><script type="module" src="/check.js"></script>', '.html'],
    '/check.js': [CHECK_JS, '.js'],
    // Bare specifiers of the real modules point at the package builds (no bundler here).
    '/src/ocr.js': [fs.readFileSync(path.join(CLIENT, 'src/components/dispatch/ocr.js'), 'utf8').replace("import('tesseract.js')", "import('/lib/tesseract.js')"), '.js'],
    '/src/pdfText.js': [fs.readFileSync(path.join(CLIENT, 'src/components/dispatch/pdfText.js'), 'utf8')
      .replace("import('pdfjs-dist')", "import('/lib/pdf.mjs')").replace("import('pdfjs-dist/build/pdf.worker.min.mjs?url')", "import('/lib/pdf-worker-url.js')"), '.js'],
    '/lib/tesseract.js': [fs.readFileSync(fromClient.resolve('tesseract.js/dist/tesseract.esm.min.js')), '.js'],
    '/lib/pdf.mjs': [fs.readFileSync(path.join(CLIENT, 'node_modules/pdfjs-dist/build/pdf.min.mjs')), '.mjs'],
    '/lib/pdf.worker.mjs': [fs.readFileSync(path.join(CLIENT, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')), '.mjs'],
    '/lib/pdf-worker-url.js': ["export default '/lib/pdf.worker.mjs';", '.js'],
    '/sample.png': [fs.readFileSync(path.join(dir, 'rate-con.png')), '.png'],
    '/scan.pdf': [fs.readFileSync(path.join(dir, 'scan.pdf')), '.pdf'],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body;
    let ext;
    if (files[url.pathname]) [body, ext] = files[url.pathname];
    else if (url.pathname.startsWith('/ocr/')) {
      const file = path.join(OCR_DIR, ...url.pathname.slice(5).split('/').filter((s) => s && s !== '..'));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) [body, ext] = [fs.readFileSync(file), path.extname(file)];
    }
    res.setHeader('Content-Security-Policy', csp);
    if (body == null) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function inBrowser(browser, dir, csp, query = '') {
  const server = await serve(dir, csp);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  const consoleErrors = [];
  page.on('request', (r) => requests.push(r.url()));
  context.on('serviceworker', () => {});
  page.on('console', (m) => { if (m.type() === 'error' || /Refused|Content Security Policy/i.test(m.text())) consoleErrors.push(m.text()); });
  page.on('worker', (w) => w.on('console', (m) => { if (/Refused|Content Security Policy|failed/i.test(m.text())) consoleErrors.push(`[worker] ${m.text()}`); }));
  try {
    await page.goto(`${origin}/check.html${query}`);
    await page.waitForFunction(() => window.__ocr, null, { timeout: 240000 });
    const results = await page.evaluate(() => window.__ocr);
    return { results, offOrigin: requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')), requests, consoleErrors };
  } finally {
    await context.close();
    server.close();
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ocr-check-'));
  let failed = false;
  const check = (label, ok, detail = '') => {
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  };
  const { chromium } = fromE2e('@playwright/test');
  const browser = await chromium.launch();
  try {
    // 1. A scanned-looking rate con as PNG, and as an image-only PDF.
    const page = await browser.newPage({ viewport: { width: 1275, height: 1650 } });
    await page.setContent(PAGE);
    fs.writeFileSync(path.join(dir, 'rate-con.png'), await page.screenshot({ type: 'png' }));
    fs.writeFileSync(path.join(dir, 'scan.pdf'), jpegPdf(await page.screenshot({ type: 'jpeg', quality: 80 }), 1275, 1650));
    await page.close();
    console.log(`Sample files in ${dir}`);

    // 2. Node, with the vendored model.
    const { createWorker } = fromClient('tesseract.js');
    const t0 = Date.now();
    const worker = await createWorker('eng', 1, { langPath: OCR_DIR, gzip: true, cacheMethod: 'none' });
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' }); // as ocr.js does
    const { data } = await worker.recognize(path.join(dir, 'rate-con.png'));
    await worker.terminate();
    const node = recognized(data.text);
    console.log(`\n--- Node (${Date.now() - t0} ms, confidence ${Math.round(data.confidence)}) ---\n${data.text.trim()}\n`);
    check('Node: model loads from client/public/ocr/eng.traineddata.gz and reads "RATE CONFIRMATION"', node.title);
    check('Node: reads the total "$2,350.00"', node.total);

    // 3. Chromium, real client modules, production CSP. Recognized text goes through the real server parser.
    const { parseLoadText } = await import(pathToFileURL(path.join(ROOT, 'server/src/services/loads/parser.js')).href);
    const run = await inBrowser(browser, dir, CSP);
    for (const [name, r] of Object.entries(run.results)) {
      if (!r.ok) { check(`Browser: ${name}`, false, `${r.error} ${r.cause}`.trim()); continue; }
      if ('text' in r) {
        const got = recognized(r.text);
        check(`Browser: ${name} reads "RATE CONFIRMATION" and "$2,350.00"`, got.title && got.total, `${r.ms} ms`);
        const parsed = parseLoadText(r.text, { now: new Date('2026-11-10T12:00:00Z') });
        console.log(`      parser found ${parsed.found.length}: ${parsed.found.join(', ')} (rate ${parsed.fields.rateCents / 100}, ${parsed.fields.originCity}, ${parsed.fields.originState})`);
      }
      if (name === 'photo, SIMD engine') {
        console.log(`\n--- Browser text, as sent to the parser ---\n${r.text.replace(/\t/g, ' <TAB> ')}\n`);
        check('Browser: side-by-side columns come out tab-separated, like the PDF text path', /SHIPPER\tCONSIGNEE/.test(r.text));
      }
      if (name === 'photo, SIMD engine') check('Browser: progress goes loading, then reading, to 100%', r.phases.join() === 'loading,reading' && r.lastPercent === 100, r.phases.join(' > '));
      if (name === 'scanned PDF') check('Browser: the scanned PDF has no text layer, so it goes to OCR', r.textLayerChars === 0 && r.needsOcr, r.labels.join(', '));
      if (name === 'cancel') check('Browser: Cancel stops a run', r.cancelled, `settled ${r.settledAfterAbortMs} ms after abort`);
    }
    const ocrFiles = [...new Set(run.requests.filter((u) => u.includes('/ocr/')).map((u) => new URL(u).pathname))];
    console.log(`Browser fetched: ${ocrFiles.join(', ')}`);
    check('Browser: every request stays on the origin (no CDN)', run.offOrigin.length === 0, run.offOrigin.join(', '));
    check('Browser: no CSP violations', !run.consoleErrors.some((m) => /Refused|Content Security Policy/i.test(m)), run.consoleErrors.join(' | '));

    // Without 'wasm-unsafe-eval' the engine cannot compile: proof the CSP change is needed (and enough).
    const old = await inBrowser(browser, dir, OLD_CSP, '?only=photo');
    const blocked = old.results['photo, SIMD engine'];
    check("Browser: the old CSP (no 'wasm-unsafe-eval') blocks OCR", !blocked.ok, old.consoleErrors.find((m) => /WebAssembly|wasm/i.test(m))?.slice(0, 140) || blocked.error);
  } finally {
    await browser.close();
  }
  console.log(failed ? '\nOCR check failed.' : '\nOCR check passed.');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
