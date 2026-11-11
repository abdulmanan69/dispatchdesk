import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, unavailable } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requirePermission } from '../middleware/auth.js';
import { getSettings, setSetting } from '../lib/settings.js';
import { OAUTH_PROVIDERS, redirectUri } from '../services/email/oauth.js';
import { platformMailStatus } from '../services/email/system.js';
import { getStripe } from '../services/stripe.js';
import { invalidatePlans } from '../lib/plans.js';
import { listBackups, runBackup, backupPath } from '../services/backup.js';
import { JOBS, jobStatuses, runJob } from '../jobs/maintenance.js';

/**
 * Admin setup guide: an ordered checklist computed from the real configuration, plus one-click Stripe provisioning.
 * Nothing here returns secret values; only whether they are set.
 */
const r = Router();

/**
 * Webhook events the billing webhook (routes/billing.js) handles. Keep in sync with its switch statement.
 * invoice.payment_succeeded is not subscribed: it duplicates invoice.paid (the handler still accepts it from older endpoints).
 */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

const KEYS = [
  'smtp.host', 'smtp.port', 'smtp.user', 'smtp.pass', 'smtp.from', 'app.requireEmailVerification', 'app.registrationOpen',
  'stripe.secretKey', 'stripe.webhookSecret',
  'google.clientId', 'google.clientSecret', 'microsoft.clientId', 'microsoft.clientSecret',
  'eia.apiKey', 'fred.apiKey', 'usda.marsApiKey', 'ai.apiKey', 'ai.baseUrl', 'ai.model',
  'search.provider', 'search.apiKey', 'fmcsa.socrataAppToken', 'fmcsa.webKey',
];

const webhookUrl = () => `${config.appUrl}/api/billing/webhook`;
const appHost = () => { try { return new URL(config.appUrl).host; } catch { return ''; } };
/** Mail domain = the From address domain if set, else the app host. */
const mailDomain = (from) => (String(from || '').match(/@([^>\s]+)/)?.[1] || appHost()).toLowerCase();

function item(key, title, status, summary, extra = {}) {
  return { key, title, status, summary, steps: [], values: [], links: [], required: false, ...extra };
}

export async function buildChecklist(req) {
  const s = await getSettings(KEYS);
  const set = (k) => !!s[k];
  const reqHost = req.get('host') || '';
  const https = config.appUrl.startsWith('https://');
  const adminEmail = config.admin.email || req.user.email;
  const items = [];

  // 1. Public address
  const hostMatches = !reqHost || appHost() === reqHost;
  items.push(item('app_url', 'Public address (APP_URL)', https && hostMatches ? 'done' : 'todo',
    https ? (hostMatches ? `Served at ${config.appUrl} over HTTPS.` : `APP_URL is ${config.appUrl} but this page was opened at ${reqHost}. Links in emails and OAuth will use APP_URL.`)
      : `APP_URL is ${config.appUrl}. Email links, Google/Microsoft sign-in, Stripe and Twilio need a public https address.`, {
      required: true,
      steps: [
        'Point a DNS **A record** for your domain at the server IP (DNSExit → Manage DNS → A record).',
        'In Coolify open the app → **Configuration → General**, set the domain to `https://your-domain`, and set the env var `APP_URL` to the same value.',
        'Redeploy. Coolify issues a Let\'s Encrypt certificate automatically once DNS resolves.',
      ],
      values: [{ label: 'APP_URL', value: config.appUrl, copy: true }],
    }));

  // 2. Platform email
  const smtpReady = set('smtp.host') && set('smtp.from');
  const domain = mailDomain(s['smtp.from']);
  // Today's platform mail use (UTC day, all processes): failing sends show here instead of only in the logs.
  const mail = await platformMailStatus().catch(() => null);
  const mailToday = mail && smtpReady
    ? ` Today: ${mail.sent} of ${mail.limit} sent (${mail.reserve} kept for sign-in and reset mail)${mail.refused ? `, ${mail.refused} held back by the daily budget` : ''}${mail.failed ? `, ${mail.failed} failed${mail.lastError ? ` (last error: ${mail.lastError})` : ''}` : ''}.`
    : '';
  items.push(item('platform_email', 'Platform email (verification, password reset, invites)',
    smtpReady ? (set('smtp.user') && set('smtp.pass') && !(mail?.failed && !mail?.sent) ? 'done' : 'partial') : 'todo',
    smtpReady
      ? `Sending as ${s['smtp.from']} through ${s['smtp.host']}. Email verification is ${s['app.requireEmailVerification'] === 'true' ? 'required: unverified accounts can sign in and look around, but cannot make changes until they verify' : 'optional'}.${mailToday}`
      : 'Not configured. Accounts work, but verification, password-reset and team-invite emails cannot be sent (admins can set temporary passwords in Users).', {
      required: true,
      mail,
      testService: 'smtp',
      settingsGroup: 'email',
      steps: [
        '**Pick a provider.** Brevo (free, 300 emails/day): SMTP host `smtp-relay.brevo.com`, port `587`, secure off, login = your Brevo SMTP login, password = an SMTP key (Brevo → SMTP & API → SMTP keys).',
        'Resend (free, 3,000 emails/month): host `smtp.resend.com`, port `465`, secure on, user `resend`, password = your API key.',
        'Gmail / Google Workspace: host `smtp.gmail.com`, port `465`, secure on, user = full address, password = an **app password** (needs 2-Step Verification). About 500 emails/day.',
        'Zoho Mail: `smtp.zoho.com`, `465`, secure on. Hostinger: `smtp.hostinger.com`, `465`, secure on. Use the mailbox address and password.',
        `**Verify your sending domain** with the provider and add its DNS records at your DNS host (DNSExit for ${domain}): the SPF and DMARC records below, and the DKIM record(s) the provider shows you.`,
        'Enter host, port, secure, user, password and the From address (for example `DispatchDesk <no-reply@' + domain + '>`) in **System settings → Email**, then press **Test**.',
        'Optional: turn on **Require email verification** in System settings once a test email arrives.',
      ],
      values: [
        { label: `SPF (TXT on ${domain})`, value: 'v=spf1 include:spf.brevo.com ~all', copy: true, note: 'Brevo. Resend: include:amazonses.com. Gmail: include:_spf.google.com. Zoho: include:zoho.com. Only one SPF record per domain; merge includes.' },
        { label: `DMARC (TXT on _dmarc.${domain})`, value: `v=DMARC1; p=none; rua=mailto:${adminEmail}`, copy: true },
        { label: 'DKIM', value: 'Copy the DKIM record(s) your provider shows after you add the domain', copy: false },
      ],
      links: [
        { label: 'Brevo SMTP keys', url: 'https://app.brevo.com/settings/keys/smtp' },
        { label: 'Resend domains', url: 'https://resend.com/domains' },
        { label: 'Google app passwords', url: 'https://myaccount.google.com/apppasswords' },
      ],
    }));

  // 3. Stripe
  const paid = await prisma.plan.findMany({ where: { active: true, key: { not: 'free' } }, orderBy: { sortOrder: 'asc' } });
  const missingPrices = paid.filter((p) => !p.stripePriceId);
  const stripeKey = set('stripe.secretKey');
  const stripeStatus = !stripeKey ? 'todo' : (set('stripe.webhookSecret') && !missingPrices.length ? 'done' : 'partial');
  items.push(item('stripe', 'Payments (Stripe)', stripeStatus,
    !stripeKey ? 'Not configured. Everyone stays on the Free plan and checkout buttons are disabled.'
      : `${String(s['stripe.secretKey']).startsWith('sk_live') || String(s['stripe.secretKey']).startsWith('rk_live') ? 'Live' : 'Test'} mode key saved.`
        + (set('stripe.webhookSecret') ? ' Webhook secret saved.' : ' Webhook secret missing.')
        + (missingPrices.length ? ` ${missingPrices.length} paid plan(s) have no Stripe price: ${missingPrices.map((p) => p.name).join(', ')}.` : ' All paid plans are linked to Stripe prices.'), {
      required: true,
      testService: 'stripe',
      settingsGroup: 'billing',
      canProvision: stripeKey && https,
      steps: [
        'Create a Stripe account. Start in **Test mode** (toggle top right in the Stripe dashboard).',
        'Copy the **secret key** (`sk_test_…`) from Developers → API keys and save it in **System settings → Billing**.',
        'Press **Create products, prices and webhook** on this card. It creates one product and recurring price per paid plan from the prices in Admin → Plans, links them, and registers the webhook below with its signing secret.',
        'Or do it by hand: create the products and recurring prices in Stripe, paste each `price_…` ID in **Admin → Plans**, add a webhook endpoint with the URL and events below, and save its `whsec_…` signing secret in System settings.',
        'Test a checkout with card `4242 4242 4242 4242`, any future date and any CVC. The subscription activates when the webhook arrives.',
        'To go live: switch Stripe to Live mode, save the live `sk_live_…` key, and press the button again (live mode has separate products, prices and webhooks).',
      ],
      values: [
        { label: 'Webhook URL', value: webhookUrl(), copy: true },
        { label: 'Webhook events', value: STRIPE_WEBHOOK_EVENTS.join(', '), copy: true },
        ...paid.map((p) => ({ label: `${p.name} price ID`, value: p.stripePriceId || 'not linked', copy: !!p.stripePriceId })),
      ],
      links: [
        { label: 'Stripe API keys', url: 'https://dashboard.stripe.com/test/apikeys' },
        { label: 'Stripe webhooks', url: 'https://dashboard.stripe.com/test/webhooks' },
      ],
    }));

  // 4–5. OAuth mailboxes
  for (const [key, prov, label, console] of [
    ['google_oauth', 'gmail', 'Google sign-in for mailboxes (Gmail)', { label: 'Google Cloud credentials', url: 'https://console.cloud.google.com/apis/credentials' }],
    ['microsoft_oauth', 'outlook', 'Microsoft sign-in for mailboxes (Outlook / 365)', { label: 'Microsoft Entra app registrations', url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' }],
  ]) {
    const pre = key === 'google_oauth' ? 'google' : 'microsoft';
    const ok = set(`${pre}.clientId`) && set(`${pre}.clientSecret`);
    items.push(item(key, label, ok ? 'done' : 'optional',
      ok ? 'Client ID and secret saved. Users see one-click Connect in Email → Mailboxes.' : 'Optional. Without it users connect mailboxes with an app password (SMTP).', {
        testService: pre,
        settingsGroup: 'integrations',
        steps: key === 'google_oauth' ? [
          'Google Cloud Console → create a project → **APIs & Services → Enable APIs** → enable **Gmail API**.',
          '**OAuth consent screen**: External, app name, support email, add your domain as an authorized domain, add the scopes below.',
          '**Credentials → Create credentials → OAuth client ID → Web application**, add the redirect URI below.',
          'Paste the client ID and secret in **System settings → Integrations**, press **Test**.',
          'While the app is in "Testing", only listed test users can connect; publish it (Google may ask for verification of the gmail.send scope) for everyone.',
        ] : [
          'Microsoft Entra admin center → **App registrations → New registration**. Supported accounts: any organizational directory and personal Microsoft accounts.',
          'Redirect URI type **Web** = the URI below.',
          '**Certificates & secrets → New client secret**; copy the value (shown once).',
          '**API permissions → Microsoft Graph → Delegated**: the scopes below, then grant consent if your tenant requires it.',
          'Paste client ID (Application ID) and secret in **System settings → Integrations**, press **Test**.',
        ],
        values: [
          { label: 'Redirect URI', value: redirectUri(prov), copy: true },
          ...(prov === 'gmail' ? [{ label: 'Redirect URI for Continue with Google (sign-in)', value: `${config.appUrl}/api/auth/google/callback`, copy: true }] : []),
          { label: 'Scopes', value: OAUTH_PROVIDERS[prov].scope, copy: true },
        ],
        links: [console],
      }));
  }

  // Data sources
  items.push(item('eia', 'Fuel prices (EIA)', set('eia.apiKey') ? 'done' : 'partial',
    set('eia.apiKey') ? 'Using your EIA key.' : 'Working on EIA\'s shared public DEMO_KEY (rate limited). Add your own free key for reliability.', {
      settingsGroup: 'integrations',
      steps: ['Register at eia.gov/opendata (free, instant email).', 'Paste the key in **System settings → Integrations → EIA API key**.'],
      links: [{ label: 'Get an EIA key', url: 'https://www.eia.gov/opendata/register.php' }],
    }));
  items.push(item('fred', 'Truck tonnage index (FRED)', set('fred.apiKey') ? 'done' : 'optional', set('fred.apiKey') ? 'FRED key saved.' : 'Optional free key for the ATA truck tonnage index on the Market page.', {
    settingsGroup: 'integrations',
    steps: ['Create a free account at fred.stlouisfed.org, then **My Account → API keys → Request API key**.', 'Paste it in System settings → Integrations.'],
    links: [{ label: 'FRED API keys', url: 'https://fredaccount.stlouisfed.org/apikeys' }],
  }));
  items.push(item('usda', 'Produce truck rates (USDA MARS)', set('usda.marsApiKey') ? 'done' : 'optional', set('usda.marsApiKey') ? 'USDA key saved.' : 'Optional free key for USDA refrigerated truck rate reports. The weekly PDF link works without it.', {
    settingsGroup: 'integrations',
    steps: ['Request a free MyMarketNews API key at mymarketnews.ams.usda.gov.', 'Paste it in System settings → Integrations.'],
    links: [{ label: 'USDA MyMarketNews API', url: 'https://mymarketnews.ams.usda.gov/mymarketnews-api' }],
  }));
  items.push(item('ai', 'AI dispatcher', set('ai.apiKey') ? 'done' : 'optional', set('ai.apiKey') ? `Using ${s['ai.model'] || 'the configured model'} at ${s['ai.baseUrl'] || 'the configured provider'}.` : 'Optional. The AI dispatcher says "not configured" until a key is set.', {
    testService: 'ai',
    settingsGroup: 'ai',
    steps: [
      'Any OpenAI-compatible API works. Set **Base URL**, **API key** and **Model** in System settings → AI, then press Test.',
      'OpenAI: `https://api.openai.com/v1`, model e.g. `gpt-4o-mini`.',
      'Groq (free tier): `https://api.groq.com/openai/v1`, model e.g. `llama-3.3-70b-versatile`.',
      'OpenRouter: `https://openrouter.ai/api/v1`, many models including free ones.',
      'Together: `https://api.together.xyz/v1`.',
    ],
  }));
  items.push(item('search', 'AI web research', set('search.provider') && set('search.apiKey') ? 'done' : 'optional', 'Optional. Lets the AI dispatcher cite web sources (Tavily or Brave Search).', {
    testService: 'search',
    settingsGroup: 'ai',
    steps: ['Get a key from Tavily (free tier) or Brave Search API.', 'Set provider (`tavily` or `brave`) and key in System settings → AI.'],
    links: [{ label: 'Tavily', url: 'https://app.tavily.com' }, { label: 'Brave Search API', url: 'https://api-dashboard.search.brave.com' }],
  }));
  items.push(item('fmcsa', 'FMCSA data', set('fmcsa.socrataAppToken') ? 'done' : 'partial',
    `Census search works without a key${set('fmcsa.socrataAppToken') ? ' and your Socrata app token raises the rate limit' : '; a free Socrata app token raises the rate limit'}. QCMobile enrichment ${set('fmcsa.webKey') ? 'is on' : 'needs a free FMCSA webKey'}.`, {
      testService: 'fmcsa',
      settingsGroup: 'integrations',
      steps: [
        'Socrata app token: sign in at data.transportation.gov → **Developer settings → Create new app token**.',
        'QCMobile webKey: register at mobile.fmcsa.dot.gov (login.gov account) and request a webKey.',
        'Paste both in System settings → Integrations.',
      ],
      links: [{ label: 'Socrata app tokens', url: 'https://data.transportation.gov/profile/edit/developer_settings' }, { label: 'FMCSA QCMobile', url: 'https://mobile.fmcsa.dot.gov/QCDevsite/' }],
    }));
  items.push(item('telephony', 'Calling', 'optional', 'Set per user in **Settings → Calling**: Google Voice, 8x8, RingCentral, Dialpad, Teams, Zoom Phone, tel/SIP links, or a Twilio bridge.', {
    steps: [
      'Each user picks their provider in Settings → Calling. Link providers need no server setup.',
      `Twilio bridge needs the user's Account SID, auth token and caller ID, and a public https APP_URL for status webhooks (${https ? 'yours is https' : 'yours is not https yet'}).`,
      'The browser extension is downloaded from **Browser extension** in the app and uses a personal access token.',
    ],
  }));

  // Operations
  const backups = listBackups();
  const latest = backups[0];
  const fresh = latest && Date.now() - new Date(latest.createdAt).getTime() < 2 * 86400000;
  items.push(item('backups', 'Backups and admin account', fresh ? 'done' : 'todo', latest
    ? `Automatic daily database backup. Latest: ${latest.name} (${Math.round(latest.size / 1024)} KB). The newest 7 are kept in /data/backups. Download one now and then and keep it off the server.`
    : 'The app makes a database backup once a day into /data/backups. The first one runs within an hour of startup, or press Back up now.', {
    backups: backups.slice(0, 7),
    steps: [
      'Use **Back up now** for an extra copy, and **Download** to keep one off the server (it contains password hashes and encrypted keys: store it safely).',
      'To restore a database backup: stop the app in Coolify, copy the file over `/data/app.db` in the volume (delete `app.db-wal` and `app.db-shm`), then start the app.',
      'Coolify: open the app → **Storages** to see the volume name (it ends with `dispatchdesk-data`). Coolify\'s **Backups** are for databases; back up this volume from the server shell.',
      'On the server: `docker run --rm -v <volume-name>:/data -v /root/backups:/backup busybox tar czf /backup/dispatchdesk-$(date +%F).tgz /data`. Schedule it with cron and copy the files off the server.',
      'Restore: stop the app, then `docker run --rm -v <volume-name>:/data -v /root/backups:/backup busybox sh -c "rm -rf /data/* && tar xzf /backup/<file>.tgz -C /"`, then start it.',
      'Change the generated admin password in **Settings → Security** after the first sign-in.',
      'Keep `APP_SECRET` unchanged: it encrypts saved credentials. If it changes, saved keys and mailbox passwords must be entered again.',
    ],
  }));

  const jobs = await jobStatuses();
  const failing = jobs.filter((j) => j.lastOk === false);
  items.push(item('jobs', 'Background jobs', failing.length ? 'partial' : 'done', failing.length
    ? `${failing.length} job(s) failed on their last run: ${failing.map((j) => j.name).join(', ')}.`
    : 'Cleanup, reminders, backup and database upkeep run automatically on their schedules.', { jobs }));

  const required = items.filter((i) => i.required);
  return {
    items,
    progress: { done: required.filter((i) => i.status === 'done').length, total: required.length },
    appUrl: config.appUrl,
  };
}

r.get('/', requirePermission('admin.settings'), ah(async (req, res) => {
  res.json(await buildChecklist(req));
}));

r.get('/jobs', requirePermission('admin.settings'), ah(async (req, res) => {
  res.json({ items: await jobStatuses() });
}));

r.post('/jobs/:name/run', requirePermission('admin.settings'), ah(async (req, res) => {
  const job = JOBS.find((j) => j.name === req.params.name);
  if (!job) throw badRequest('Unknown job');
  const result = await runJob(job, new Date());
  await audit(req, 'admin.job_run', { details: { job: job.name, ok: result.ok } });
  res.json({ result, items: await jobStatuses() });
}));

r.get('/backups', requirePermission('admin.settings'), ah(async (req, res) => {
  res.json({ items: listBackups() });
}));

r.post('/backups', requirePermission('admin.settings'), ah(async (req, res) => {
  const b = await runBackup({ force: true });
  if (!b) throw unavailable('A backup is already running, or this database is not a SQLite file');
  await audit(req, 'admin.backup_created', { details: { name: b.name } });
  res.status(201).json({ backup: b, items: listBackups() });
}));

r.get('/backups/:name', requirePermission('admin.settings'), ah(async (req, res) => {
  const p = backupPath(req.params.name);
  if (!p) throw badRequest('Backup not found');
  await audit(req, 'admin.backup_downloaded', { details: { name: req.params.name } });
  res.download(p, req.params.name);
}));

/** Find a product created earlier for this plan (metadata dispatchdesk_plan=<key>). */
async function findProduct(stripe, planKey) {
  if (stripe.products.search) {
    try {
      const found = await stripe.products.search({ query: `metadata['dispatchdesk_plan']:'${planKey}'`, limit: 1 });
      if (found.data?.[0]) return found.data[0];
    } catch { /* search not available in every account/region; fall back to listing */ }
  }
  const list = await stripe.products.list({ limit: 100, active: true });
  return list.data.find((p) => p.metadata?.dispatchdesk_plan === planKey) || null;
}

r.post('/stripe/provision', requirePermission('admin.billing', 'admin.settings'), ah(async (req, res) => {
  const body = parse(z.object({ recreateWebhook: z.boolean().default(false) }), req.body);
  if (!config.appUrl.startsWith('https://')) throw badRequest('APP_URL must be a public https address before Stripe can send webhooks to it');
  const stripe = await getStripe();
  if (!stripe) throw unavailable('Save a Stripe secret key in System settings → Billing first');
  const report = { plans: [], webhook: null, mode: null };
  try {
    const bal = await stripe.balance.retrieve();
    report.mode = bal.livemode ? 'live' : 'test';
  } catch (err) {
    throw badRequest(`Stripe rejected the secret key: ${err.message}`);
  }

  const plans = await prisma.plan.findMany({ where: { active: true, key: { not: 'free' } }, orderBy: { sortOrder: 'asc' } });
  for (const plan of plans) {
    if (plan.stripePriceId) { report.plans.push({ plan: plan.key, action: 'kept', priceId: plan.stripePriceId }); continue; }
    if (!plan.priceCents) { report.plans.push({ plan: plan.key, action: 'skipped', reason: 'price is 0' }); continue; }
    let product = await findProduct(stripe, plan.key);
    const productAction = product ? 'reused' : 'created';
    if (!product) {
      product = await stripe.products.create({ name: `DispatchDesk ${plan.name}`, description: plan.description || undefined, metadata: { dispatchdesk_plan: plan.key } });
    }
    // Reuse an existing matching price on that product, else create one.
    const interval = plan.interval === 'year' ? 'year' : 'month';
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
    let price = prices.data.find((p) => p.unit_amount === plan.priceCents && p.currency === 'usd' && p.recurring?.interval === interval);
    const priceAction = price ? 'reused' : 'created';
    if (!price) {
      price = await stripe.prices.create({
        product: product.id, currency: 'usd', unit_amount: plan.priceCents,
        recurring: { interval, usage_type: 'licensed' }, // per-seat plans use quantity = seats at checkout
        nickname: `${plan.name}${plan.perSeat ? ' per seat' : ''}`, metadata: { dispatchdesk_plan: plan.key },
      });
    }
    await prisma.plan.update({ where: { id: plan.id }, data: { stripePriceId: price.id } });
    report.plans.push({ plan: plan.key, action: `product ${productAction}, price ${priceAction}`, productId: product.id, priceId: price.id, perSeat: plan.perSeat });
  }

  const url = webhookUrl();
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = endpoints.data.find((e) => e.url === url);
  const secretSaved = !!(await getSettings(['stripe.webhookSecret']))['stripe.webhookSecret'];
  const createEndpoint = async () => {
    const ep = await stripe.webhookEndpoints.create({ url, enabled_events: STRIPE_WEBHOOK_EVENTS, description: 'DispatchDesk billing' });
    await setSetting('stripe.webhookSecret', ep.secret, req.user.id);
    return ep;
  };
  if (!existing) {
    const ep = await createEndpoint();
    report.webhook = { action: 'created', id: ep.id, url, secretSaved: true };
  } else if (secretSaved && !body.recreateWebhook) {
    // Make sure it listens to every event we handle.
    const missing = STRIPE_WEBHOOK_EVENTS.filter((e) => !existing.enabled_events?.includes(e) && !existing.enabled_events?.includes('*'));
    if (missing.length) await stripe.webhookEndpoints.update(existing.id, { enabled_events: [...new Set([...(existing.enabled_events || []), ...missing])] });
    report.webhook = { action: missing.length ? 'reused, events added' : 'reused', id: existing.id, url, secretSaved: true };
  } else if (body.recreateWebhook) {
    await stripe.webhookEndpoints.del(existing.id);
    const ep = await createEndpoint();
    report.webhook = { action: 'recreated', id: ep.id, url, secretSaved: true };
  } else {
    report.webhook = {
      action: 'needs_confirmation', id: existing.id, url, secretSaved: false,
      message: 'A webhook for this URL already exists, but its signing secret is not saved here and Stripe only reveals it at creation. Run again with "recreate webhook" to replace it, or paste its signing secret in System settings.',
    };
  }

  invalidatePlans(); // cached plans carry the Stripe price ids
  await audit(req, 'admin.stripe_provisioned', { details: { mode: report.mode, plans: report.plans.map((p) => `${p.plan}:${p.action}`), webhook: report.webhook?.action } });
  res.json(report);
}));

export default r;
