import https from 'node:https';
import { resolvePublicHost } from '../../../lib/netguard.js';
import { badRequest, HttpError } from '../../../lib/errors.js';

/**
 * fetch() for AI provider URLs that a USER typed in (bring your own key, OpenAI-compatible base URL).
 *
 * - https only, no user:password@ in the URL.
 * - The host name is resolved ONCE through lib/netguard.js (public unicast addresses only) and the connection is made to
 *   that vetted address, with the name kept for the Host header and TLS certificate check. Connecting by name would
 *   resolve it again and let a short-TTL record point the request at this server or the private network.
 * - Redirects are not followed (a redirect could point anywhere).
 * - The response body is capped, and the request has a timeout.
 *
 * Returns a standard Response. Admin-configured platform URLs keep using the global fetch.
 */
const MAX_BYTES = 5 * 1024 * 1024;

export async function checkPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw badRequest('Enter a valid base URL, for example https://api.openai.com/v1'); }
  if (u.protocol !== 'https:') throw badRequest('The base URL must start with https://');
  if (u.username || u.password) throw badRequest('Remove the user name and password from the base URL');
  try {
    const target = await resolvePublicHost(u.hostname, { label: 'AI provider' });
    return { url: u, target };
  } catch (err) {
    if (err instanceof HttpError) throw badRequest(`${u.hostname} is not a public internet server. Use your AI provider's public API address.`);
    throw err;
  }
}

export async function guardedFetch(rawUrl, { method = 'POST', headers = {}, body, timeoutMs = 90_000, maxBytes = MAX_BYTES } = {}) {
  const { url, target } = await checkPublicHttpsUrl(rawUrl);
  const payload = body == null ? null : Buffer.from(String(body));
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: 'https:',
      hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
      // Always connect to the vetted address; the name still goes in Host and SNI.
      lookup: (_host, opts, cb) => (opts?.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family)),
      ...(target.servername ? { servername: target.servername } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(new Error('The AI provider sent too much data')); return; }
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode || 502;
        try {
          const noBody = [101, 204, 205, 304].includes(status);
          resolve(new Response(noBody ? null : Buffer.concat(chunks), {
            status: status >= 200 && status <= 599 ? status : 502,
            headers: { 'content-type': String(res.headers['content-type'] || '') },
          }));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', (err) => reject(err?.name === 'AbortError' || err?.name === 'TimeoutError' ? new Error(`timed out after ${Math.round(timeoutMs / 1000)} seconds`) : err));
    if (payload) req.write(payload);
    req.end();
  });
}
