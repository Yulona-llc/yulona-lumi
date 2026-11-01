# Lumi — Implementation Plan (handoff for the team-building session)

> Source of truth: the "Lumi Product Development Definition v1.0" (summarized below, section numbers `§` refer to it). If this plan and the spec disagree, the spec wins; flag the conflict.
> Status: **nothing built yet.** This repo contains only skills (`.claude/skills`, `.agents/skills`) and this plan.

## 0. What the next session should do

1. Read this file fully. Scaffold the monorepo (Phase 1) yourself or via a lead agent.
2. Create a team of agents (suggested roster in §6), each owning a package/area with the file-ownership boundaries in §6 so they don't collide.
3. Execute phases in order (§5). Each phase must end deployable + tested. Apply the Definition of Done (§7) to every feature.
4. Before starting each phase, write a short phase brief in `docs/phases/phase-N.md` (scope, API contracts, tables touched).

Open questions to confirm with the user before/while building (don't block Phase 1 on them): see §9.

## 1. Product summary

AI-powered revenue conversion + customer interaction hub. Aggregates conversations from channels (website widget first; then WhatsApp, Facebook, Instagram, Telegram, Slack). AI agents do lead qualification, calendar booking, and Q&A grounded in a tenant knowledge base; when uncertain they hand off to a human with full structured context.

Differentiators to protect in design: AI is primary responder (human = supervisor); widget is a declarative UI engine (`WidgetUISchema`); data is **contact-centric** (cross-channel timeline); output is funnel data (stage, bookings, conversion).

## 2. Fixed stack

| Layer | Choice |
|---|---|
| Runtime / API | Bun + Hono + TypeScript, Zod validation, OpenAPI generated from Zod |
| Frontend | React (dashboard SPA + embeddable widget in Shadow DOM) |
| DB | PostgreSQL + pgvector, RLS on all tenant tables |
| Cache/queue | Redis (rate limiting sliding window, job queue, pub/sub for WS fan-out) |
| Realtime | WebSocket (SSE fallback for widget) |
| Auth | JWT access (15 min) + httpOnly refresh cookie, Argon2id |
| Object storage | S3-compatible (MinIO self-hosted) |
| Deployment | Hosted multi-tenant SaaS + self-hosted single-tenant (Docker Compose) |

Suggested (decide in Phase 1, record in `docs/adr/`): bun workspaces monorepo; Drizzle or Kysely + raw SQL migrations (must support `SET LOCAL app.current_tenant_id` per transaction); BullMQ or a Redis-stream worker for ingestion/crawl; Vite for dashboard and widget; Vitest/bun:test; Playwright for e2e; LLM + embedding behind a provider interface (`AI_PROVIDER`, default OpenAI, embedding dim 1536).

### Proposed repo layout
```
apps/
  api/            # Bun + Hono server (routes, middleware, services)
  worker/         # background jobs: ingestion, crawl, re-crawl, reports, webhooks
  dashboard/      # React tenant + super-admin SPA
  widget/         # Embeddable widget (React in Shadow DOM) -> widget.js bundle
packages/
  shared/         # types, Zod schemas, WidgetUISchema, ToolManifest, ChannelCapability, stage machine
  db/             # migrations, RLS policies, TenantRepository base, seeds
  ai-runtime/     # retrieval, prompt builder, LLM provider iface, tool executor, handoff
  channels/       # adapters (widget, whatsapp, facebook, instagram, telegram, slack)
  config/         # tsconfig/eslint presets
deploy/           # docker-compose.yml, .env.example, setup.sh, upgrade.sh, Caddy/Nginx samples
docs/             # adr/, phases/, openapi, self-hosting guide
```

## 3. Non-negotiable architecture rules (encode in Phase 1)

1. **Three-layer tenant isolation (§3.1).**
   - L1: middleware resolves `tenantId` before any data access (dashboard JWT claim; widget `widget_key`; API key hash lookup) → `c.set('tenantId')`.
   - L2: `TenantRepository` base class requires `tenantId` in constructor; every query includes it; raw SQL without tenant condition is rejected (lint rule + test).
   - L3: Postgres RLS on every tenant table: `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)`; app DB role has no `BYPASSRLS`; each request runs in a transaction that sets the GUC via `set_config(..., true)`.
   - `tenant_id` immutable; **never read from request bodies**; reject unknown body fields (`.strict()`).
   - Super Admin cannot read tenant data via normal API; impersonation = short-lived scoped token + audit log + UI banner.
2. **ChannelCapability (§3.2)** — every adapter declares `{text, richCards, forms, fileUpload, typingIndicator, interactiveButtons, messageWindow}`; AI runtime formats output by capability (calendar component on widget vs numbered text on WhatsApp; respect 24h window).
3. **WidgetUISchema (§3.3)** — `message | form | calendar | buttons | card`; widget rendering is **config/schema-driven, never code-driven** (new UI types must degrade gracefully in old widget versions; widget fetches branding at runtime; version the schema).
4. **Conversion stage state machine (§3.4)** — `visitor → engaged → qualified → booking_offered → booked → handoff_requested`; explicit, auditable transitions stored as events; runtime injects *only the actions allowed in the current stage* into the system prompt. Emit funnel metrics.
5. **Tool manifest (§3.5)** — declarative `ToolManifest` (name, description, Zod in/out, authType, endpointTemplate, responseMapping); server-side execution only; every call logged (input, output, latency, success, conversation id); tool failure → system-failure handoff.
6. **Hallucination guard (§5.2)** — no chunks above similarity threshold ⇒ fallback + handoff, never answer from general knowledge.
7. **Handoff produces structured output (§5.4)** — three types (uncertainty / stage / system_failure); stage handoff includes a lead card (budget, need, timeline); conversation → `pending_human`, AI stops until a human returns it to AI.

## 4. Data model

Use the SQL in spec §8 as the baseline (tenants, users, agents, knowledge_sources, knowledge_chunks[vector(1536), ivfflat/hnsw], contacts, conversations, messages, tickets, transactions, bookings, widgets, channel_connections). Add (not in spec, needed):
- `refresh_tokens`, `api_keys` (hash only), `invitations`, `audit_logs`, `tool_executions`, `stage_transitions`, `agent_versions` (config history/rollback), `canned_responses`, `tags`/`taggables`, `webhooks` + `webhook_deliveries`, `notifications`, `plans`/`plan_limits`, `feature_flags`/`tenant_flag_overrides`, `ticket_events`, `contact_merges`, `business_hours`, `usage_counters`.
- `tenant_id NOT NULL REFERENCES tenants(id)` on **all** tenant tables (spec omits the FK on several — add it), indexes `(tenant_id, …)`, RLS enabled + forced, composite FKs where practical to prevent cross-tenant references.
- Encrypt `channel_connections.credentials` (app-level envelope encryption, key from env).
- Soft delete for tenants (30-day hard-delete job).

## 5. Phases (from spec §10) with concrete deliverables

Each phase = testable, deployable increment. Gate: DoD (§7) + cross-tenant tests green before moving on.

### Phase 1 — Foundation
Monorepo + TS configs + `packages/shared`; DB schema/migrations; tenancy middleware + RLS wiring + `TenantRepository`; auth (JWT, Argon2id, refresh rotation, CSRF); Hono app with health, error handler, structured logging (no secrets), request IDs; test harness incl. **RLS test helper** that runs as the non-bypass app role; CI (lint, typecheck, test, `bun audit`).

### Phase 2 — Agent core + knowledge
Tenant CRUD (super admin); agent CRUD + `agent_versions`; knowledge ingestion (upload→extract PDF/DOCX/TXT/HTML→chunk 500–1000 tok w/ overlap→embed→store; status transitions; retries; delete cascades); retrieval (tenant-filtered vector search, top-K, threshold); agent runtime (message→retrieve→LLM→respond / handoff); stage state machine; tool manifest system + `qualify_lead`, `collect_contact`, `escalate_to_human`; sandbox test console endpoint that returns retrieved chunks.

### Phase 3 — Widget + conversations
Widget bundle (async loader, Shadow DOM, `window.YulonaConfig`); `WidgetUISchema` renderer; public widget API (§6.2: config, start conversation→session JWT scoped to conversation+tenant, history, send message, ui-events); Origin allowlist (403); rate limits; messages/conversations storage; WebSocket delivery (Redis pub/sub for multi-instance); offline queue, localStorage session, a11y WCAG 2.1 AA, pre-chat form.

### Phase 4 — Dashboard
React shell/routing/auth; inbox (filters, detail, composer w/ canned responses + internal notes + send-as toggle, realtime, search); contacts list/profile/timeline/merge/custom attributes; agent config UI (editor, knowledge sources, crawl config, test console, tools, escalation rules, version history); widget config UI with live preview + embed code + domain allowlist.

### Phase 5 — Tickets, transactions, bookings, handoff
Tickets (kanban+table, SLA, audit trail, bulk actions); transactions (CRUD, filters, CSV export, webhook ingestion); bookings + calendar integration (Google Calendar first; timeout ⇒ system-failure handoff, exponential backoff); three-type handoff + "Needs Attention" queue; takeover / return-to-AI; presence; typing indicators; business hours.

### Phase 6 — Channels
Adapter framework + capability negotiation in AI output formatter; WhatsApp (24h window, template fallback), Messenger, Instagram, Telegram, Slack; webhook verification/signature checks per channel; connection management UI; contact identity resolution across channels.

### Phase 7 — Super Admin & billing
Super admin dashboard (tenants list/detail/suspend, usage charts, feature flags, platform analytics, system health); impersonation; plan limits enforced at API layer (seats, monthly conversations, storage, widgets) with grace/warning; billing (provider TBD — see §9); audit log UI + export.

### Phase 8 — Self-hosted & hardening
`deploy/docker-compose.yml` (yulona-app, postgres+pgvector, redis, optional minio); `.env.example`; `setup.sh` (generate secrets, compose up, migrate, create first tenant+admin, print URL/creds); `upgrade.sh`; single-tenant mode flags (`DEPLOYMENT_MODE`, `SUPER_ADMIN_ENABLED`, `AI_PROVIDER`, `AI_API_KEY`, `ALLOW_PUBLIC_SIGNUP`); offline signed-JWT license check + signed update manifest (no phone-home of tenant data); docs (requirements 2 vCPU/4 GB, reverse proxy w/ TLS, backups); security review (RLS suite, cross-tenant sweep over **every** endpoint, rate limits, validation, ClamAV hook for uploads); load testing.

Also cross-cutting, schedule alongside: webhooks (outbound events listed in §4.11, signed, retried), public API `/api/v1/*` with tenant API keys + per-key rate limits (§4.12), GDPR export/erasure endpoints, retention jobs, OpenAPI docs.

## 6. Suggested agent team and ownership

| Agent | Owns | Notes |
|---|---|---|
| `lead-architect` | `docs/adr`, `packages/shared`, phase briefs, review of every PR | Guards §3 rules; owns API contract doc |
| `backend-core` | `apps/api` middleware/auth/routes, `packages/db` | Tenancy, RLS, repos, auth |
| `ai-runtime` | `packages/ai-runtime`, `apps/worker` ingestion | Retrieval, prompts, stage machine, tools, handoff |
| `widget` | `apps/widget` | Shadow DOM, schema renderer, a11y, offline |
| `dashboard` | `apps/dashboard` | Use design skills below |
| `channels` | `packages/channels` | Phase 6 |
| `devops-security` | `deploy/`, CI, security tests | RLS/cross-tenant suite, self-host scripts |
| `qa` | e2e + cross-tenant sweep | Fails the phase gate |

Skills installed in `.claude/skills` (copied from `../gebeya-dala`): `frontend-design`, `ui-ux-pro-max`, `ui-styling`, `design-system`, `minimalist-ui`, `premium-frontend-ui`, `industrial-brutalist-ui`, `react-core`, `gsap-*` (core, timeline, react, plugins, scrolltrigger, performance), `a2ui-renderer` (declarative-UI rendering reference — relevant to WidgetUISchema), `copilotkit-*`, `runtime`, `runtime-debug`. Next.js/tRPC-specific ones (`trpc-tanstack-nextjs`, `dce-edge`, `react-vendoring`) were intentionally **not** kept since the stack is Bun/Hono/Vite. `skills-lock.json` was copied as-is; re-sync if desired. Plugin skills (Postman, MongoDB, Cloudflare) are user-level, not project-level — Postman skills may help with OpenAPI/contract tests.

Branding: a `yulona-landing` site exists at `../ai-bi/yulona-landing` — reuse its design tokens for the dashboard/widget defaults. `../chatwoot` is checked out locally and is the reference for inbox/handoff patterns (read-only inspiration).

## 7. Definition of Done (every feature)
1. Endpoint with Zod input validation (strict) + typed response.
2. All queries tenant-scoped and covered by RLS integration tests.
3. Cross-tenant access test (403/404) exists and passes.
4. Dashboard UI with loading/error/empty states.
5. Audit log entry for sensitive operations.
6. Unit tests (services) + integration test (full request path).
7. OpenAPI updated.
8. Feature-flag/plan gating if plan-dependent.

## 8. Key risks → mitigations (spec §11)
Cross-tenant leak (3 layers + automated sweep); hallucination (threshold + handoff + sandbox); ingestion failure (retries + status + notify); widget breaking host (Shadow DOM, async, CSP-friendly); self-host setup failure (one-command + tested upgrade); plan limit gaps (API-layer enforcement); channel window limits (capability-aware formatter); calendar timeout (timeout ⇒ handoff, backoff).

## 9. Open questions for the user
1. Billing provider (Stripe?) and plan tiers/limits.
2. Default LLM + embedding provider/model, and whether Lumi-hosted key proxying/metering is needed.
3. Calendar provider(s): Google only first, or Outlook/Cal.com too?
4. ORM/query-builder preference (Drizzle vs Kysely) given RLS-per-transaction requirement.
5. Email provider for invitations/notifications/reports.
6. Object storage + virus scanning for hosted mode.
7. Should the existing `../ai-bi/yulona-landing` become `apps/landing` here, or stay separate?
8. Next artifacts offered by the spec: exact API contract doc (§4.12 endpoints) and the `WidgetUISchema` + `ToolManifest` TS package — recommend producing both first thing in Phase 1 (`packages/shared`).
