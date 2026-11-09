# Development Checklist

Legend:
- `[x]` implemented and tested.
- `[~]` implemented and unit-tested with mocks; live use needs external credentials.
- `[ ]` not done.

## Phase 1 — Research
- [x] Inspect the reference's public pages (home, plans, teams, training, marketplace). See FEATURE_SPEC.md.
- [x] "REA tool": not available in this environment, so WebFetch/WebSearch were used instead.
- [x] Verify the FMCSA Census public dataset fields.

## Phase 2 — Architecture
- [x] Express + Prisma 7 (SQLite) + React 19 / Vite / Tailwind 4, all in one container.
- [x] Normalized schema: 50+ models with FKs, indexes, unique constraints and cascades. Migration in `server/prisma/migrations`.

## Phase 3 — Foundation
- [x] Auth: register, login, logout, email verification, forgot/reset password, change password, sessions with sliding expiry and revoke.
- [x] RBAC: Role, Permission and RolePermission tables, enforced in backend middleware. Team roles: owner, manager, dispatcher.
- [x] Security: CSRF, rate limits, helmet CSP, upload validation (extension, MIME, magic bytes), AES-GCM credential encryption, audit log.
- [x] Client: layouts, router, UI kit, toasts, confirm dialogs, dark/light/system theme.
- [x] Docker: multi-stage Dockerfile, single-service compose, entrypoint migrations, healthcheck, non-root user, `/data` volume.

## Phase 4 — Core business
- [x] Dashboard: KPIs and charts computed from the DB.
- [x] Carriers: CRUD, profile tabs, contacts, notes, tags, assignment, bulk actions.
- [x] Discovery: live FMCSA Census search and save, duplicate detection, enrichment.
- [~] Discovery: FMCSA QCMobile adapter (needs a webKey).
- [x] CSV import and export.
- [x] Pipeline: board (drag-and-drop plus keyboard) and table.
- [x] Prospecting: lists and daily call queue with local time, priority and DNC handling. Call outcomes drive the next steps.
- [x] Sequences: call, email and task steps; business hours; weekends; enrollments.
- [x] Follow-ups.
- [x] Opportunities and customers, including trials, conversion, lanes, compliance checklist and revenue.

## Phase 5 — Advanced
- [x] Brokers, loads, rate calculator, load-text parser, lane history.
- [x] Email: SMTP/Hostinger, templates, drafts, scheduling, retries, limits, cooldown, suppression, unsubscribe. Real delivery verified against an SMTP sink.
- [~] Email: Gmail and Outlook OAuth adapters (need OAuth apps).
- [x] Scheduler: email queue, sequence email steps, follow-up reminders, knowledge ingest.
- [~] AI dispatcher: chat, history, RAG, web search with sources, drafts, scripts, objections, load analysis. Returns an honest 503 when unconfigured.
- [x] Automations.
- [x] Documents: upload, download, replace, delete, expiry, access control.

## Phase 6 — Business
- [x] Training center: five seeded original courses, progress tracking, trainer inbox, booking requests, admin.
- [x] Marketplace: listings, images, inbox, reports, moderation.
- [x] Community: posts, threaded comments, profiles, reports, moderation.
- [x] Teams: create, invite, accept, roles, permissions, board, leaderboard, activity, seat limits.
- [~] Billing: plans, limits, checkout/portal/cancel/resume/change, verified webhooks. Needs Stripe keys and Price IDs.
- [x] Admin: stats, users, subscriptions, plans, moderation, system settings with live tests, audit.
- [x] Settings: profile, avatar, security, theme, notifications, integrations status, data export, account deletion.

## Phase 7 — Testing
- [x] Server: 238 tests.
- [x] Client: 10 tests.
- [x] E2E: 22 workflows against Docker.
- [x] Persistence: 16 checks.
- [x] Playwright UI: 6 tests.

## Phase 8 — Delivery
- [x] README, `.env.example`, TEST_REPORT, FEATURE_SPEC, and the admin script `server/scripts/create-admin.js`.

## Phase 9 — Calling, extension, tools
- [x] Click-to-call through Google Voice, 8x8, RingCentral, Dialpad, Teams, Zoom Phone, tel/callto/SIP/custom links. Verified live from the container for Google Voice.
- [~] Twilio bridge calls with signed webhooks, auto duration and auto-logged unanswered calls. Tested with mocks; needs Twilio credentials to verify live.
- [x] Power dialer: queue or list session, scripts, 1–8 outcome keys, timer, auto-advance, DNC and calling-hours guards.
- [x] Call scripts library with 7 original starter scripts.
- [x] Personal access tokens (bearer auth, blocked from sensitive routes).
- [x] Browser extension (MV3), downloadable as a zip pre-configured for this server.
- [x] Dispatch tools hub: 11 calculators and lookups.
- [x] Ctrl+K command palette.
- [x] Unslop design pass, dropdown presets, and the shader background on public pages.

## Phase 10 — Lead generator
- [x] Saved lead-generator profiles: states, cargo, fleet size, authority age, contact requirements, minimum lead score, stage and prospect list.
- [x] Each run pulls live FMCSA Census records, skips carriers already in the CRM, scores leads 0–100 with reasons, and saves them with a score note and priority.
- [x] Preview matches without using quota.
- [x] Plan gating: `monthlyLeadGenLimit`, `maxLeadGenerators` and `leadGenAutoRun` per plan, editable in Admin → Plans. Shown on Pricing and Billing.
- [x] Scheduled daily/weekly runs on paid plans, with notifications. Runs pause automatically if the plan no longer includes them.
- [x] Fixed a tenant leak: the call queue's hot-lead query lost its owner filter because a second `OR` replaced it.

## Known gaps / future work
- **Email replies and bounces:** inbound reply detection and bounce processing are not implemented. The `bounced` reason is manual only.
- **Company plan:** the Company plan ($30 + per seat) is not seeded. The `basePriceCents` column exists for it.
- **Telephony:** calls are never placed without a user click, by design (TCPA). Google Voice can't be automated further because it has no public API.
- **Extension:** the browser extension has not yet been loaded and clicked through in a real browser; its API calls are tested server-side.
- **Live market data:** there are no diesel prices or spot rates. Users enter fuel prices themselves, and the app never invents rates.
- **Leaderboard week:** it covers the last 7 days, not the calendar week.

## Phase 11 — Mail, follow-ups, workflow, market, fleet
- [x] Email → Mailboxes: one-click Google/Microsoft OAuth (admin registers apps once; guide with redirect URIs in Admin → Settings) and app-password presets for Gmail, Outlook, Yahoo, AOL, Zoho, iCloud, Hostinger, GoDaddy, Fastmail and other SMTP, with test before save.
- [x] Follow-ups workspace: views with counts, week view, priority, repeat, reminders, snooze, bulk actions, call/email/text from the row.
- [x] Themed dropdowns, combo boxes, checkboxes and radios (no native popups).
- [x] Find leads → add to sequence → Start → choose Google Voice → call → disposition → email step → text step (manual, skippable).
- [x] Extension 1.2.0: side-by-side workspace, side panel with dispositions, reuse of the open Google Voice tab, Google account choice.
- [x] Lead profile: prev/next, copy fields, enrich diff, resource links (SAFER, SMS, L&I, Google, Map), activity rail, diesel card. List: no-activity filter, last call/activity.
- [x] Market: colored US map, FMCSA carriers per state, EIA diesel/gasoline (free key), weather and NWS alerts, holidays, FRED/USDA (free keys), user-entered spot rates with DAT Trendlines link, trip fuel calculator.
- [x] Fleet map (OpenFreeMap tiles): truck status/location, trip planning with road routes, deadhead, RPM, fuel, weather, find trucks near a load, week board.
- [ ] Open-Meteo is free for non-commercial use only; a paid deployment may need their commercial plan.
