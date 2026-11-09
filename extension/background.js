// Service worker: context menus, the workspace layout and side-panel hand-off.
// All network calls use the personal access token from storage. Nothing dials without a click.
import { api, dial, focusPanel, getConfig, usPhone, prettyPhone, googleVoiceUrl, findVoiceTab } from './lib.js';

const MENU_CALL = 'dd-call';
const MENU_LOOKUP = 'dd-lookup';

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_CALL, title: 'Call “%s” with DispatchDesk', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_LOOKUP, title: 'Look up carrier “%s” in DispatchDesk', contexts: ['selection'] });
  });
  // The toolbar button keeps its popup; the side panel opens from the popup, a call, or the browser's side panel menu.
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: String(message).slice(0, 240) });
}

/** Pull a USDOT or MC number out of free text. */
export function parseIdentifier(text) {
  const t = String(text || '');
  const mc = t.match(/\bMC\s*[-#:]?\s*(\d{4,8})\b/i);
  if (mc) return { type: 'mc', value: mc[1] };
  const dot = t.match(/\b(?:US\s*)?DOT\b[^\d]{0,12}(\d{4,8})\b/i);
  if (dot) return { type: 'dot', value: dot[1] };
  const bare = t.replace(/\D/g, '');
  if (bare.length >= 5 && bare.length <= 8) return { type: 'dot', value: bare };
  return null;
}

// ---------------------------------------------------------------------------
// Workspace: DispatchDesk on the left, the calling app on the right.
// ---------------------------------------------------------------------------

/** Providers whose calls happen in a browser tab; everything else is handled by a desktop app via tel:/app links. */
const WEB_DIALERS = {
  google_voice: { label: 'Google Voice', url: 'https://voice.google.com/u/0/calls' },
  teams: { label: 'Microsoft Teams', url: 'https://teams.microsoft.com/' },
};

async function windowAlive(id) {
  if (id == null) return false;
  try { await chrome.windows.get(id); return true; } catch { return false; }
}

async function workArea(nearWindowId) {
  const displays = await chrome.system.display.getInfo();
  let d = displays.find((x) => x.isPrimary) || displays[0];
  if (nearWindowId != null) {
    try {
      const w = await chrome.windows.get(nearWindowId);
      const cx = w.left + w.width / 2;
      const cy = w.top + w.height / 2;
      d = displays.find((x) => cx >= x.workArea.left && cx < x.workArea.left + x.workArea.width && cy >= x.workArea.top && cy < x.workArea.top + x.workArea.height) || d;
    } catch { /* use primary */ }
  }
  return d.workArea;
}

/** Open (or re-tile and focus) the two-window workspace. Returns a status message. */
export async function openWorkspace({ sequenceId, sourceWindowId } = {}) {
  const { appUrl } = await getConfig();
  if (!appUrl) throw new Error('Not connected. Open the extension options first.');
  const { split = '50' } = await chrome.storage.local.get('split');
  const { workspace = {} } = await chrome.storage.session.get('workspace');
  let provider = 'tel';
  try { provider = (await api('GET', '/api/telephony/settings')).settings.provider || 'tel'; } catch { /* keep default */ }
  const web = WEB_DIALERS[provider];

  const area = await workArea(sourceWindowId ?? workspace.leftWindowId);
  const ratio = split === '60' ? 0.6 : 0.5;
  const leftWidth = web ? Math.round(area.width * ratio) : area.width;
  const left = { left: area.left, top: area.top, width: leftWidth, height: area.height, state: 'normal' };
  const right = { left: area.left + leftWidth, top: area.top, width: area.width - leftWidth, height: area.height, state: 'normal' };
  const dialerUrl = `${appUrl}/app/dialer${sequenceId ? `?sequenceId=${encodeURIComponent(sequenceId)}` : ''}`;

  const next = { ...workspace, provider };
  if (await windowAlive(workspace.leftWindowId)) {
    await chrome.windows.update(workspace.leftWindowId, left);
    if (sequenceId && workspace.leftTabId != null) await chrome.tabs.update(workspace.leftTabId, { url: dialerUrl }).catch(() => {});
  } else {
    const w = await chrome.windows.create({ url: dialerUrl, type: 'normal', ...left, state: undefined });
    next.leftWindowId = w.id;
    next.leftTabId = w.tabs?.[0]?.id ?? null;
  }

  if (web) {
    if (await windowAlive(workspace.rightWindowId)) {
      await chrome.windows.update(workspace.rightWindowId, { ...right, focused: true });
    } else {
      // Google Voice: move the already signed-in Voice tab into the right window instead of opening a second one.
      const voiceUrl = /voice\.google\.com/.test(web.url) ? await googleVoiceUrl(web.url) : null;
      const existing = voiceUrl ? await findVoiceTab(voiceUrl) : null;
      const w = existing
        ? await chrome.windows.create({ tabId: existing.id, type: 'normal', ...right, state: undefined })
        : await chrome.windows.create({ url: voiceUrl || web.url, type: 'normal', ...right, state: undefined });
      next.rightWindowId = w.id;
      next.rightTabId = w.tabs?.[0]?.id ?? null;
    }
  } else if (await windowAlive(workspace.rightWindowId)) {
    await chrome.windows.remove(workspace.rightWindowId).catch(() => {});
    next.rightWindowId = null;
    next.rightTabId = null;
  }
  await chrome.windows.update(next.leftWindowId, { focused: true }).catch(() => {});
  await chrome.storage.session.set({ workspace: next });
  return web
    ? `DispatchDesk on the left, ${web.label} on the right. Calls open in the ${web.label} window.`
    : 'DispatchDesk is open. Your calling app is a desktop app, so calls open there instead of a browser window.';
}

chrome.windows.onRemoved.addListener(async (id) => {
  const { workspace } = await chrome.storage.session.get('workspace');
  if (!workspace) return;
  if (id === workspace.leftWindowId) workspace.leftWindowId = null;
  if (id === workspace.rightWindowId) { workspace.rightWindowId = null; workspace.rightTabId = null; }
  await chrome.storage.session.set({ workspace });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'open-workspace') return;
  try { notify('Workspace', await openWorkspace({ sourceWindowId: tab?.windowId })); } catch (err) { notify('DispatchDesk', err.message); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'open-workspace') {
    openWorkspace({ sequenceId: msg.sequenceId, sourceWindowId: msg.windowId }).then((message) => sendResponse({ ok: true, message }), (err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = (info.selectionText || '').trim();
  // Open the side panel first, while the click still counts as a user gesture.
  if (info.menuItemId === MENU_CALL && tab?.windowId != null) chrome.sidePanel?.open({ windowId: tab.windowId }).catch(() => {});
  try {
    if (info.menuItemId === MENU_CALL) {
      const phone = usPhone(text);
      if (!phone) return notify('No phone number', `“${text}” doesn’t look like a US phone number.`);
      const res = await dial({ phone });
      await focusPanel({ carrierId: res.carrier?.id || null, phone, attemptId: res.attempt?.id || null });
      notify(`Calling ${prettyPhone(phone)}`, res.message);
    }
    if (info.menuItemId === MENU_LOOKUP) {
      const id = parseIdentifier(text);
      if (!id) return notify('No USDOT or MC number', 'Select text like “USDOT 1234567” or “MC-123456”.');
      const { appUrl } = await getConfig();
      const found = await api('GET', `/api/carriers?q=${encodeURIComponent(id.value)}&pageSize=1`);
      if (found.items?.length) {
        chrome.tabs.create({ url: `${appUrl}/app/carriers/${found.items[0].id}` });
      } else {
        const params = id.type === 'mc' ? `mc=${id.value}` : `dot=${id.value}`;
        const look = await api('GET', `/api/discovery/lookup?${params}`);
        if (!look.record) return notify('Not found', `${id.type.toUpperCase()} ${id.value} is not in your CRM or the FMCSA census.`);
        notify(look.record.companyName || 'Carrier found', `${id.type.toUpperCase()} ${id.value} is not in your CRM yet. Open the toolbar popup on this page to add it.`);
      }
    }
  } catch (err) {
    notify('DispatchDesk', err.message);
  }
});
