/**
 * USDT on the TRON chain (TRC20), read through TronGrid's public API: the confirmed USDT transfers into a wallet.
 * Only the official USDT contract counts; look-alike tokens with the same name are ignored.
 */
export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const API = 'https://api.trongrid.io';
const ADDRESS = /\b(T[1-9A-HJ-NP-Za-km-z]{33})\b/;

let fetchImpl = (...a) => globalThis.fetch(...a);
/** Tests replace the network. */
export function __setTronFetch(f) { fetchImpl = f || ((...a) => globalThis.fetch(...a)); }

/** The TRON wallet address in a block of payment details, or null. */
export function tronAddress(text) {
  const m = String(text || '').match(ADDRESS);
  return m ? m[1] : null;
}

/** "9990317" micro-USDT → "9.990317". */
export const formatMicros = (micros) => {
  const s = String(micros).padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
};

/**
 * Confirmed USDT transfers into `address` since `since` (newest first, at most `maxPages` pages of 200):
 * [{ txId, from, to, value (micro-USDT as a string), at (ms) }].
 */
export async function incomingUsdt(address, { since, apiKey, maxPages = 5 } = {}) {
  const out = [];
  let fingerprint = null;
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({
      only_to: 'true', only_confirmed: 'true', contract_address: USDT_TRC20, limit: '200', order_by: 'block_timestamp,desc',
      ...(since ? { min_timestamp: String(new Date(since).getTime()) } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    });
    const res = await fetchImpl(`${API}/v1/accounts/${address}/transactions/trc20?${q}`, {
      headers: { Accept: 'application/json', ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`TronGrid answered ${res.status}`);
    const body = await res.json();
    if (body?.success === false) throw new Error(`TronGrid: ${body.error || 'request failed'}`);
    for (const t of body?.data || []) {
      if (t?.type !== 'Transfer' || t?.to !== address) continue;
      if (t?.token_info?.address !== USDT_TRC20 || Number(t?.token_info?.decimals) !== 6) continue; // fake "USDT" tokens
      if (!/^\d+$/.test(String(t.value)) || !/^[0-9a-f]{64}$/i.test(String(t.transaction_id))) continue;
      out.push({ txId: String(t.transaction_id).toLowerCase(), from: t.from, to: t.to, value: String(BigInt(t.value)), at: Number(t.block_timestamp) });
    }
    fingerprint = body?.meta?.fingerprint;
    if (!fingerprint) break;
  }
  return out;
}
