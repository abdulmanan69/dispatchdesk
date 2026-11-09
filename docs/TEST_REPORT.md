# Test Report

Date: 2026-11-09 · Environment: Windows 11, Docker Desktop 29.9, image `dispatchdesk:latest` (node:24-bookworm-slim), Node 26 for local test runs.

## Summary

| Suite | Command | Result |
|---|---|---|
| Server API / services | `cd server && npm test` | **16 files, 128 tests passed** |
| Client components | `cd client && npm test` | **10 tests passed** |
| Client production build | `cd client && npx vite build` | built, no errors |
| End-to-end workflows (against the Docker container) | `node e2e/workflow.mjs setup http://localhost:3100` | **22/22 passed** |
| Persistence after `docker compose restart` | `node e2e/workflow.mjs verify …` | **8/8 passed** |
| Persistence after `docker compose down && up` (volume kept) | `node e2e/workflow.mjs verify …` | **8/8 passed** |
| UI smoke (Playwright/Chromium: every route, user + admin, detail pages, 375px mobile) | `cd e2e && npx playwright test` | **6/6 passed** |
| Live FMCSA Census search from the container | manual API call | real records returned |

## Server test coverage (128 tests)

- **auth:** CSRF enforcement, register/login/logout, bcrypt storage, duplicate/weak password rejection, one-time email verification, password reset (no account enumeration, sessions invalidated), session list/revoke, change password, protected routes, profile validation, health.
- **carriers / prospecting (F1):** CRUD, duplicate detection, filters and search, CSV import/export, bulk actions, stage changes, notes/contacts/tags, FMCSA census + QC adapters (mocked HTTP), discovery save with plan limits, call queue, call outcomes → next steps, sequences and enrollments, follow-ups, tenant isolation.
- **deals / dispatch / documents (F2):** opportunity → trial → customer transitions, revenue, lost + archive, rate calculator formulas and divide-by-zero guard, load-text parser on four realistic formats, lane history, document upload/download/replace/delete, rejected file types and spoofed signatures, cross-tenant denial.
- **email / ai / automations (F3):** encrypted mailbox credentials, honest send status (failed sends never marked sent), cooldown, retry → failed, sequence email steps via the scheduler, no-mailbox notification, suppression + unsubscribe, AI 503 when unconfigured, RAG isolation, plan limits, automation loop guard, tenant isolation.
- **training / marketplace / community (F4):** public vs authenticated access, progress, trainer messaging, admin course management, listing ownership, inbox, reports, moderation, comment threading and soft delete.
- **dashboard / teams / billing / admin (F5):** dashboard aggregates from DB, team create/invite/accept/roles/seat limits/leaderboard, Stripe webhook signature verification and idempotency (signed test events, mocked client), checkout 503 without Stripe, admin permission checks on every route (non-admin 403), role-escalation guard, settings masking, data export, account deletion rules.

## End-to-end workflows (`e2e/workflow.mjs`, against the running container)

| # | Workflow | Result |
|---|---|---|
| 01 | Register a new user | pass |
| 02 | Log out, rejected bad password, log in | pass |
| 03 | Open dashboard (DB-computed stats) | pass |
| 04 | Add a carrier; duplicate blocked (409) | pass |
| 05 | Import CSV (2 created, 1 duplicate skipped) | pass |
| 06 | Search by name, MC, DOT, phone; filter by state | pass |
| 07 | Add carrier to prospecting (stage + prospect list) | pass |
| 08 | Create a 4-step call/email sequence and enroll; call queue | pass |
| 09 | Record a call outcome (auto follow-up) | pass |
| 10 | Create a follow-up | pass |
| 11 | Move carrier to opportunities | pass |
| 12 | Convert opportunity into customer | pass |
| 13 | Upload W-9 PDF, download byte-identical; spoofed PDF rejected | pass |
| 14 | Create a broker | pass |
| 15 | Add a load | pass |
| 16 | Rate per mile = $2,200 / 781 mi = **$2.82**; parse pasted load text | pass |
| 17 | AI email draft → honest **503 "AI not configured"** (no API key in this environment) | pass |
| 18 | Email integration: unreachable SMTP rejected at connect time; working SMTP connected; email **actually delivered** to a local SMTP sink with merge fields and an unsubscribe link, status `sent` with provider message id | pass |
| 19 | Create a team, invite a member (link returned; `emailSent=false` because platform SMTP isn't configured) | pass |
| 20 | Plans, usage, settings change; checkout → honest **503** (no Stripe price linked) | pass |
| 21 | Admin panel with admin account; same endpoints **403** for a dispatcher; admin cannot read private pipeline (404) | pass |
| 22 | Cross-tenant read/write/download between dispatchers → 404 | pass |

Persistence checks (P1–P8): health, login, carriers and stage, customer/broker/load, document bytes (SHA-256 match), sequence/follow-up/team/sent-email history/theme setting, activity history, encrypted mailbox credential still decrypts.

## Defects found and fixed during testing

1. **Partial updates wiped columns:** `optStr`/`optInt`/… turned a *missing* field into `null`, so a PATCH cleared every column it didn't send. Fixed in `server/src/lib/validate.js`: missing stays `undefined`.
2. **Opportunities page crash:** a closed detail modal still evaluated its body and read `o.status` from undefined. Found by the Playwright smoke test and fixed in `client/src/components/deals/OpportunityModal.jsx`.
3. **Nested modal Escape:** Escape closed both nested dialogs. Fixed with a modal stack in `client/src/components/Modal.jsx`.
4. **Orphaned files:** deleting carriers left their documents on disk. They are now removed in single and bulk delete.
5. **Duplicate load math:** the AI load analysis used its own formulas. It now uses the canonical `services/loads/rateCalc.js`.
6. **Parallel test runs:** suites running at the same time shared one SQLite file. Each run now gets its own database directory.

## Not verified live (needs external credentials)

The adapters and error paths for these are implemented and unit-tested with mocks. They were not exercised against the real services:

- **AI:** OpenAI-compatible chat and embeddings. Needs `AI_API_KEY`.
- **AI web research:** Tavily or Brave. Needs `SEARCH_API_KEY`.
- **Gmail and Outlook OAuth sending.** Needs OAuth apps.
- **Stripe checkout, portal and live webhooks.** Needs test-mode keys and Price IDs.
- **Platform SMTP** for verification, reset and invite emails. Generic SMTP sending itself was verified end to end with the local sink.
- **FMCSA QCMobile.** Needs a webKey. The FMCSA Census was verified live.
