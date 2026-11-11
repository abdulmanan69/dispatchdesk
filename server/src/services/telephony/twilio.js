import crypto from 'node:crypto';

/**
 * Minimal Twilio REST client (fetch + Basic auth, no SDK).
 * https://www.twilio.com/docs/voice/api/call-resource
 */
const API = 'https://api.twilio.com/2010-04-01';

function authHeader(sid, token) {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

// A slow Twilio response must not hold a request (or the dialer) open indefinitely.
const TIMEOUT_MS = 15_000;

async function request(method, path, sid, token, form) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: authHeader(sid, token), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach Twilio: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ? `Twilio: ${data.message}` : `Twilio returned HTTP ${res.status}`);
  return data;
}

const xmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** TwiML executed on the dispatcher's leg once they answer: announce, then dial the carrier. */
export function bridgeTwiml({ company, callerId, carrierE164, actionUrl }) {
  return `<Response><Say>Connecting you to ${xmlEscape(company || 'the carrier')}.</Say><Dial callerId="${xmlEscape(callerId)}" action="${xmlEscape(actionUrl)}" timeout="25">${xmlEscape(carrierE164)}</Dial></Response>`;
}

export async function createBridgeCall({ sid, token, to, from, twiml, statusCallback }) {
  const form = {
    To: to, From: from, Twiml: twiml,
    StatusCallback: statusCallback, StatusCallbackMethod: 'POST',
  };
  const params = new URLSearchParams(form);
  for (const ev of ['initiated', 'ringing', 'answered', 'completed']) params.append('StatusCallbackEvent', ev);
  let res;
  try {
    res = await fetch(`${API}/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: authHeader(sid, token), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach Twilio: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ? `Twilio: ${data.message}` : `Twilio returned HTTP ${res.status}`);
  return data; // { sid, status, ... }
}

export function fetchAccount({ sid, token }) {
  return request('GET', `/Accounts/${encodeURIComponent(sid)}.json`, sid, token);
}

/** Cancel a queued/ringing call, or hang up one in progress. */
export function endCall({ sid, token, callSid, inProgress }) {
  return request('POST', `/Accounts/${encodeURIComponent(sid)}/Calls/${encodeURIComponent(callSid)}.json`, sid, token, { Status: inProgress ? 'completed' : 'canceled' });
}

/**
 * Validate X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + concatenated sorted POST params)).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function computeSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((acc, k) => {
    const v = params[k];
    return acc + (Array.isArray(v) ? v.map((x) => k + x).join('') : k + v);
  }, url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifySignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(computeSignature(authToken, url, params));
  const got = Buffer.from(String(signature));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/** Map Twilio statuses onto CallAttempt.status. */
export const PARENT_STATUS = { queued: 'queued', initiated: 'queued', ringing: 'ringing', 'in-progress': 'in_progress' };
export const DIAL_STATUS = { completed: 'completed', answered: 'completed', 'no-answer': 'no_answer', busy: 'busy', failed: 'failed', canceled: 'canceled' };
