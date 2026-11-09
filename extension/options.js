import { getConfig, chips } from './lib.js';

const $ = (id) => document.getElementById(id);

function show(text, tone) {
  const el = $('result');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = !text;
}

async function init() {
  const { split = '50' } = await chrome.storage.local.get('split');
  const control = chips({
    ariaLabel: 'Workspace split', value: split,
    options: [{ value: '50', label: '50 / 50' }, { value: '60', label: '60 / 40' }],
    onChange: async (v) => { await chrome.storage.local.set({ split: v }); $('split-result').textContent = v === '60' ? 'DispatchDesk gets 60% of the screen.' : 'Both windows get half the screen.'; },
  });
  $('split-slot').append(control.el);
  const { gvAccount = '0' } = await chrome.storage.local.get('gvAccount');
  const gv = chips({
    ariaLabel: 'Google Voice account', value: gvAccount,
    options: ['0', '1', '2', '3'].map((n) => ({ value: n, label: `Account ${Number(n) + 1} (u/${n})` })),
    onChange: async (v) => { await chrome.storage.local.set({ gvAccount: v }); },
  });
  $('gv-slot').append(gv.el);
  const { appUrl, token } = await getConfig();
  $('appUrl').value = appUrl;
  $('token').value = token;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  show('');
  let origin;
  try {
    origin = new URL($('appUrl').value.trim()).origin;
  } catch {
    return show('Enter a valid URL, for example https://dispatch.example.com', 'error');
  }
  const token = $('token').value.trim();
  if (!token.startsWith('ddk_')) return show('Tokens start with ddk_. Create one in DispatchDesk under Browser extension.', 'error');

  // Host permission for this one origin, requested from this click (user gesture).
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  if (!granted) return show(`Permission to reach ${origin} was not granted`, 'error');

  $('save').disabled = true;
  try {
    const res = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.user) throw new Error(data?.error || `The server answered ${res.status}`);
    await chrome.storage.local.set({ appUrl: origin, token });
    show(`Connected as ${data.user.name} (${data.user.email})`, 'ok');
  } catch (err) {
    show(`Could not connect: ${err.message}`, 'error');
  } finally {
    $('save').disabled = false;
  }
});

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove(['token']);
  $('token').value = '';
  show('Disconnected. The token is removed from this browser; revoke it in the app too.', 'info');
});

init();
