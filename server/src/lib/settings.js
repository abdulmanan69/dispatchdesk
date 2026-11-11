import { prisma } from '../db.js';
import { config } from '../config.js';
import { encrypt, decrypt } from './crypto.js';
import { broadcast, onBroadcast } from './broadcast.js';

/**
 * System settings: DB values (set by admins) override environment defaults.
 * Secret values are AES-GCM encrypted at rest and never returned to clients in plain text.
 */
export const SETTING_DEFS = {
  'app.name': { group: 'app', default: () => 'DispatchDesk' },
  'app.registrationOpen': { group: 'app', type: 'bool', default: () => 'true' },
  'app.requireEmailVerification': { group: 'app', type: 'bool', default: () => 'false' },
  'ai.baseUrl': { group: 'ai', default: () => config.ai.baseUrl },
  'ai.apiKey': { group: 'ai', secret: true, default: () => config.ai.apiKey },
  'ai.model': { group: 'ai', default: () => config.ai.model },
  'ai.embeddingModel': { group: 'ai', default: () => config.ai.embeddingModel },
  'search.provider': { group: 'ai', default: () => config.search.provider }, // tavily | brave | ''
  'search.apiKey': { group: 'ai', secret: true, default: () => config.search.apiKey },
  'smtp.host': { group: 'email', default: () => config.smtp.host || '' },
  'smtp.port': { group: 'email', default: () => String(config.smtp.port || 587) },
  'smtp.secure': { group: 'email', type: 'bool', default: () => String(!!config.smtp.secure) },
  'smtp.user': { group: 'email', default: () => config.smtp.user || '' },
  'smtp.pass': { group: 'email', secret: true, default: () => config.smtp.pass || '' },
  'smtp.from': { group: 'email', default: () => config.smtp.from || '' },
  // Platform mail budget per UTC day (verification, password reset, digests). services/email/system.js keeps a share
  // of it for verification and reset mail.
  'smtp.dailyLimit': { group: 'email', default: () => process.env.PLATFORM_MAIL_DAILY_LIMIT || '300' },
  'google.clientId': { group: 'integrations', default: () => config.google.clientId },
  'google.clientSecret': { group: 'integrations', secret: true, default: () => config.google.clientSecret },
  'microsoft.clientId': { group: 'integrations', default: () => config.microsoft.clientId },
  'microsoft.clientSecret': { group: 'integrations', secret: true, default: () => config.microsoft.clientSecret },
  'microsoft.tenant': { group: 'integrations', default: () => config.microsoft.tenant },
  'fmcsa.webKey': { group: 'integrations', secret: true, default: () => config.fmcsa.webKey },
  'fmcsa.socrataAppToken': { group: 'integrations', secret: true, default: () => config.fmcsa.socrataAppToken },
  'eia.apiKey': { group: 'integrations', secret: true, default: () => process.env.EIA_API_KEY || '' },
  'fred.apiKey': { group: 'integrations', secret: true, default: () => process.env.FRED_API_KEY || '' },
  'usda.marsApiKey': { group: 'integrations', secret: true, default: () => process.env.USDA_MARS_API_KEY || '' },
  'stripe.secretKey': { group: 'billing', secret: true, default: () => config.stripe.secretKey },
  'stripe.webhookSecret': { group: 'billing', secret: true, default: () => config.stripe.webhookSecret },
};

let cache = null;
let cacheAt = 0;

// The SystemSetting table also holds rows that grow with the number of users and are always read by key elsewhere:
// per-user data (user.<id>.*), cross-process locks (lock.*), job status, push keys and Stripe event markers.
// They are never platform settings, so the 5 s cache loads only the defined keys (a primary-key lookup).
const SETTING_KEYS = Object.keys(SETTING_DEFS);

async function load() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: SETTING_KEYS } } });
  cache = new Map(rows.map((r) => [r.key, r]));
  cacheAt = Date.now();
  return cache;
}

onBroadcast('settings', () => { cache = null; });
/** Settings changed: drop the 5 s cache in every process. */
export function invalidateSettings() { broadcast('settings'); }

export async function getSetting(key) {
  const def = SETTING_DEFS[key];
  const rows = await load();
  const row = rows.get(key);
  if (row && row.value !== '') {
    try { return row.secret ? decrypt(row.value) : row.value; } catch { return ''; }
  }
  return def?.default ? def.default() ?? '' : '';
}

export async function getBool(key) { return (await getSetting(key)) === 'true'; }

export async function getSettings(keys) {
  const out = {};
  for (const k of keys) out[k] = await getSetting(k);
  return out;
}

/** Public-safe listing for the admin UI: secrets are masked. */
export async function listSettingsForAdmin() {
  const rows = await load();
  const out = [];
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    const row = rows.get(key);
    const value = await getSetting(key);
    out.push({
      key, group: def.group, type: def.type || 'string', secret: !!def.secret,
      value: def.secret ? '' : value,
      isSet: !!value,
      source: row && row.value !== '' ? 'database' : value ? 'environment' : 'unset',
      preview: def.secret && value ? `••••${String(value).slice(-4)}` : undefined,
    });
  }
  return out;
}

export async function setSetting(key, value, userId) {
  const def = SETTING_DEFS[key];
  if (!def) throw new Error(`Unknown setting ${key}`);
  const str = value == null ? '' : String(value);
  const stored = def.secret && str ? encrypt(str) : str;
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: stored, secret: !!def.secret, updatedById: userId },
    update: { value: stored, secret: !!def.secret, updatedById: userId },
  });
  invalidateSettings();
}
