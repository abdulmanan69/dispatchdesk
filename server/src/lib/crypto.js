import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY = crypto.createHash('sha256').update(`enc:${config.secret}`).digest();

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
export const hmac = (v) => crypto.createHmac('sha256', config.secret).update(String(v)).digest('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext> (base64url parts). */
export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [v, iv, tag, data] = String(payload).split('.');
  if (v !== 'v1') throw new Error('Unsupported ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** Signed, expiring token for stateless links (unsubscribe, OAuth state). */
export function signPayload(obj, ttlSeconds = 3600 * 24 * 365) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

export function verifyPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (obj.exp && obj.exp < Date.now() / 1000) return null;
    return obj;
  } catch {
    return null;
  }
}
