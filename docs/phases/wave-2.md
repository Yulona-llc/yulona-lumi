# Wave 2 brief (Phase 4 dashboard, Phase 5 ops backend, Phase 6 channels, Phase 7 billing/admin backend, integrations)

Inherits `PLAN.md`, `docs/phases/phase-1.md`, `docs/phases/phase-2-3.md` ("Shared rules" apply verbatim — read them). Wave 1 is integrated: root typecheck + 125 tests are green. API contracts to build against: `docs/api/{platform,ai-runtime,conversations}.md`. Worker jobs: register in `apps/worker/src/jobs/index.ts` (`buildJobHandlers(db)`; add ONE entry, minimal edit).

## Lessons from Wave 1 (do not repeat)
- Hono hoists a sub-router's `use("*")` onto everything registered after it → scope auth middleware to your own prefix.
- postgres.js: write JSON via `tx.json(obj)` or `::text::jsonb`, never `${JSON.stringify(x)}::jsonb` (stores a string).
- New tenant tables need RLS ENABLE+FORCE, tenant policy, and an `owner_all` policy (so the 30-day purge can delete them), plus grants to `yulona_app`.
- Tests: create your own database (`docker exec yulona-dev-postgres-1 psql -U yulona_owner -d postgres -c "CREATE DATABASE yulona_<agent>"`, then `CREATE EXTENSION vector` in it) and point `TEST_DATABASE_URL` at it (`postgres://yulona_owner:yulona_owner@localhost:5433/yulona_<agent>`). Never reuse the `yulona` or `yulona_lead` DBs. Drop your own DB at the end.
- Migrations are append-only; use your range only. A migration applied to a DB is never edited — add a new file.
- If vite/vitest crash with exit 137 (esbuild signature), copy `node_modules/@esbuild/darwin-arm64/bin/esbuild` over itself (`cp f f.tmp && mv f.tmp f`).
- The dashboard is a single Vite app: feature code goes in your own `apps/dashboard/src/features/<name>/` folder; routes register through ONE line each in `apps/dashboard/src/routes.tsx` (create it in the first minutes if it does not exist — whoever gets there first; re-read before editing). Reuse existing `ui.tsx` components and the API client in `src/api/client.ts` (extend via new files, small edits only). Lazy-load every route; keep initial bundle small.
- Dashboard tests mock fetch; also add `VITE_MOCK_API` coverage only if cheap.

## Agents
| Agent | Owns | Migrations |
|---|---|---|
| `dash-inbox` | `apps/dashboard/src/features/{inbox,contacts,realtime}` | none |
| `dash-agents` | `apps/dashboard/src/features/{agents,knowledge,widget-config,team,settings,audit}` | none |
| `ops-backend` | tickets, transactions, bookings, handoff queue, business hours, notifications (backend + worker jobs) | 0400–0499 |
| `integrations` | outbound webhooks, public API `/api/v1/public-api/*` (API-key auth), GDPR export/erasure, retention jobs, OpenAPI polish + `/docs` | 0500–0599 |
| `channels` | `packages/channels/*` adapters + connection routes + webhook receivers | 0600–0699 |
| `billing-admin` | Stripe/billing, plan enforcement, impersonation, platform analytics, system health (backend only) | 0700–0799 |

### dash-inbox (Phase 4 UI)
Inbox (list with status/handler/channel/assignee filters, search, cursor pagination, unread), conversation detail (message thread, contact side panel w/ stage + lead card, composer with canned responses, internal notes, send-as toggle, takeover / return-to-AI), realtime via `/api/v1/realtime/ws` (token in first frame, reconnect with backoff, optimistic send), contacts list/profile/timeline/merge/custom attributes. Loading/error/empty states, keyboard + a11y. Build against `docs/api/conversations.md`; canned responses/tags endpoints are built by `ops-backend` — document what you need in `docs/api/dashboard-needs.md` and stub with graceful fallback.

### dash-agents (Phase 4 UI)
Agent list/editor (persona, tone, languages, goals, stage rules, escalation rules, tools), versions + publish/rollback, knowledge sources (file upload with progress, URL/crawl config, text, status, chunk viewer, reingest, delete), **sandbox test console** (shows retrieved chunks, scores, stage, handoff), widget config (branding, domains allowlist, pre-chat, embed code, **live preview by embedding the built `apps/widget` bundle in an iframe/shadow container pointed at the draft config** — do not edit apps/widget; use its public mount API), team/invitations/roles, API keys, audit log table + filters, account settings. Build against `docs/api/{platform,ai-runtime,conversations}.md`.

### ops-backend (Phase 5)
Tickets (CRUD, kanban status, priority, assignee, SLA timers + breach job, `ticket_events` audit trail, bulk actions, link to contact/conversation), transactions (CRUD, filters, CSV export streaming, inbound webhook ingestion with HMAC verification), bookings + **Google Calendar** `CalendarProvider` impl (OAuth connect per tenant w/ encrypted tokens, availability, create/cancel; timeout ⇒ `system_failure` handoff with exponential backoff; use existing `markBookingOffered`/`markBooked` from `@yulona/ai-runtime` and a calendar tool in the ToolManifest registry), "Needs Attention" queue (three handoff types from the `handoffs` table; assign/claim/resolve), presence (agent online status) + typing already exist in realtime — add agent availability and business-hours routing (`business_hours` table, out-of-hours behavior), canned responses, tags/taggables, notifications table + email via `EmailProvider`. Write `docs/api/ops.md` EARLY (dash UI waves depend on it).

### integrations
Outbound webhooks (`webhooks`, `webhook_deliveries`; events from PLAN spec §4.11 as available: conversation.created, message.created, handoff.requested, booking.created, ticket.*, contact.updated; HMAC-SHA256 signature header + timestamp, retries w/ backoff via `@yulona/queue`, SSRF-safe delivery, delivery log + redeliver), public API for tenant API keys (list/create contacts, conversations, send message, bookings; per-key rate limits; scopes), GDPR export/erasure endpoints (async job, signed download via StorageProvider), retention jobs (messages/logs per tenant setting), OpenAPI spec completeness + interactive docs at `/docs` (already gated by `DOCS_PASSWORD`; keep it), plus Postman-compatible `docs/openapi.json` export script. Write `docs/api/integrations.md`.

### channels (Phase 6)
Adapters in `packages/channels`: WhatsApp (Cloud API, 24h window + template fallback), Messenger, Instagram, Telegram, Slack — each declares `ChannelCapability`, verifies webhook signatures (constant-time), parses inbound to the shared message shape, sends outbound (with retries via queue), contact identity resolution across channels (use `contact_identities`; merge suggestions). Routes: connection management CRUD (credentials encrypted with the existing `apps/api/src/conversations/crypto.ts` envelope helper, never returned to clients, masked), per-channel webhook receivers under `/api/v1/webhooks/channels/:channel/:connectionId` (public, signature-verified, replay-protected, rate-limited), outbound sender job `channel.send`, status/health check per connection. Use mock HTTP servers in tests. Write `docs/api/channels.md`.

### billing-admin (Phase 7 backend)
`BillingProvider` Stripe implementation (customers, checkout/portal sessions, webhook receiver w/ signature verification + idempotency, subscription → `tenants.plan_key` sync, grace period/warning states), plan-limit enforcement wired into API layer for seats, monthly conversations, storage, widgets (use `checkLimit`/`assertWithinLimit` from platform; add enforcement calls at the creation points owned by others via minimal edits, listing each touched file in your report), usage rollup job, super-admin: tenant detail/suspend/usage charts data, platform analytics (tenants, MRR-ish, conversations, funnel), system health (db/queue depth/worker heartbeat), **impersonation** (short-lived scoped token, `impersonator_id` claim, audit log both sides, banner flag in `/me`), audit log export (CSV/JSON). Write `docs/api/billing-admin.md` EARLY.

## Done when
Typecheck + tests green for your area with your own DB; docs written; honest final report (<400 words) listing files, commands + real results, shared files touched, gaps.
