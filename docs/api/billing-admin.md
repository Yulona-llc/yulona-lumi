# Billing, plan enforcement, super-admin ops API contract (Phase 7 backend)

Base `/api/v1`. Same conventions as `platform.md` (strict bodies, error envelope, tenant from JWT only). Migration range 0700-0799 (`0700_billing_admin.sql`).

## Tenant billing (JWT; `owner` unless noted)
- `GET /billing` (admin+) ->
  `{ provider: "stripe"|"stub", plan: {key,name}, state: "ok"|"warning"|"grace"|"restricted"|"canceled", subscription: { status: "none"|"active"|"trialing"|"past_due"|"canceled", currentPeriodEnd|null, graceUntil|null, cancelAtPeriodEnd }, limits: [{metric, limit|null, used, warning}], checkoutPlans: ["pro", ...] }`.
  `state`: `warning` = any limit >= 80%; `grace` = payment failed, within the grace window (7 days) — plan still active; `restricted` = grace expired (plan is downgraded to `free` by the billing job); `canceled` = subscription ended.
- `POST /billing/checkout` `{ plan }` -> `{ url }` (redirect the browser). Creates the provider customer on first use. `plan` must be a paid plan (`pro`; 400 otherwise).
- `POST /billing/portal` -> `{ url }` (409 if no customer yet).
- `POST /billing/cancel` -> `{ ok: true }` cancels the subscription (409 if none). Plan falls back to `free` when the provider confirms.
- `GET /usage?days=30` (any role) -> `{ limits: [...same as /tenant], series: [{ day: "YYYY-MM-DD", metric, value }] }` from the daily rollup (`conversations`, `messages`, `llm_tokens`, `new_contacts`).
- `GET /audit-logs/export?format=csv|json&from&to` (admin+) -> attachment, up to 50k rows, newest first. CSV columns: `id,createdAt,actorUserId,action,resourceType,resourceId,ip,requestId,metadata`. Cells starting with `= + - @` are prefixed with `'` (CSV-injection safe). The export itself is audited as `audit.exported`.

## Billing webhook (public)
`POST /webhooks/billing` raw body, provider signature header (`Stripe-Signature`). Signature verified (HMAC-SHA256, 5 min tolerance); invalid -> 400. Idempotent by provider event id (duplicates return `{ ok: true, duplicate: true }`). Handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed|payment_succeeded`. Effects: syncs `tenants.plan_key`, writes `billing_customers`, starts/clears grace, audit log `billing.*` on the tenant. Stub provider (no `STRIPE_SECRET_KEY`) accepts unsigned JSON in non-production only (404 in production).
Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` (price id per plan: `STRIPE_PRICE_<PLAN>`), `BILLING_GRACE_DAYS` (7).

## Plan enforcement (402 `plan_limit_exceeded`, `details: {metric, limit, used}`)
seats (invitations, reactivation; platform), agents, api_keys (platform), **widgets** (`POST /widgets`), **monthly_conversations** (`POST /public/widget/conversations`), **storage_mb** (knowledge source create). `widgets`, `monthly_conversations`, `storage_mb` are computed live from source tables in `checkLimit` and combined with any `incrementUsage` counter via `GREATEST` (no drift, counters still honoured). Sub-MB knowledge sources are only blocked once storage is already over the limit.

## Super admin (token realm `/admin/auth/login`; all under `/admin`)
- `GET /admin/tenants/:id/detail` -> `{ tenant, billing, limits, counts: {users, agents, widgets, contacts, conversations, knowledgeSources}, lastActivityAt }`.
- `GET /admin/tenants/:id/usage?days=30` -> `{ series: [{day, metric, value}], limits }` chart data.
- `GET /admin/analytics` -> `{ tenants: {total, active, suspended, deleted, new30d}, byPlan: [{plan, count}], mrrCents, conversations: {last30d, perDay: [{day,count}]}, funnel: [{stage, conversations}] }`. `mrrCents` = sum of `plan_prices.monthly_cents` over active paid tenants (estimate, not accounting).
- `GET /admin/health` -> `{ status: "ok"|"degraded"|"down", db: {ok, latencyMs}, queue: {queued, running, dead, oldestQueuedAgeSec|null}, worker: {lastHeartbeatAt|null, ageSec|null, ok} }`. Worker heartbeats every 30 s; `ok` when age < 120 s. `degraded` when the worker is stale or dead jobs exist.
- `POST /admin/tenants/:id/impersonate` `{ reason(5..500), userId? }` -> `{ accessToken, expiresIn: 900, sessionId, user, tenant }`. Defaults to the tenant's oldest active owner; the token role is capped at `admin`. Claims: normal access claims plus `imp` (platform admin id) and `ims` (session id). Not allowed for suspended/deleted tenants (409). Audited in both `platform_audit_logs` (`impersonation.start`) and the tenant `audit_logs` (`impersonation.started`); every tenant audit entry written by `audit()` during the session carries `metadata.impersonatorId`. The token cannot be exchanged for a refresh token and cannot change roles/owner (role cap) or manage billing (owner only).
- `POST /admin/impersonation/:sessionId/end` -> `{ ok: true }` (audited both sides; tokens are short-lived and also expire on their own).
- `GET /admin/audit-logs/export?format=csv|json` platform audit trail export (up to 50k rows).
- (platform.md) tenant list/create/suspend, plan limits, flags.

`GET /me` gains `impersonation: { active: true, impersonatorId, sessionId } | null` — the dashboard shows a banner when non-null.

## Tables (0700)
`billing_customers`, `billing_events` (processed webhook ids), `plan_prices`, `usage_daily`, `impersonation_sessions`, `worker_heartbeats`; definer functions `billing_*`, `sa_*`, `usage_rollup`.

## Worker
`apps/worker/src/billing.ts` — every 30 s heartbeat; hourly: usage rollup (yesterday + today) and grace expiry (downgrade to `free`).
