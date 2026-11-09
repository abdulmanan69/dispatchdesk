// Loaded before every test file (before any app module is imported).
// globalSetup picks a per-run directory (DD_TEST_DIR) so concurrent runs don't share a database.
import path from 'node:path';

const dir = process.env.DD_TEST_DIR || path.resolve('./data/test');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dir;
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.APP_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.APP_URL = 'http://localhost:3999';
process.env.RATE_LIMIT_DISABLED = 'true';
// External integrations are deliberately unconfigured in tests.
for (const k of ['AI_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SMTP_HOST', 'SEARCH_API_KEY', 'SEARCH_PROVIDER', 'FMCSA_WEBKEY', 'GOOGLE_CLIENT_ID', 'MICROSOFT_CLIENT_ID', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) delete process.env[k];
