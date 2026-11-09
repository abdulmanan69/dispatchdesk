# DispatchDesk

A dispatching and sales CRM for truck dispatchers. It covers carrier lead discovery, pipeline, prospecting, sequences, email, AI dispatcher, brokers and loads, training, marketplace, community, teams, billing and admin. Everything runs in **one Docker container**.

This is an original implementation inspired by the public functionality of selldispatch.com. No proprietary code, branding or assets are reused. See [docs/FEATURE_SPEC.md](docs/FEATURE_SPEC.md) for the research notes and [docs/CHECKLIST.md](docs/CHECKLIST.md) for implementation status.

## Production

The live deployment (Coolify, domain, email, Stripe, keys, backups) is documented step by step in [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md). Admins see the same checklist, checked against the real configuration, under **Admin → Setup**.

## Quick start

```bash
cp .env.example .env          # set ADMIN_EMAIL / ADMIN_PASSWORD (and APP_URL for production)
docker compose up --build -d
```

Open http://localhost:3000 and log in with the admin account from `.env`. Anyone can register a normal account at `/register`.

Check health with `curl http://localhost:3000/api/health`, and follow the logs with `docker compose logs -f app`.

### Admin account

- **First start:** if `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set, a super admin is created (only when that email does not exist yet).
- **Any time:**
  ```bash
  docker compose exec app node scripts/create-admin.js you@example.com 'StrongPass1' 'Your Name'
  ```
  This creates the user, or promotes an existing one and resets its password.

## Architecture

```
┌──────────────────────────── one container (node:24-bookworm-slim, non-root) ───────────────────────────┐
│  tini → entrypoint.sh → prisma migrate deploy → node src/index.js                                        │
│                                                                                                          │
│  Express API (/api/*) ── session auth, CSRF, RBAC, rate limits, helmet CSP                               │
│     ├─ Prisma 7 ORM ──► SQLite  /data/app.db  (better-sqlite3 driver adapter)                            │
│     ├─ uploads ───────► /data/uploads/{documents,avatars,knowledge,training,marketplace,imports}         │
│     ├─ in-process scheduler (email queue, sequence email steps, follow-up reminders, knowledge ingest)   │
│     └─ adapters: FMCSA Census/QCMobile · SMTP/Hostinger/Gmail/Outlook · OpenAI-compatible · Tavily/Brave │
│        · Stripe                                                                                          │
│  Static React SPA (Vite build) served by the same Express process                                        │
└──────────────────────────────────────────────── volume: dispatchdesk-data → /data ──────────────────────┘
```

| Layer | Choice |
|---|---|
| Frontend | React 19, React Router 7, TanStack Query 5, Tailwind CSS 4, Recharts, lucide icons |
| Backend | Node 24, Express 4, Zod validation, Multer uploads, Nodemailer, Stripe SDK |
| Database | SQLite via Prisma 7 (`server/prisma/schema.prisma`, migrations in `server/prisma/migrations`) |
| Auth | bcrypt (cost 12), DB-backed sessions in HTTP-only SameSite=Lax cookies, double-submit CSRF token |
| Secrets | Integration credentials encrypted with AES-256-GCM using a key derived from `APP_SECRET` |

### Persistence

Everything stateful lives in the `/data` volume: the database, uploads, and the generated app secret (`/data/.app_secret`, created when `APP_SECRET` is unset). Containers can be rebuilt or restarted without data loss. Back it up with:

```bash
docker run --rm -v dispatchdesk-data:/data -v "$PWD":/backup busybox tar czf /backup/dispatchdesk-backup.tgz /data
```

## Local development (without Docker)

```bash
cd server && npm install && npx prisma migrate deploy && npm run dev     # API on :3000
cd client && npm install && npm run dev                                   # UI on :5173 (proxies /api)
```

## Tests

```bash
cd server && npm test        # API, auth, authorization, tenant isolation, services
cd client && npm test        # component tests

# Against a running container (reads ADMIN_EMAIL/ADMIN_PASSWORD from .env):
node e2e/workflow.mjs setup  http://localhost:3000   # 22 business workflows (incl. real SMTP delivery to a local sink)
docker compose restart
node e2e/workflow.mjs verify http://localhost:3000   # data, files and secrets survived the restart
cd e2e && npm install && npx playwright install chromium && BASE_URL=http://localhost:3000 npx playwright test   # UI smoke
```

`workflow.mjs` starts an SMTP sink on port 2525, which the container reaches at `host.docker.internal` (override with `SMTP_SINK_HOST`).

See [docs/TEST_REPORT.md](docs/TEST_REPORT.md) for the latest results.

## Integrations and credentials

Each integration below has a working adapter, configuration screen, validation and error handling. Without credentials, the app says so plainly and never fakes results. You can set credentials in `.env` or in **Admin → Settings**; values set there are encrypted and take precedence.

| Integration | Needed | Without it |
|---|---|---|
| FMCSA Company Census (data.transportation.gov) | nothing (optional `SOCRATA_APP_TOKEN`) | — works out of the box |
| FMCSA QCMobile enrichment | `FMCSA_WEBKEY` | census data only |
| Platform email (verification, resets, invites) | `SMTP_*` | links are not emailed. Invite links are shown to team owners instead. |
| User mailboxes: SMTP / Hostinger | user enters their SMTP details in Email → Mailboxes | — |
| User mailboxes: Gmail | `GOOGLE_CLIENT_ID/SECRET`, redirect `${APP_URL}/api/email/oauth/gmail/callback` | button disabled with explanation |
| User mailboxes: Outlook | `MICROSOFT_CLIENT_ID/SECRET`, redirect `${APP_URL}/api/email/oauth/outlook/callback` | button disabled with explanation |
| AI dispatcher | `AI_API_KEY` (+ `AI_BASE_URL`, `AI_MODEL`) for any OpenAI-compatible API | AI returns "not configured" |
| AI web research | `SEARCH_PROVIDER` (`tavily`/`brave`) + `SEARCH_API_KEY` | knowledge base only |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and Price IDs per plan in Admin → Plans. Webhook endpoint: `${APP_URL}/api/billing/webhook` | checkout disabled. Everyone stays on Free. |

### Lead generator

**Lead generator** (`/app/lead-generator`) saves FMCSA Census searches as profiles. Each run pulls live census records, skips carriers already in your CRM, and scores each lead 0–100 (phone, email, MC authority, active USDOT, new authority, small fleet). It then adds the leads to your pipeline, call queue and, optionally, a prospect list. **Preview matches** shows results without using quota.

| Plan | Leads / month | Profiles | Scheduled runs |
|---|---|---|---|
| Free | 50 | 1 | — |
| Pro / Annual | 2,000 | 10 | daily or weekly |
| Teams | 5,000 | 25 | daily or weekly |

Admins can change these in **Admin → Plans**.

### Click-to-call

Choose a provider in **Settings → Calling**. Every phone number in the app, the power dialer (`/app/dialer`) and the browser extension then dial through it. Each call starts with a user click; nothing is auto-dialed.

| Provider | How it dials | Needs |
|---|---|---|
| Google Voice | Opens `voice.google.com` with the number; you press call (Google Voice has no calling API) | Signed in to Google Voice in the browser |
| 8x8 Work, RingCentral, Dialpad, system default | `tel:` link handled by the desktop app | App installed and set as the default calling app |
| Microsoft Teams | Teams call link | Teams Phone licence |
| Zoom Phone | `zoomphonecall://` | Zoom desktop app |
| callto / SIP / custom | Your URL template with `{number}` or `{digits}` | — |
| Twilio (bridge) | Rings your phone, then connects the carrier. Status, duration and unanswered calls are logged automatically | Account SID, auth token, caller ID, your phone. `APP_URL` must be public HTTPS for the status webhooks |

### Browser extension

**Browser extension** (`/app/extension`):
1. Download the zip. It comes pre-configured with this server's URL.
2. In Chrome or Edge, open `chrome://extensions`, turn on Developer mode, then click **Load unpacked**.
3. Paste a personal access token you created on that page.

Using it:
- **Toolbar button:** scans the current page, but only when you click it. It finds phone, USDOT and MC numbers, and for each you can call, find it in your CRM, or add it.
- **Right-click menu:** call or look up the text you have selected.

Tokens can't reach admin, settings, billing or token endpoints. Only a SHA-256 hash of each token is stored.

For local Stripe testing, run `stripe listen --forward-to localhost:3000/api/billing/webhook` and put the printed `whsec_…` value in `STRIPE_WEBHOOK_SECRET`.

## Security notes

- RBAC is enforced on the server: roles and permissions live in DB tables, and every admin route checks a specific permission.
- Each dispatcher's pipeline is private. Team visibility follows team permissions. Platform admins do not get implicit access to private pipelines.
- Uploads are checked by extension, MIME type and magic bytes, with size limits. They are stored outside the web root and served only through access-checked endpoints.
- Rate limiting covers auth, AI, public forms and the API in general. Audit logs record security and admin actions.
- `EXPOSE_DEV_TOKENS` must stay `false` in production.
