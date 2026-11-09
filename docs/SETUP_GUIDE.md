# DispatchDesk production setup guide

This guide covers the production deployment at **https://dispatchdesk.work.gd**, in the order things should be set up. The same checklist, computed live from the site's real configuration, is in the app under **Admin → Setup**, with copy buttons, test buttons and one-click Stripe setup.

Items marked *required* are needed for a complete public launch. Everything else is optional; the app works without it and says so plainly where a feature is not connected.

---

## 1. Hosting (done)

| What | Value |
|---|---|
| Server | `76.13.223.28`, Coolify 4 at `http://76.13.223.28:8000` |
| Coolify project | `dispatchdesk` → environment `production` → application `dispatchdesk` |
| Source | `https://github.com/abdulmanan69/dispatchdesk`, branch `main` (public repo) |
| Build pack | Docker Compose, file `/docker-compose.coolify.yml` |
| Domain | `https://dispatchdesk.work.gd` (Let's Encrypt certificate issued by Coolify) |
| Data | Named volume ending in `dispatchdesk-data`, mounted at `/data` (SQLite database, uploads, generated secret) |

### Environment variables (Coolify → app → Environment Variables)

| Variable | Purpose |
|---|---|
| `APP_URL` | `https://dispatchdesk.work.gd`. Used in email links, OAuth redirects and webhook URLs. Must match the domain. |
| `APP_SECRET` | Long random string. Encrypts saved credentials (SMTP passwords, API keys, OAuth tokens). **Never change it** after setup, or every saved credential must be re-entered. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | The first super admin, created only if that email does not exist yet. Change the password in **Settings → Security** after the first sign-in. |
| `COOKIE_SECURE` | `true` (session cookies only over HTTPS). |

Everything else (email, Stripe, keys) is entered in **Admin → System settings**, where secrets are encrypted at rest. The same names are also accepted as environment variables (see `.env.example`); values saved in the admin screen take precedence.

### Redeploy

Push to `main`, then in Coolify press **Redeploy** (or enable automatic deploys on push under the app's Git settings). Database migrations run automatically on start. Data in `/data` is kept.

### DNS (DNSExit)

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `dispatchdesk.work.gd` | `76.13.223.28` | 60 min |

Email DNS records are added in step 3.

---

## 2. Admin account (required)

1. Sign in at `https://dispatchdesk.work.gd/login` with `ADMIN_EMAIL` and the generated `ADMIN_PASSWORD`.
2. **Settings → Security**: change the password.
3. If a user is ever locked out and email is not set up: **Admin → Users → Reset password** generates a one-time temporary password.
4. From the server you can also run: `docker exec -it <app container> node scripts/create-admin.js you@example.com 'NewPassw0rd' 'Your Name'`.

---

## 3. Platform email (required)

Used for account verification, password reset and team invites. Until it is set, accounts still work, the "verify your email" banner is hidden, and admins can issue temporary passwords.

### Pick a provider

| Provider | Free tier | Host | Port | Secure | Username | Password |
|---|---|---|---|---|---|---|
| **Brevo** (recommended) | 300 emails/day | `smtp-relay.brevo.com` | `587` | off (STARTTLS) | your Brevo SMTP login (shown on the SMTP page) | an SMTP key (Brevo → SMTP & API → SMTP keys) |
| Resend | 3,000/month | `smtp.resend.com` | `465` | on | `resend` | your Resend API key |
| Gmail / Workspace | ~500/day | `smtp.gmail.com` | `465` | on | full Gmail address | an app password (needs 2-Step Verification) |
| Zoho Mail | — | `smtp.zoho.com` | `465` | on | mailbox address | mailbox password or app password |
| Hostinger | — | `smtp.hostinger.com` | `465` | on | mailbox address | mailbox password |

### Authenticate the sending domain

Send from an address on a domain you control, for example `no-reply@dispatchdesk.work.gd`. In the provider, add the domain; it shows DKIM records. Add these at DNSExit for that domain:

| Type | Host | Value |
|---|---|---|
| TXT (SPF) | `dispatchdesk.work.gd` | `v=spf1 include:spf.brevo.com ~all` (Resend: `include:amazonses.com`; Gmail: `include:_spf.google.com`; Zoho: `include:zoho.com`) |
| TXT (DMARC) | `_dmarc.dispatchdesk.work.gd` | `v=DMARC1; p=none; rua=mailto:<your admin email>` |
| TXT or CNAME (DKIM) | as shown by the provider | as shown by the provider |

Only one SPF record may exist per domain; merge `include:` entries into one record if you use more than one provider. Wait for the provider to show the domain as verified.

### Enter it in the app

1. **Admin → System settings → Email**: host, port, secure, username, password, and From, e.g. `DispatchDesk <no-reply@dispatchdesk.work.gd>`.
2. Press **Test** (Admin → Setup → Platform email, or the Email section of System settings).
3. Register a test account and confirm the verification email arrives (check spam the first time).
4. Optional: turn on **Require email verification**.

User mailboxes for prospecting (Email → Mailboxes) are separate. Each user connects their own; see step 5.

---

## 4. Payments with Stripe (required to charge)

Without Stripe everyone stays on the Free plan and checkout buttons are disabled.

1. Create a Stripe account and stay in **Test mode** first.
2. Developers → API keys: copy the **secret key** (`sk_test_…`) into **Admin → System settings → Billing**.
3. **Admin → Setup → Payments → Create products, prices and webhook**. For every active paid plan without a Stripe price, this:
   - creates a product named "DispatchDesk <plan>" (tagged `dispatchdesk_plan=<key>` so reruns find it);
   - creates a recurring USD price from the plan's price and interval (per-seat plans are charged quantity = seats);
   - links the price ID to the plan;
   - registers the webhook endpoint below and saves its signing secret.

   Running it again reuses what exists. If a webhook for the URL already exists but its secret is not saved, turn on **Replace existing webhook** and run it again.
4. Manual alternative: create the products and recurring prices in Stripe, paste each `price_…` ID into **Admin → Plans**, create the webhook below, and paste its `whsec_…` secret into System settings.

| Webhook | Value |
|---|---|
| URL | `https://dispatchdesk.work.gd/api/billing/webhook` |
| Events | `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed` |

5. Test: Billing → upgrade with card `4242 4242 4242 4242`, any future expiry, any CVC. The plan activates when the webhook arrives (Admin → Subscriptions shows it).
6. Go live: switch Stripe to Live mode, save the `sk_live_…` key, and press the button again. Live mode has its own products, prices and webhook.

Prices shown in the app come from **Admin → Plans**; Stripe charges the linked Stripe price. To change a price, edit the plan, unlink its price ID, and run the button again (a new Stripe price is created).

---

## 5. One-click Google and Microsoft mailboxes (optional)

Without these, users connect mailboxes with an app password (Gmail, Outlook, Yahoo, Zoho, iCloud, Hostinger, GoDaddy, Fastmail, any SMTP). With them, users press **Continue with Google / Microsoft**.

### Google

1. console.cloud.google.com → new project → **APIs & Services → Library → Gmail API → Enable**.
2. **OAuth consent screen**: External; app name; support email; authorized domain `dispatchdesk.work.gd`; scopes as listed in Admin → Setup.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `https://dispatchdesk.work.gd/api/email/oauth/gmail/callback`.
4. Paste client ID and secret into **System settings → Integrations**; press **Test**.
5. While the consent screen is in "Testing", only listed test users can connect. Publishing for everyone may require Google verification of the Gmail scope.

### Microsoft

1. entra.microsoft.com → **App registrations → New registration**. Supported account types: any organizational directory and personal Microsoft accounts.
2. Redirect URI (Web): `https://dispatchdesk.work.gd/api/email/oauth/outlook/callback`.
3. **Certificates & secrets → New client secret** (copy the value; it is shown once).
4. **API permissions → Microsoft Graph → Delegated**: the scopes listed in Admin → Setup.
5. Paste the Application (client) ID and the secret into **System settings → Integrations**; press **Test**.

---

## 6. Data sources

| Source | Key | Without a key |
|---|---|---|
| FMCSA Company Census | optional Socrata app token (data.transportation.gov → Developer settings) | works, lower rate limit |
| FMCSA QCMobile | free webKey (mobile.fmcsa.dot.gov) | census data only |
| EIA diesel and gasoline | free key (eia.gov/opendata/register.php) | uses EIA's shared `DEMO_KEY` (rate limited, cached 6 h) |
| FRED truck tonnage | free key (fredaccount.stlouisfed.org/apikeys) | card shows "not connected" |
| USDA produce truck rates | free MyMarketNews key | link to the weekly PDF |
| Photon geocoding, OSRM routing, Open-Meteo weather, NWS alerts, Nager.Date holidays | none | work; fair-use public services |
| Map tiles (OpenFreeMap) | none | work |

Paste keys in **System settings → Integrations**. Open-Meteo is free for non-commercial use; a paid deployment should review its terms. OSRM's demo server and Photon are fair-use and not guaranteed for heavy traffic.

Spot rates are entered by each user (Market → Spot rates) with a link to DAT Trendlines; nothing is scraped.

## 7. AI dispatcher (optional)

Any OpenAI-compatible API. **System settings → AI**: base URL, API key, model; press **Test**.

| Provider | Base URL | Example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq (free tier) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | many, including free models |
| Together | `https://api.together.xyz/v1` | — |

Web research for the AI: set the search provider (`tavily` or `brave`) and key.

## 8. Calling and the browser extension

- Each user chooses a provider in **Settings → Calling** (Google Voice, 8x8, RingCentral, Dialpad, Teams, Zoom Phone, tel/SIP/custom, or Twilio). Calls are never placed without a click.
- Twilio bridge: Account SID, auth token, caller ID and the user's phone. Needs the public https `APP_URL` (done) for status webhooks.
- Extension: **Browser extension** page → download the zip (pre-configured for this site) → `chrome://extensions` → Developer mode → Load unpacked → paste a personal access token.

---

## 9. Backups

All state is in the `/data` volume.

```bash
# on the server: find the volume
docker volume ls | grep dispatchdesk-data

# back up (schedule with cron, copy the file off the server)
docker run --rm -v <volume-name>:/data -v /root/backups:/backup busybox \
  tar czf /backup/dispatchdesk-$(date +%F).tgz /data

# restore: stop the app in Coolify first
docker run --rm -v <volume-name>:/data -v /root/backups:/backup busybox \
  sh -c "rm -rf /data/* && tar xzf /backup/<file>.tgz -C /"
```

Then start the app again in Coolify.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Site not reachable | DNSExit A record → `76.13.223.28`; Coolify app status "running/healthy"; `https://dispatchdesk.work.gd/api/health` returns `{"status":"ok"}`. |
| Certificate warning | DNS must resolve before Coolify can issue the certificate; redeploy after DNS propagates. |
| Login works then logs out immediately | `APP_URL` must be `https://…` and match the domain; `COOKIE_SECURE=true` needs HTTPS. |
| Emails not arriving | Admin → Setup → Platform email → **Test**; check the provider dashboard; verify SPF/DKIM/DMARC; check spam. Port 25 is not used; 465/587 must be allowed outbound. |
| "Unknown or expired state" on Google/Microsoft connect | The redirect URI in the provider must exactly match the one shown in Admin → Setup. |
| Checkout works but plan doesn't change | The webhook secret is missing or wrong, or the endpoint URL is wrong. Stripe → Developers → Webhooks shows delivery attempts and errors. Rerun the Setup button with **Replace existing webhook**. |
| Saved keys stopped working after redeploy | `APP_SECRET` changed. Restore the old value or re-enter the keys. |
| Diesel prices missing | EIA `DEMO_KEY` is rate limited; add your own free key. |
| Data lost after redeploy | The app must use `docker-compose.coolify.yml` (named volume). Check Coolify → app → Storages. |
