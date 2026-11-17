import { getAccessToken } from './oauth.js';

/**
 * Inbox access through Microsoft Graph for Outlook mailboxes connected with Microsoft sign-in, used by reply and bounce
 * detection (imap.js, pollOutlookMailbox). Needs the delegated Mail.Read permission, which the user grants when they
 * turn detection on. Read-only: it lists inbox messages and downloads one message's MIME source when needed. Nothing is
 * marked read, moved or sent.
 */
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,subject,from,receivedDateTime,internetMessageId,internetMessageHeaders';
const PAGE = 50;

// Graph wants "$select=a,b" with spaces as %20 (URLSearchParams would write "%24select" and "+").
const query = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/** A Graph failure. `authenticationFailed` marks problems only the user can fix (reconnect, allow reading mail). */
function graphFailure(status, data) {
  const code = String(data?.error?.code || '');
  const detail = String(data?.error?.message || '').split('\n')[0].slice(0, 200);
  const noMailbox = code === 'MailboxNotEnabledForRESTAPI' || /mailbox is either inactive|soft-deleted|hosted on-premise/i.test(detail);
  let message;
  if (noMailbox) message = 'This Microsoft account has no Outlook mailbox, so there is no inbox to check. Connect the mailbox where your mail arrives.';
  else if (status === 401) message = 'Microsoft sign-in expired. Reconnect this mailbox.';
  else if (status === 403 || code === 'ErrorAccessDenied') message = 'DispatchDesk is not allowed to read this mailbox yet. Turn on reply detection again and allow reading mail.';
  else message = `Microsoft Graph error ${status}${detail ? `: ${detail}` : ''}`;
  return Object.assign(new Error(message), { status, code, authenticationFailed: noMailbox || status === 401 || status === 403 });
}

async function token(account) {
  try {
    return await getAccessToken(account);
  } catch (err) {
    // A refused refresh token (revoked, password changed, consent removed) needs the user; a network error does not.
    if (/^Token request failed|authorization expired/i.test(err.message)) {
      throw Object.assign(new Error(`Microsoft sign-in expired. Reconnect this mailbox. (${err.message.slice(0, 160)})`), { authenticationFailed: true });
    }
    throw err;
  }
}

async function get(account, path, fetchImpl, timeoutMs = 20000) {
  const t = await token(account);
  const res = await fetchImpl(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw graphFailure(res.status, await res.json().catch(() => ({})));
  return res;
}

const isoSeconds = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Inbox messages, oldest first.
 * - `since` null (first check): the newest `lookback` messages.
 * - else: messages received after `since` (epoch seconds), at most `limit`; `more` says whether others are waiting.
 */
export async function listInboxMessages(account, { since = null, limit = 150, lookback = 50, fetchImpl = globalThis.fetch } = {}) {
  if (since == null) {
    const res = await get(account, `/me/mailFolders/inbox/messages?${query({ $select: SELECT, $orderby: 'receivedDateTime desc', $top: lookback })}`, fetchImpl);
    const data = await res.json();
    return { messages: (data.value || []).reverse(), more: false };
  }
  let url = `/me/mailFolders/inbox/messages?${query({
    $select: SELECT, $filter: `receivedDateTime gt ${isoSeconds(since)}`, $orderby: 'receivedDateTime asc', $top: Math.min(PAGE, limit),
  })}`;
  const messages = [];
  while (url && messages.length < limit) {
    const data = await (await get(account, url, fetchImpl)).json();
    messages.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return { messages: messages.slice(0, limit), more: !!url || messages.length > limit };
}

/** The MIME source of one message, cut at `maxBytes` (enough for the text of a reply or a bounce report). */
export async function messageSource(account, id, { maxBytes = 256 * 1024, fetchImpl = globalThis.fetch } = {}) {
  const res = await get(account, `/me/messages/${encodeURIComponent(id)}/$value`, fetchImpl, 30000);
  if (!res.body?.getReader) return Buffer.from(await res.arrayBuffer()).subarray(0, maxBytes);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/** "Test connection" for an Outlook sign-in mailbox: open the inbox through Graph. Returns { ok, message }. */
export async function testOutlookInbox(account, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const box = await (await get(account, `/me/mailFolders/inbox?${query({ $select: 'totalItemCount' })}`, fetchImpl)).json();
    return { ok: true, message: `Signed in through Microsoft. The inbox has ${box.totalItemCount ?? 0} messages.` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
