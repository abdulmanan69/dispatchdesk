// What every system setting is called, how it is explained and which section of which settings page it sits in.
// Shared by the settings pages and the admin search, so a setting can be found by name and opened in place.

export const LABELS = {
  'app.name': 'Application name', 'app.marketplace': 'Marketplace (community listings)', 'app.trainingProgram': 'Live training program (seat requests and trainer messages)', 'app.trialDays': 'Free trial days', 'app.trialPlan': 'Trial plan (features during the trial)',
  'announcement.enabled': 'Show the announcement', 'announcement.text': 'Message', 'announcement.linkUrl': 'Link (optional)', 'announcement.linkLabel': 'Link text',
  'announcement.tone': 'Color', 'announcement.audience': 'Show it to', 'app.supportEmail': 'Support email (shown on the privacy policy and terms)', 'app.registrationOpen': 'Allow new registrations', 'app.requireEmailVerification': 'Require verified email',
  'ai.provider': 'AI provider', 'ai.baseUrl': 'API base URL (OpenAI-compatible only)', 'ai.apiKey': 'API key', 'ai.model': 'Chat model', 'ai.embeddingModel': 'Embedding model (optional, OpenAI-compatible only)',
  'search.provider': 'Web search provider', 'search.apiKey': 'Search API key',
  'smtp.host': 'SMTP host', 'smtp.port': 'Port', 'smtp.secure': 'Use TLS (port 465)', 'smtp.user': 'Username', 'smtp.pass': 'Password', 'smtp.from': 'From address',
  'smtp.dailyLimit': 'Platform emails per day', 'brevo.apiKey': 'Brevo API key (replaces SMTP when set)',
  'google.clientId': 'Google OAuth client ID', 'google.clientSecret': 'Google OAuth client secret',
  'microsoft.clientId': 'Microsoft OAuth client ID', 'microsoft.clientSecret': 'Microsoft OAuth client secret', 'microsoft.tenant': 'Microsoft tenant',
  'fmcsa.webKey': 'FMCSA QCMobile webKey', 'fmcsa.socrataAppToken': 'data.transportation.gov app token', 'eia.apiKey': 'EIA API key (diesel and gasoline prices)', 'fred.apiKey': 'FRED API key (truck tonnage index)', 'usda.marsApiKey': 'USDA My Market News API key (produce truck rates)',
  'stripe.secretKey': 'Stripe secret key', 'stripe.webhookSecret': 'Stripe webhook signing secret',
  'billing.provider': 'Billing provider', 'paddle.environment': 'Paddle environment', 'paddle.apiKey': 'Paddle API key',
  'paddle.clientToken': 'Paddle client-side token', 'paddle.webhookSecret': 'Paddle webhook secret (Set up Paddle saves it)',
  'manual.usdtAutoConfirm': 'Confirm USDT (TRC20) payments automatically on the TRON chain', 'manual.trongridKey': 'TronGrid API key (optional, raises the TRON lookup limit)',
  'manual.bank': 'Bank wire details (bank, account name, IBAN, SWIFT)', 'manual.usdt': 'USDT wallet address and network', 'manual.taptapsend': 'Taptap Send details (receiver name, number or account)', 'manual.note': 'Note shown under the payment details (optional)',
  'polar.environment': 'Polar environment', 'polar.accessToken': 'Polar organization access token', 'polar.webhookSecret': 'Polar webhook secret (Set up Polar saves it)', 'polar.products': 'Polar products (Set up Polar saves them)',
  'app.legalName': 'Legal name (business or owner, shown in the terms)',
};

// Short explanations shown under a setting.
export const HINTS = {
  'app.requireEmailVerification': 'Applies once platform email works. Unverified accounts can sign in and look around, but cannot save changes until they open the verification link. Admins are never blocked.',
  'app.registrationOpen': 'When off, nobody can create a new account. Existing users can still sign in.',
  'app.marketplace': 'Off by default: the payment provider (Paddle) sells DispatchDesk as software only and does not accept a marketplace on the site. Turning it on shows /marketplace and the Marketplace menu.',
  'app.trainingProgram': 'Off by default for the same reason. The self-paced course library is always on; this adds the public /training page with seat requests and trainer messaging.',
  'app.trialDays': 'Accounts without a plan get this many days with the trial plan, then become read-only until they choose a plan. 0 turns the trial off (Free plan forever).',
  'app.trialPlan': 'Plan key whose limits apply during the trial, for example pro.',
  'announcement.linkUrl': 'A page in the app (/app/billing) or a full https:// address.',
  'smtp.dailyLimit': 'Most messages platform email sends per day (UTC), counted across all servers. Part of it is kept for verification and password reset mail. Match it to the daily quota of your SMTP provider.',
  'smtp.from': 'The sender of verification, password reset and notification emails, on your authenticated domain.',
  'ai.provider': "Users without their own key use this provider, within their plan's monthly AI limit. Users can add their own key in Settings → AI.",
  'ai.model': 'For Claude, leave it empty or enter a claude- model; anything else uses claude-opus-5-5.',
  'manual.usdt': 'Include the network (TRC20) and the address. A TRON address also shows customers a QR code and turns on automatic confirmation.',
  'manual.usdtAutoConfirm': 'Each payment gets its own exact USDT amount. When that amount arrives in the wallet, the plan starts by itself within minutes; anything else waits for you in Payments.',
  'billing.provider': 'Who sells the plans. Manual: customers pay by bank wire, USDT or Taptap Send and you approve in Payments. Paddle and Polar are merchants of record; Stripe needs a business in a Stripe country.',
};

/**
 * Settings pages (the `group` of each setting on the server), each split into sections. A section with `provider`
 * belongs to one billing provider: only the active provider's sections are open. Settings in no section are shown
 * under "Other" so nothing new is ever hidden.
 */
export const SETTINGS_PAGES = [
  {
    group: 'app', label: 'General', desc: 'Site name, sign-up rules, the free trial and optional areas of the site',
    sections: [
      { key: 'site', title: 'Site', keys: ['app.name', 'app.supportEmail', 'app.legalName'] },
      { key: 'signup', title: 'Sign-up', keys: ['app.registrationOpen', 'app.requireEmailVerification'] },
      { key: 'trial', title: 'Free trial', keys: ['app.trialDays', 'app.trialPlan'] },
      { key: 'areas', title: 'Optional areas', desc: 'Keep both off while Paddle or Polar sells the plans.', keys: ['app.marketplace', 'app.trainingProgram'] },
    ],
  },
  {
    group: 'billing', label: 'Payment settings', desc: 'Who sells the plans, your payment details and the payment providers',
    sections: [
      { key: 'provider', title: 'Who sells the plans', keys: ['billing.provider'] },
      { key: 'manual', provider: 'manual', title: 'Manual payment details', desc: 'Customers see each method you fill in. Leave a method empty to not offer it.', keys: ['manual.bank', 'manual.usdt', 'manual.taptapsend', 'manual.note'] },
      { key: 'usdt', provider: 'manual', title: 'Automatic USDT confirmation', keys: ['manual.usdtAutoConfirm', 'manual.trongridKey'] },
      { key: 'paddle', provider: 'paddle', title: 'Paddle', test: ['paddle'], keys: ['paddle.environment', 'paddle.apiKey', 'paddle.clientToken', 'paddle.webhookSecret'] },
      { key: 'polar', provider: 'polar', title: 'Polar', test: ['polar'], keys: ['polar.environment', 'polar.accessToken', 'polar.webhookSecret', 'polar.products'] },
      { key: 'stripe', provider: 'stripe', title: 'Stripe', test: ['stripe'], keys: ['stripe.secretKey', 'stripe.webhookSecret'] },
    ],
  },
  {
    group: 'email', label: 'Email', desc: 'The address and server that send verification, password reset and notification emails',
    sections: [
      { key: 'sender', title: 'Sender', keys: ['smtp.from'] },
      { key: 'smtp', title: 'SMTP server', desc: 'Hostinger: smtp.hostinger.com, port 465, TLS on.', test: ['smtp'], keys: ['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass'] },
      { key: 'brevo', title: 'Brevo (instead of SMTP)', desc: 'Paste a Brevo API key to send through Brevo; the From address must be on your authenticated domain.', keys: ['brevo.apiKey'] },
      { key: 'limit', title: 'Daily limit', keys: ['smtp.dailyLimit'] },
    ],
  },
  {
    group: 'ai', label: 'AI & web search', desc: 'The AI dispatcher for users without their own key, and web research',
    sections: [
      { key: 'ai', title: 'AI dispatcher', test: ['ai'], keys: ['ai.provider', 'ai.apiKey', 'ai.model', 'ai.baseUrl', 'ai.embeddingModel'] },
      { key: 'search', title: 'Web research', test: ['search'], keys: ['search.provider', 'search.apiKey'] },
    ],
  },
  {
    group: 'integrations', label: 'Integrations', desc: 'Gmail and Outlook sign-in, FMCSA carrier data and market data keys',
    sections: [
      { key: 'google', title: 'Gmail (Google OAuth)', test: ['google'], keys: ['google.clientId', 'google.clientSecret'] },
      { key: 'microsoft', title: 'Outlook (Microsoft OAuth)', test: ['microsoft'], keys: ['microsoft.clientId', 'microsoft.clientSecret', 'microsoft.tenant'] },
      { key: 'fmcsa', title: 'Carrier data (FMCSA)', desc: 'FMCSA Census works without a key; a QCMobile webKey adds authority-status lookups.', test: ['fmcsa'], keys: ['fmcsa.webKey', 'fmcsa.socrataAppToken'] },
      { key: 'market', title: 'Market data', desc: 'Free keys: eia.gov/opendata, fred.stlouisfed.org and mymarketnews.ams.usda.gov.', keys: ['eia.apiKey', 'fred.apiKey', 'usda.marsApiKey'] },
    ],
  },
  {
    group: 'announcement', label: 'Announcement bar', desc: 'A one-line message across the top of the app, the website or both',
    sections: [
      { key: 'announcement', title: 'Announcement', desc: 'Each viewer can close it; changing the text shows it again to everyone.', keys: ['announcement.enabled', 'announcement.text', 'announcement.linkUrl', 'announcement.linkLabel', 'announcement.tone', 'announcement.audience'] },
    ],
  },
];

export const settingsPage = (group) => SETTINGS_PAGES.find((p) => p.group === group) || SETTINGS_PAGES[0];

/** The page and section a setting lives in. */
export function settingPlace(key) {
  for (const page of SETTINGS_PAGES) {
    const section = page.sections.find((s) => s.keys.includes(key));
    if (section) return { page, section };
  }
  return null;
}
