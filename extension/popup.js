import { api, dial, focusPanel, getConfig, usPhone, prettyPhone } from './lib.js';

const $ = (id) => document.getElementById(id);

function showMessage(text, tone = 'info') {
  const el = $('message');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = !text;
}

/**
 * Runs inside the page (only when the user opens the popup — activeTab).
 * Returns phone numbers, USDOT and MC numbers found in the visible text.
 */
function scanPage() {
  const text = (document.body?.innerText || '').slice(0, 400000);
  const phones = new Set();
  const dots = new Set();
  const mcs = new Set();
  const phoneRe = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
  for (const m of text.matchAll(phoneRe)) phones.add(`${m[1]}${m[2]}${m[3]}`);
  const dotRe = /\b(?:US\s*)?DOT(?:\s*(?:Number|No\.?|#))?\s*[:#-]?\s*(\d{4,8})\b/gi;
  for (const m of text.matchAll(dotRe)) dots.add(m[1]);
  const mcRe = /\b(?:Docket\s*)?MC\s*(?:Number|No\.?)?\s*[-#:]?\s*(\d{4,8})\b/gi;
  for (const m of text.matchAll(mcRe)) mcs.add(m[1]);
  return { phones: [...phones].slice(0, 25), dots: [...dots].slice(0, 25), mcs: [...mcs].slice(0, 25), title: document.title, url: location.href };
}

function item(label, sub, actions) {
  const li = document.createElement('li');
  li.className = 'item';
  const text = document.createElement('div');
  text.className = 'item-text';
  const a = document.createElement('div');
  a.className = 'mono';
  a.textContent = label;
  text.append(a);
  if (sub) {
    const b = document.createElement('div');
    b.className = 'muted small';
    b.textContent = sub;
    text.append(b);
  }
  const btns = document.createElement('div');
  btns.className = 'item-actions';
  for (const [name, fn, primary] of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'btn small primary' : 'btn small';
    btn.textContent = name;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      showMessage('');
      try { await fn(btn); } catch (err) { showMessage(err.message, 'error'); } finally { btn.disabled = false; }
    });
    btns.append(btn);
  }
  li.append(text, btns);
  return li;
}

async function openInApp(path) {
  const { appUrl } = await getConfig();
  chrome.tabs.create({ url: `${appUrl}${path}` });
}

async function findCarrier(q) {
  const res = await api('GET', `/api/carriers?q=${encodeURIComponent(q)}&pageSize=1`);
  return res.items?.[0] || null;
}

/** Open the call panel in this window. Must run inside a click handler (user gesture). */
async function openPanel() {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
}

/** Call from a click: open the side panel for disposition, dial, then hand the carrier to the panel. */
async function callNumber(phone) {
  const panel = openPanel().catch(() => null);
  const res = await dial({ phone });
  await focusPanel({ carrierId: res.carrier?.id || null, phone, attemptId: res.attempt?.id || null });
  await panel;
  showMessage(res.carrier ? `${res.message}. Log the outcome in the side panel.` : res.message, 'ok');
}

function phoneRow(d) {
  return item(prettyPhone(d), 'Phone number', [
    ['Call', async () => { await callNumber(d); }, true],
    ['Find', async () => {
      const c = await findCarrier(d);
      if (c) await openInApp(`/app/carriers/${c.id}`);
      else showMessage(`No carrier with ${prettyPhone(d)} in your CRM`);
    }],
  ]);
}

function idRow(type, value) {
  const label = type === 'dot' ? `USDOT ${value}` : `MC ${value}`;
  return item(label, type === 'dot' ? 'USDOT number' : 'MC docket number', [
    ['Find', async () => {
      const c = await findCarrier(value);
      if (c) await openInApp(`/app/carriers/${c.id}`);
      else showMessage(`${label} is not in your CRM yet`);
    }],
    ['Add to CRM', async (btn) => {
      let dot = value;
      if (type === 'mc') {
        const look = await api('GET', `/api/discovery/lookup?mc=${encodeURIComponent(value)}`);
        if (!look.record?.dotNumber) throw new Error(`${label} was not found in the FMCSA census`);
        dot = look.record.dotNumber;
      }
      const res = await api('POST', '/api/discovery/save', { dotNumbers: [dot] });
      const created = res.created ?? res.saved ?? (Array.isArray(res.items) ? res.items.length : 0);
      if (created) { showMessage(`Added ${label} to your carrier list`, 'ok'); btn.textContent = 'Added'; }
      else showMessage(res.skipped ? `${label} is already in your CRM` : (res.message || `${label} was not added`), res.skipped ? 'info' : 'error');
    }, true],
  ]);
}

async function scan() {
  const list = $('results');
  list.replaceChildren();
  $('scan-note').textContent = 'Reading this page…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || /^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
    $('scan-note').textContent = 'This page can’t be read. Open a website such as FMCSA SAFER or a load board.';
    return;
  }
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPage });
  } catch (err) {
    $('scan-note').textContent = `Could not read this page: ${err.message}`;
    return;
  }
  const rows = [
    ...result.dots.map((v) => idRow('dot', v)),
    ...result.mcs.map((v) => idRow('mc', v)),
    ...result.phones.map(phoneRow),
  ];
  $('scan-note').textContent = rows.length
    ? `${result.phones.length} phone, ${result.dots.length} USDOT, ${result.mcs.length} MC found`
    : 'No phone, USDOT or MC numbers found on this page.';
  list.replaceChildren(...rows);
}

async function manual(e) {
  e.preventDefault();
  const v = $('manual-input').value.trim();
  if (!v) return;
  showMessage('');
  try {
    const phone = usPhone(v);
    const mc = v.match(/\bMC\s*[-#:]?\s*(\d{4,8})\b/i);
    if (mc) { $('results').prepend(idRow('mc', mc[1])); return; }
    if (phone && !/dot/i.test(v)) { await callNumber(phone); return; }
    const d = v.replace(/\D/g, '');
    if (d.length >= 4 && d.length <= 8) { $('results').prepend(idRow('dot', d)); return; }
    showMessage('Enter a US phone number, a USDOT number or an MC number', 'error');
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

async function init() {
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('open-app').addEventListener('click', () => openInApp('/app').catch((e) => showMessage(e.message, 'error')));
  $('rescan').addEventListener('click', scan);
  $('manual').addEventListener('submit', manual);
  $('workspace').addEventListener('click', async () => {
    showMessage('');
    const win = await chrome.windows.getCurrent();
    const res = await chrome.runtime.sendMessage({ type: 'open-workspace', windowId: win.id });
    showMessage(res?.ok ? res.message : (res?.error || 'Could not open the workspace'), res?.ok ? 'ok' : 'error');
  });
  $('panel').addEventListener('click', () => openPanel().then(() => window.close()).catch((e) => showMessage(e.message, 'error')));

  const { appUrl, token } = await getConfig();
  if (!appUrl || !token) {
    $('status').textContent = 'Not connected';
    $('status').dataset.tone = 'warn';
    $('setup').hidden = false;
    return;
  }
  try {
    const me = await api('GET', '/api/auth/me');
    if (!me.user) throw new Error('Token not accepted');
    $('status').textContent = me.user.name;
    $('status').dataset.tone = 'ok';
  } catch (err) {
    $('status').textContent = 'Connection problem';
    $('status').dataset.tone = 'warn';
    showMessage(err.message, 'error');
  }
  $('main').hidden = false;
  scan();
}

init();
