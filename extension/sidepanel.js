// Side panel: the call companion. Shows the current carrier, dials on click, and logs the outcome.
import { api, dial, getConfig, prettyPhone, CALL_OUTCOMES, label, dropdown, chips } from './lib.js';

const $ = (id) => document.getElementById(id);
const state = { queue: [], index: 0, focus: null, carrier: null, reason: '', attemptId: null, outcome: '', saving: false, scripts: [], user: null };

function showMessage(text, tone = 'info') {
  const el = $('message');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = !text;
}

const STATE_TZ = { AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver' };
const tzOf = (c) => c?.timezone || STATE_TZ[String(c?.state || '').toUpperCase()] || null;

function localInfo(tz) {
  if (!tz) return { time: '', text: 'Time zone unknown', ok: true };
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(now);
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(now);
  const hour = Number(p.find((x) => x.type === 'hour').value) % 24;
  const wd = p.find((x) => x.type === 'weekday').value;
  if (wd === 'Sat' || wd === 'Sun') return { time, text: 'Weekend locally', ok: false };
  if (hour < 8) return { time, text: 'Too early locally', ok: false };
  if (hour >= 19) return { time, text: 'After hours locally', ok: false };
  return { time, text: hour < 11 ? 'Prime window' : 'Good window', ok: true };
}

/** Next local 9:00 AM in the carrier's zone, `days` ahead. */
function localNineAm(tz, days) {
  const base = new Date(Date.now() + days * 86400000);
  if (!tz) { base.setHours(9, 0, 0, 0); return base; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(base).map((x) => [x.type, x.value]));
  const target = Date.UTC(+parts.year, +parts.month - 1, +parts.day, 9, 0, 0);
  for (let off = -14; off <= 12; off += 0.5) {
    const d = new Date(target - off * 3600000);
    if (new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false }).format(d) === '09:00') return d;
  }
  return new Date(target);
}

function mergeScript(body, c) {
  const map = { company: c?.companyName || 'your company', first_name: 'there', my_name: state.user?.name?.split(' ')[0] || '', mc: c?.mcNumber || '', city: c?.city || '', state: c?.state || '', dot: c?.dotNumber || '' };
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m));
}

// ---------------- Controls ----------------
const followUp = chips({
  ariaLabel: 'Follow-up',
  value: 'auto',
  options: [{ value: 'auto', label: 'Automatic' }, { value: 'tomorrow', label: 'Tomorrow 9 AM' }, { value: 'week', label: 'Next week' }, { value: 'pick', label: 'Pick' }, { value: 'none', label: 'None' }],
  onChange: (v) => { $('followup-at').hidden = v !== 'pick'; },
});
const templates = dropdown({ ariaLabel: 'Email template', placeholder: 'Choose a template', options: [] });

function renderOutcomes() {
  $('outcomes').replaceChildren(...CALL_OUTCOMES.map((o, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'outcome';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.outcome === o));
    b.innerHTML = '<span></span><kbd></kbd>';
    b.firstChild.textContent = label(o);
    b.lastChild.textContent = String(i + 1);
    b.addEventListener('click', () => setOutcome(o));
    return b;
  }));
  $('save').disabled = !state.outcome || !state.carrier || state.saving;
}
function setOutcome(o) { state.outcome = o; renderOutcomes(); }

// ---------------- Carrier display ----------------
function resetForm() {
  state.outcome = '';
  state.attemptId = null;
  $('notes').value = '';
  followUp.set('auto');
  $('followup-at').hidden = true;
  $('followup-at').value = '';
  $('call-status').textContent = '';
  renderOutcomes();
}

async function render() {
  const c = state.carrier;
  const { appUrl } = await getConfig();
  $('empty').hidden = !!c || !!state.focus?.phone;
  $('carrier').hidden = !c && !state.focus?.phone;
  $('dispo').hidden = !c;
  $('email-box').hidden = !c;
  $('script-box').hidden = !c || !state.scripts.length;
  $('position').textContent = state.focus ? 'From your last call' : state.queue.length ? `${state.index + 1} of ${state.queue.length} in today's queue` : '';
  if (!c) {
    if (state.focus?.phone) {
      $('c-name').textContent = prettyPhone(state.focus.phone);
      $('c-name').removeAttribute('href');
      $('c-ids').textContent = '';
      $('c-where').textContent = '';
      $('c-time').textContent = '';
      $('c-window').textContent = '';
      $('c-reason').textContent = 'This number is not in your CRM. Add the carrier in DispatchDesk to log the call.';
      $('call').textContent = `Call ${prettyPhone(state.focus.phone)}`;
    }
    return;
  }
  $('c-name').textContent = c.companyName;
  $('c-name').href = `${appUrl}/app/carriers/${c.id}`;
  $('c-ids').textContent = [c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`].filter(Boolean).join(' · ');
  $('c-where').textContent = [c.city, c.state].filter(Boolean).join(', ');
  const info = localInfo(tzOf(c));
  $('c-time').textContent = info.time;
  $('c-window').textContent = info.text;
  $('c-window').dataset.tone = info.ok ? 'ok' : 'warn';
  $('c-reason').textContent = state.reason || '';
  $('call').textContent = c.phone ? `Call ${prettyPhone(c.phone)}` : 'No phone on file';
  $('call').disabled = !c.phone || c.doNotCall;
  if (c.doNotCall) $('call-status').textContent = 'Marked do-not-call';
  $('email-to').textContent = c.email ? `To ${c.email}` : 'No email address on file';
  $('send-email').disabled = !c.email || c.doNotEmail;
  const script = state.scripts[0];
  $('script').textContent = script ? mergeScript(script.body, c) : '';
  renderOutcomes();
}

function reasonOf(it) {
  if (it.sequence) return `${it.sequence.name} · step ${it.sequence.stepNumber} of ${it.sequence.stepCount}${it.sequence.instructions ? ` — ${it.sequence.instructions}` : ''}`;
  if (it.followUp) return `Follow-up${it.followUp.note ? ` — ${it.followUp.note}` : ''}`;
  return 'Hot lead';
}

async function loadQueue() {
  const q = await api('GET', '/api/prospecting/queue?includeHot=true');
  state.queue = q.items.filter((it) => it.carrier.phone && !it.carrier.doNotCall);
  state.index = Math.min(state.index, Math.max(0, state.queue.length - 1));
}

async function showQueueItem() {
  state.focus = null;
  const it = state.queue[state.index];
  state.carrier = it?.carrier || null;
  state.reason = it ? reasonOf(it) : '';
  resetForm();
  await render();
}

/** A call placed from a web page or the popup: show that carrier with its attempt, ready to disposition. */
async function applyFocus(focus) {
  if (!focus) return;
  state.focus = focus;
  resetForm();
  state.attemptId = focus.attemptId || null;
  if (focus.carrierId) {
    try {
      const res = await api('GET', `/api/carriers/${focus.carrierId}`);
      state.carrier = res.carrier;
      state.reason = 'Called from a web page';
    } catch (err) { state.carrier = null; showMessage(err.message, 'error'); }
  } else {
    state.carrier = null;
  }
  if (state.attemptId) $('call-status').textContent = 'Dialed. Log the outcome when you hang up.';
  await render();
}

async function nextCarrier() {
  if (state.focus) { state.focus = null; await chrome.storage.session.remove('panelFocus'); }
  else state.index += 1;
  if (state.index >= state.queue.length) { await loadQueue().catch(() => {}); if (state.index >= state.queue.length) state.index = state.queue.length; }
  await showQueueItem();
}

// ---------------- Actions ----------------
async function call() {
  const c = state.carrier;
  const phone = c?.phone || state.focus?.phone;
  if (!phone || c?.doNotCall) return;
  $('call').disabled = true;
  showMessage('');
  try {
    const res = await dial(c ? { carrierId: c.id } : { phone });
    state.attemptId = res.attempt?.id || null;
    $('call-status').textContent = res.message;
  } catch (err) {
    showMessage(err.message, 'error');
  } finally {
    $('call').disabled = false;
  }
}

async function save() {
  const c = state.carrier;
  if (!c || !state.outcome || state.saving) return;
  state.saving = true;
  renderOutcomes();
  const tz = tzOf(c);
  const f = followUp.value();
  const at = f === 'tomorrow' ? localNineAm(tz, 1) : f === 'week' ? localNineAm(tz, 7) : f === 'pick' && $('followup-at').value ? new Date($('followup-at').value) : null;
  try {
    const res = await api('POST', '/api/calls', {
      carrierId: c.id, outcome: state.outcome, notes: $('notes').value.trim() || null,
      attemptId: state.attemptId || undefined, followUpAt: at ? at.toISOString() : null, autoFollowUp: f !== 'none',
    });
    showMessage(`${c.companyName}: ${label(state.outcome)}${res.followUp ? ` · follow-up ${new Date(res.followUp.dueAt).toLocaleString()}` : ''}`, 'ok');
    state.saving = false;
    await nextCarrier();
  } catch (err) {
    state.saving = false;
    renderOutcomes();
    showMessage(err.message, 'error');
  }
}

async function sendEmail() {
  const c = state.carrier;
  const templateId = templates.value();
  if (!c) return;
  if (!templateId) { showMessage('Choose a template first', 'error'); return; }
  $('send-email').disabled = true;
  try {
    const res = await api('POST', '/api/email/messages', { carrierId: c.id, templateId, mode: 'send' });
    showMessage(res.outcome === 'sent' ? `Email sent to ${c.email}` : res.message, res.outcome === 'sent' ? 'ok' : 'info');
  } catch (err) {
    if (/mailbox/i.test(err.message)) {
      const { appUrl } = await getConfig();
      showMessage(`${err.message}. Opening DispatchDesk…`, 'error');
      chrome.tabs.create({ url: `${appUrl}/app/email?tab=mailboxes` });
    } else showMessage(err.message, 'error');
  } finally {
    $('send-email').disabled = false;
  }
}

// ---------------- Init ----------------
async function init() {
  $('template-slot').append(templates.el);
  $('followup').append(followUp.el);
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('call').addEventListener('click', call);
  $('save').addEventListener('click', save);
  $('skip').addEventListener('click', () => { showMessage(''); nextCarrier(); });
  $('send-email').addEventListener('click', sendEmail);
  $('reload').addEventListener('click', async () => { state.index = 0; await loadQueue().catch((e) => showMessage(e.message, 'error')); await showQueueItem(); });
  $('open-dialer').addEventListener('click', async () => { const { appUrl } = await getConfig(); chrome.tabs.create({ url: `${appUrl}/app/dialer` }); });
  $('script-toggle').addEventListener('click', () => {
    const collapsed = $('script').classList.toggle('collapsed');
    $('script-toggle').textContent = collapsed ? 'Show all' : 'Show less';
  });
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.closest?.('.dd');
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-8]$/.test(e.key) && state.carrier) setOutcome(CALL_OUTCOMES[Number(e.key) - 1]);
    else if (e.key.toLowerCase() === 'c') call();
    else if (e.key.toLowerCase() === 's') nextCarrier();
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.panelFocus?.newValue) applyFocus(changes.panelFocus.newValue);
  });

  const { appUrl, token } = await getConfig();
  if (!appUrl || !token) {
    $('status').textContent = 'Not connected';
    $('status').dataset.tone = 'warn';
    $('setup').hidden = false;
    return;
  }
  try {
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
    $('status').textContent = me.user.name;
    $('status').dataset.tone = 'ok';
  } catch (err) {
    $('status').textContent = 'Connection problem';
    $('status').dataset.tone = 'warn';
    showMessage(err.message, 'error');
    return;
  }
  $('main').hidden = false;
  const [scripts, tmpl] = await Promise.all([
    api('GET', '/api/call-scripts').catch(() => ({ items: [] })),
    api('GET', '/api/email/templates').catch(() => ({ items: [] })),
  ]);
  state.scripts = scripts.items || [];
  templates.setOptions((tmpl.items || []).map((t) => ({ value: t.id, label: t.name })));
  await loadQueue().catch((e) => showMessage(e.message, 'error'));
  const { panelFocus } = await chrome.storage.session.get('panelFocus');
  if (panelFocus && Date.now() - panelFocus.at < 30 * 60000) await applyFocus(panelFocus);
  else await showQueueItem();
  setInterval(() => { if (state.carrier) { const i = localInfo(tzOf(state.carrier)); $('c-time').textContent = i.time; $('c-window').textContent = i.text; } }, 30000);
}

init();
