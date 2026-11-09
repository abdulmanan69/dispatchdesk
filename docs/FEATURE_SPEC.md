# DispatchDesk — Feature Specification

Original implementation of a dispatching + sales CRM, inspired by the public functionality of selldispatch.com.
No proprietary code, branding or assets are reused. Product name used here: **DispatchDesk**.

## Research summary (public pages of the reference)

Research tooling: no "REA" tool exists in this IDE environment. Public pages were inspected with WebFetch/WebSearch instead.
Authenticated application screens of the reference are not publicly accessible; app flows were inferred from public copy.

| Reference page | Findings |
|---|---|
| `/` | Hero, "One system" pitch: Carrier Leads, Sequence, Pipeline Management. Ticker: automated email sequences, training, AI agents, tool marketplace, recorded videos. 9-step "start here" guide (learn → find carrier → load board → negotiate → carrier packet → rate con → pickup → deliver → get paid). Ask box (AI). |
| `/landing` (plans) | Free (indefinite, open list sizes), Pro $9.99/mo, Annual $95.90/yr (20% off + 4 weeks 1:1 training), Teams $7.99/user/mo (2+ users, 14-day trial), Company $30/mo + $7.99/seat. Stripe card payments. Pro features: dialer integration, mailbox, leads, AI, spot rate, diesel prices, maps, broker bulk email, sequences & follow-ups. Modules: Enrich, Find, Call, Keep, Sequence, Opportunities, Customers. |
| `/teams` | Shared team board (each person keeps own pipeline). Columns: Dials, Downloaded, In touch, Follow-ups, Opportunities, Trials, Customers. Leaderboard with Team / Just me toggle. Roles: Owner, Dispatcher. Flow: import → carrier list → prospecting / hot leads → sequence → opportunity → customer. |
| `/training` | Program: weeks 1–2 live class (rules, trucks, sales call), weeks 3–4 supervised dialing. Book-your-slot form (name, email, phone). Downloadable manual + cold-call script. Trainer messaging inside app. |
| `/marketplace` | Public. Tabs: All, Services, Tools, Training, Hiring, People. "Post an ad" free. Buyers message sellers via Inbox. |
| `/community` | Public discussion feed. |

## Pipeline

`All Leads → Prospecting → Sequence → Opportunities → Trials → Customers → Archived`

## Modules (implemented)

See `docs/CHECKLIST.md` for the live implementation status of every module.

1. Public site: home, features, pricing, training (+ request form), marketplace browse, community read, login/register/forgot/reset/verify.
2. Auth: bcrypt hashing, DB-backed sessions in HTTP-only cookies, CSRF double-submit token, email verification, password reset, session list/revoke, rate limiting.
3. RBAC: Roles + Permissions tables (super_admin, admin, team_manager, dispatcher, user), enforced by backend middleware. Team roles: owner, manager, dispatcher.
4. Dashboard: all KPIs + charts computed from DB.
5. Carrier leads: manual CRUD, CSV import/export, duplicate detection (DOT/MC/phone), live FMCSA Census discovery (data.transportation.gov, no key), optional FMCSA QCMobile enrichment (webKey), provider adapter interface.
6. CRM: carrier profile (contacts, notes, tags, calls, emails, follow-ups, documents, activities, stage, assignee), board + table pipeline, bulk actions.
7. Prospecting: prospect lists, daily call queue with priority + local time + business-hours flag, call outcomes, auto next step.
8. Sequences: configurable call/email/task steps with day offsets, business hours, skip weekends, per-day caps, opt-out aware.
9. Email: SMTP (incl. Hostinger presets), Gmail OAuth, Outlook OAuth adapters; encrypted credentials; templates, signatures, drafts, scheduled sends, retries, daily limits, cooldown, suppression list, unsubscribe links. Status "sent" only after provider acceptance.
10. Opportunities / Customers / Documents (agreement, MC authority, W-9, COI, permits…).
11. Brokers + Loads: rate-per-mile calculator (deadhead, fuel, detention, profit), load-board text parser, lane history.
12. AI Dispatcher: OpenAI-compatible chat, history, RAG over approved knowledge docs, optional web search (Tavily/Brave) with sources + dates, email drafts, call scripts, objection handling, load analysis. Per-user context isolation.
13. Training center: courses, lessons (video/markdown/PDF), progress, trainer messaging, training requests, admin management.
14. Marketplace: listings CRUD, categories, search, contact seller inbox, reporting + moderation.
15. Community: posts, comments, replies, categories, search, profiles, reporting + moderation.
16. Teams: create, invite (email token), accept, roles, permissions, activity, leaderboard, settings.
17. Billing: configurable plans + limits, Stripe Checkout (test mode), billing portal, cancel, webhook-driven status, payments/invoices.
18. Admin: stats, users, subscriptions, moderation, training, system/API/email/AI config, audit logs.
19. Settings: profile, avatar, security, theme, notifications, mailboxes, integrations, data export, account deletion.
