# DispatchDesk Clicker (browser extension)

Calls carriers through your DispatchDesk calling provider, works your call queue from a side panel, tiles DispatchDesk next to Google Voice, and adds USDOT/MC numbers to your CRM from any web page. It's a Manifest V3 extension for Chrome and Edge (version 116 or later), with no build step and no remote code.

Version 1.1.0.

## Install

1. In DispatchDesk, open **Browser extension** and click **Download extension**. The zip already points at your server (`config.json`).
2. Unzip it.
3. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge) and turn on **Developer mode**.
4. Click **Load unpacked** and pick the unzipped `dispatchdesk-clicker-<version>` folder.
5. The settings page opens. Paste a personal access token (create one on the same DispatchDesk page) and click **Save and test**. Allow access to your DispatchDesk site when the browser asks.

To install from this repository instead, load the `extension/` folder and type your app URL on the settings page.

To update, download the new zip, replace the folder, and click the reload icon on the extension's card in `chrome://extensions`.

## Use

### Workspace

**Open workspace** in the popup, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>, tiles two windows on the screen the browser is on:

- **Left:** the DispatchDesk power dialer.
- **Right:** your calling app, when it runs in the browser:
  - **Google Voice:** `voice.google.com/u/0/calls`.
  - **Microsoft Teams:** the Teams web app.
  - **Desktop apps** (8x8, RingCentral, Dialpad, Zoom Phone, phone app): no right window opens, because the desktop app takes the call.

Pressing it again re-tiles and focuses the same windows instead of opening new ones. Calls placed from the extension open in the right-hand window. Choose a 50/50 or 60/40 split on the settings page. Change the shortcut at `chrome://extensions/shortcuts`.

### Call panel (side panel)

Open it with **Call panel** in the popup. It also opens by itself when you call from a page or the right-click menu. It shows:

- **Carrier:** the current carrier from today's call queue, or the one you just called from a web page. Its name, MC/DOT, location, local time and calling window are shown.
- **Script:** the first lines of your call script, with merge fields filled in.
- **Call:** dials through your provider. Google Voice loads in your already-open, signed-in Voice tab for the account chosen in Options (u/0, u/1, …), or in the workspace window, or in one reused tab. You still press Call in Google Voice.
- **Outcome:** buttons for the ten outcomes, also on keys <kbd>1</kbd>–<kbd>9</kbd> and <kbd>0</kbd>, plus notes. **Wrong number** (<kbd>9</kbd>) schedules no call-back. **Do not call** (<kbd>0</kbd>) turns on do-not-call for the carrier and stops its sequences.
- **Follow-up:** Automatic, Tomorrow 9 AM (carrier's local time), Next week, Pick a time, or None. **Save and next** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) logs the call with its attempt, so the provider and duration are kept, then moves on.
- **Send email:** sends a saved template through your connected mailbox. Without a mailbox, it opens Email → Mailboxes in the app.
- **Skip** (<kbd>S</kbd>) moves to the next carrier.

### Page scan and right-click

- **Toolbar button:** lists the phone, USDOT and MC numbers on the current page.
  - **Call** places the call with the provider you chose in DispatchDesk and opens the call panel for that carrier, so logging the outcome is one click.
  - **Find** opens the carrier if it's already in your CRM.
  - **Add to CRM** fetches the record from the FMCSA census and saves it to your carrier list.
- **Right-click selected text:** call it (opens the call panel too), or look up a USDOT/MC number.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Read the current page only when you click the toolbar button |
| `storage` | Your app URL, token and workspace preferences |
| `contextMenus`, `notifications` | Right-click call and lookup |
| `sidePanel` | The call panel |
| `system.display` | Screen size, to tile the workspace windows |

## Privacy and security

- **Page access:** pages are read only when you click the toolbar button (`activeTab`). There are no content scripts on websites.
- **Token:** stored in `chrome.storage.local` in this browser only.
  - It can't open admin, settings, billing, team, token or account-security endpoints.
  - Revoke it any time in DispatchDesk.
- **Network:** the extension only talks to the DispatchDesk server you connected.
- **Calls:** a call is placed only after you click. The extension never dials by itself, and texts are never sent by it.
