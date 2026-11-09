import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Persist a generated secret on the data volume when APP_SECRET is not supplied,
// so sessions and encrypted credentials survive container restarts.
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  const file = path.join(DATA_DIR, '.app_secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const isTest = env.NODE_ENV === 'test';
const port = Number(env.PORT || 3000);

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  isTest,
  port,
  appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: DATA_DIR,
  uploadDir: path.join(DATA_DIR, 'uploads'),
  databaseUrl: env.DATABASE_URL || `file:${path.join(DATA_DIR, 'app.db')}`,
  secret: loadSecret(),
  sessionDays: Number(env.SESSION_DAYS || 14),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : (env.APP_URL || '').startsWith('https'),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 15),
  // Local development / automated tests only: return verification & reset tokens in API responses.
  exposeDevTokens: env.EXPOSE_DEV_TOKENS === 'true' || isTest,
  disableScheduler: env.DISABLE_SCHEDULER === 'true' || isTest,
  rateLimitDisabled: env.RATE_LIMIT_DISABLED === 'true',
  admin: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, name: env.ADMIN_NAME || 'Administrator' },
  smtp: {
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM,
  },
  ai: {
    baseUrl: (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: env.AI_API_KEY || env.OPENAI_API_KEY || '',
    model: env.AI_MODEL || 'gpt-4o-mini',
    embeddingModel: env.AI_EMBEDDING_MODEL || '',
  },
  search: { provider: env.SEARCH_PROVIDER || '', apiKey: env.SEARCH_API_KEY || '' },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
  microsoft: { clientId: env.MICROSOFT_CLIENT_ID || '', clientSecret: env.MICROSOFT_CLIENT_SECRET || '', tenant: env.MICROSOFT_TENANT || 'common' },
  fmcsa: {
    webKey: env.FMCSA_WEBKEY || '',
    socrataAppToken: env.SOCRATA_APP_TOKEN || '',
    censusUrl: env.FMCSA_CENSUS_URL || 'https://data.transportation.gov/resource/az4n-8mr2.json',
  },
};

fs.mkdirSync(config.uploadDir, { recursive: true });
