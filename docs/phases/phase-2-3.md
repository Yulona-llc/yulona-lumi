# Waves plan + Wave 1 brief (Phases 2 & 3 backend + widget)

Inherits everything in `PLAN.md` and `docs/phases/phase-1.md`. Phase 1 is built and passing (auth, RLS, `withTenant`, `TenantRepository`, redacting logger, Hono app in `apps/api/src/app.ts`).

## Decisions taken for PLAN §9 (record in `docs/adr/0002-defaults.md`; user may override later)
1. Billing: Stripe behind a `BillingProvider` interface (stub provider when `STRIPE_SECRET_KEY` unset). 2. LLM + embeddings: OpenAI behind `LlmProvider`/`EmbeddingProvider` (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` default `gpt-4o-mini`, embeddings `text-embedding-3-small`, dim 1536); a deterministic `mock` provider for tests/dev with no key. 3. Calendar: Google first behind `CalendarProvider`. 4. DB: stay with `postgres` + SQL migrations (no ORM). 5. Email: `EmailProvider` interface, SMTP implementation + console provider for dev. 6. Storage: S3-compatible client (`S3_*` env; MinIO in self-host); ClamAV hook optional via `CLAMAV_URL`. 7. Landing stays separate. 8. **Redis is optional.** Job queue is Postgres-based (`jobs` table, `FOR UPDATE SKIP LOCKED`); WS fan-out uses Redis pub/sub when `REDIS_URL` set, else in-process (single instance).

## Shared rules for every agent in every wave
- Follow PLAN §3 and DoD §7: strict Zod bodies, tenant from auth context only, `withTenant` + repositories, RLS FORCE + policy + `(tenant_id, …)` indexes on every new tenant table, audit logs for sensitive ops, cross-tenant tests, OpenAPI registration, no secrets in logs.
- **Migrations**: new numbered files in `packages/db/migrations/` using ONLY your assigned range (below); never edit `0001_init.sql` or others' files. Must be idempotent-safe and grant to `yulona_app`.
- **Shared files** (`apps/api/src/app.ts` route registration, `packages/shared/src/index.ts` exports, `apps/api/src/config.ts`): other agents edit these concurrently. Make minimal, atomic `Edit`s (re-read the file right before editing, add one line/block, never rewrite the file). Put your own code in your own files/folders.
- Add dependencies only to your own package.json. Run `bun install` at repo root after; if the lockfile races, rerun. Never delete another agent's lines.
- Write a contract doc for your area at `docs/api/<area>.md` (endpoints, request/response shapes, events) — frontend agents in the next wave build from it.
- Tests: `bun test` with `TEST_DATABASE_URL` (owner URL). A dev Postgres is at `localhost:5433` (`yulona_owner`/`yulona_owner`, app role `yulona_app`/`yulona_app`, db `yulona`; may be in use by the lead—use your own DB name via `CREATE DATABASE yulona_<agent>` for tests and drop nothing of others'). Run typecheck + tests and fix failures. Final report < 400 words, honest: files, commands + real results, deviations, gaps.

## Agents and ownership (Wave 1)
| Agent | Owns | Migration range |
|---|---|---|
| `platform` | `packages/queue`, `apps/api/src/routes/{tenants,users,agents,api-keys,audit,flags}*`, `packages/providers` (LlmProvider/EmbeddingProvider/EmailProvider/StorageProvider/CalendarProvider/BillingProvider interfaces + mock + OpenAI + SMTP + S3 impls) | 0100–0199 |
| `airuntime` | `packages/ai-runtime`, knowledge routes `apps/api/src/routes/knowledge*`, `apps/worker/src/jobs/ingest*`, sandbox endpoint | 0200–0299 |
| `conversations` | contacts/conversations/messages/widgets/public-widget API routes, realtime (WS+SSE), `packages/channels` core (`ChannelAdapter`, `ChannelCapability` negotiation, `widget` adapter only) | 0300–0399 |
| `widgetui` | `apps/widget` | none |

### platform
1. **First (within your first steps, others depend on it):** `packages/queue` exporting `enqueue(db|tx, {name, tenantId, payload, runAt?, maxAttempts?})` and `startWorker(db, handlers, opts)` (poll + SKIP LOCKED, retry with exponential backoff, dead-letter status, graceful stop); `jobs` table (jobs are tenant rows: RLS; the worker claims via a narrow SECURITY DEFINER function). Also `packages/providers` interfaces + mock impls.
2. Tenant CRUD for super admin (`role=super_admin`, separate from tenant users; cannot read tenant data through normal API; suspend, soft-delete + 30-day hard-delete job), user/invitation management (roles owner/admin/agent/viewer), agent CRUD + `agent_versions` (publish/rollback), API keys (hash only, per-key rate limits, prefix shown once), audit log read API, feature flags + `plans`/`plan_limits` tables and a `checkLimit(tenant, metric)` helper, wire worker (`apps/worker`) to the queue and register jobs from other agents via `apps/worker/src/jobs/index.ts` (one line each).
3. Role-based authorization middleware (`requireRole`).

### airuntime
1. Knowledge sources: upload (multipart, size/type limits, magic-byte check, optional ClamAV hook) / URL / text; extract PDF/DOCX/TXT/HTML; chunk 500–1000 tokens with overlap; embed in batches; store in `knowledge_chunks` (vector(1536), HNSW index); status machine `pending→processing→ready|failed`, retries, delete cascade; crawl job for URL sources (SSRF-safe: block private/loopback/link-local IPs, redirects re-checked, size/time caps).
2. Retrieval: tenant-filtered vector search, top-K, similarity threshold per agent; **hallucination guard** (no chunk above threshold ⇒ fallback + `uncertainty` handoff).
3. Runtime `handleInboundMessage(...)` in `packages/ai-runtime`: message → retrieve → prompt builder (injects ONLY allowed actions for the current stage; prompt-injection hardening: user/KB text delimited as data) → LLM → output formatted per `ChannelCapability` as `WidgetUISchema` blocks. Stage state machine with auditable `stage_transitions`; ToolManifest executor (server-side, SSRF-safe, logged in `tool_executions`) with built-in `qualify_lead`, `collect_contact`, `escalate_to_human`; three handoff types producing structured output (lead card for stage handoff); on handoff set conversation `pending_human`, AI stops. Register worker job `ai.respond` (payload: tenantId, conversationId, messageId) that the conversations agent enqueues; define the exact function/DB contract in `docs/api/ai-runtime.md` and export the `ai.respond` handler from `packages/ai-runtime`.
4. Sandbox test console endpoint returning answer + retrieved chunks + scores + stage. Usage counters for LLM tokens.
5. Tests with the mock providers (deterministic): threshold fallback, stage-gated actions, tool failure ⇒ system_failure handoff, injection-resistance sanity, cross-tenant retrieval isolation.

### conversations
1. Tables: `contacts` (+ identities per channel), `conversations`, `messages`, `widgets`, `channel_connections` (encrypted credentials: AES-256-GCM envelope, key from `ENCRYPTION_KEY`), `widget_sessions`. Contact-centric timeline API.
2. Dashboard-facing endpoints (JWT): conversations list/filters/search/detail, send message (as human/ internal note), takeover / return-to-AI, contacts CRUD/merge/custom attributes/timeline, widget config CRUD + allowed domains + embed snippet.
3. Public widget API (PLAN §6.2, no JWT, `widget_key` → tenant): `GET /public/widget/config`, `POST /public/widget/conversations` (returns a session JWT scoped to conversation+tenant), history, send message (enqueues `ai.respond` via `@yulona/queue` from platform — code against the signature in this brief), ui-events (form/calendar/button submissions). Origin allowlist ⇒ 403, per-widget+IP rate limits, strict validation, bodies size-capped. Calendar slot data/booking UI events are routed but booking itself arrives in Wave 2.
4. Realtime: WebSocket endpoint (auth via session/access token in first message, not URL), SSE fallback for widget, Redis pub/sub fan-out when configured, typing + presence events, heartbeat/idle cleanup, per-connection limits.
5. `packages/channels` core: `ChannelAdapter` interface (`capabilities`, `verifyWebhook`, `parseInbound`, `send`), registry, `widget` adapter, capability-aware formatter helpers consumed by ai-runtime. Other channels come in Wave 3.
6. Tests: cross-tenant on every endpoint, origin allowlist, session-JWT scope, WS auth.

### widgetui
`apps/widget`: Vite library build → single `widget.js` (target < 40 kB gzip) with async loader snippet, Shadow DOM mount, `window.YulonaConfig`, runtime branding/config fetch, `WidgetUISchema` renderer (`message|form|calendar|buttons|card`, unknown types degrade gracefully, schema-versioned), pre-chat form, localStorage session, offline queue + retry, WS with SSE/poll fallback, typing indicator, WCAG 2.1 AA (focus trap, aria-live, keyboard, reduced motion), CSP-friendly (no inline eval, no unsafe styles outside shadow root), XSS-safe rendering (never innerHTML of message text; links sanitized). Build the public API client from `docs/api/conversations.md` as it appears; until then code against PLAN §6.2 and keep a mock server (`bun run dev` demo page with a fake backend). Provide `apps/widget/demo/index.html`. Dockerfile for widget static hosting is Wave 3 (devops) — only ensure `bun run build` works.

## Done when (Wave 1)
Root `bun run typecheck && bun run test` green with Postgres; `docs/api/*.md` written; each agent's report honest.
