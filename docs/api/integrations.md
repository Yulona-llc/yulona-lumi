# Integrations API (outbound webhooks, public API, GDPR, retention, OpenAPI)

Base path `/api/v1`. Errors use the standard envelope `{ error: { code, message, requestId, details? } }`. Dashboard endpoints use the user JWT (`Authorization: Bearer <access token>`), **min role `admin`** unless noted. All bodies are strict (unknown keys => 400). `tenantId` never comes from a body or path.

Interactive reference: `/docs` (HTTP basic auth, `DOCS_USERNAME`/`DOCS_PASSWORD`). Machine-readable spec: `GET /api/v1/openapi.json` (same auth) or the committed `docs/openapi.json` (OpenAPI 3.0.3, imports cleanly into Postman/Insomnia; every operation has a unique `operationId`, tags and declared path params). Regenerate with `bun run --filter @yulona/api openapi:export [outfile] [serverUrl]`.

Required env: `ENCRYPTION_KEY` (base64, 32 bytes) for webhooks (secrets are sealed at rest; the API answers 503 without it, and the worker needs the same key). `S3_*` for GDPR exports in production (the in-memory storage used when `S3_BUCKET` is unset is per-process, so the API could not read what the worker wrote).

---
## 1. Outbound webhooks

### Events
`conversation.created`, `message.created` (contact/ai/human messages only; internal notes and system lines are never sent), `handoff.requested`, `contact.created`, `contact.updated` (name/email/phone/custom attributes/merge changed), `booking.created`, `ticket.created`, `ticket.updated`, plus `*` for all. `webhook.test` is sent by the test endpoint regardless of subscription.
Events are produced by **database triggers inside the writer's transaction**, so they exist if and only if the change committed, whichever component wrote it (API, AI worker, channels, ops). `booking.*`/`ticket.*` payloads are the row as camelCased JSON (columns that look like tokens/secrets are dropped). Re-run `SELECT webhooks_attach_optional_triggers()` (owner, idempotent) if those tables are created after migration 0500.
Code can also emit: `emitWebhookEvent(tx, tenantId, type, data)` from `@yulona/integrations`.

### Delivery
`POST <url>` with a JSON envelope:
```json
{ "id": "<event uuid>", "type": "message.created", "createdAt": "2026-01-01T10:00:00.000Z", "tenantId": "<uuid>", "data": { "message": { "id": "...", "conversationId": "...", "senderType": "contact", "content": "...", "createdAt": "..." } } }
```
Headers: `X-Yulona-Event`, `X-Yulona-Delivery` (delivery id), `X-Yulona-Timestamp` (unix seconds), `X-Yulona-Signature: v1=<hex>` where hex = `HMAC_SHA256(secret, "<timestamp>.<raw body>")`.
Verify on your side (constant-time compare, reject timestamps older than 5 min, de-duplicate on envelope `id`):
```js
const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from("v1=" + crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")));
```
(`verifyWebhookSignature` in `@yulona/integrations` does exactly this.)

- Success = any 2xx within 10 s. **Redirects are not followed.** Response body is kept only as a 2 KB snippet in the attempt log.
- Retries (at-least-once): 8 attempts, waits after failure N = 30 s, 2 min, 10 min, 1 h, 3 h, 12 h, 24 h. Each retry is a new `webhook.deliver` queue job with `run_at`. The same event id is reused on every attempt and on redeliveries.
- `410 Gone` disables the webhook immediately. After 10 consecutive deliveries that exhausted all attempts the webhook is auto-disabled (`disabledReason` set); re-enabling resets the counter.
- **SSRF**: URLs must be https in production (http allowed outside production), no credentials, no localhost/.local/.internal, no IP literals in private/link-local/loopback/CGNAT ranges. That is checked on save without DNS, and again on **every attempt** with DNS resolution (any non-public answer => permanent failure, no request sent). Residual DNS-rebinding window: run the worker behind an egress firewall that blocks private ranges.
- Delivery logs are purged after 30 days by default (`retention`).

### Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/webhooks/events` | `{ events: [...] }` |
| GET | `/webhooks` | `{ items: Webhook[] }` |
| POST | `/webhooks` | `{ name, url, events[], enabled? }` -> 201 `Webhook & { secret }` (`whsec_...`, shown **once**). Max 20 per tenant (409). |
| GET / PATCH / DELETE | `/webhooks/:id` | PATCH any of `name,url,events,enabled`. DELETE removes the delivery log too. |
| POST | `/webhooks/:id/rotate-secret` | `{ id, secret }` (new secret shown once; old one stops working immediately) |
| POST | `/webhooks/:id/test` | 202 `{ deliveryId }` (sends `webhook.test`) |
| GET | `/webhooks/:id/deliveries` | `status?`, `limit` (<=100), `cursor` -> `{ items: Delivery[], nextCursor }` |
| GET | `/webhook-deliveries/:id` | `Delivery & { payload, attemptLog: [{ attempt, statusCode, error, durationMs, responseSnippet, at }] }` |
| POST | `/webhook-deliveries/:id/redeliver` | 202 `{ deliveryId }`; clones payload + event id; 409 when the webhook is disabled |

`Webhook = { id, name, url, events, enabled, disabledReason, consecutiveFailures, lastSuccessAt, lastFailureAt, createdAt, updatedAt }`.
`Delivery = { id, webhookId, eventId, eventType, status: pending|retrying|succeeded|failed|cancelled, attempts, maxAttempts, nextAttemptAt, responseStatus, lastError, lastDurationMs, redeliveryOf, createdAt, completedAt }`.
Audit actions: `webhook.created|updated|deleted|secret_rotated|tested|redelivered`.

---
## 2. Public API (tenant API keys)

Base `/api/v1/public-api`. Auth: `Authorization: Bearer yl_<prefix>_<secret>` (create keys with `POST /api-keys`). Dashboard JWTs are rejected here and API keys are rejected on dashboard routes. Each key has `scopes` and a per-minute rate limit (`rateLimitPerMinute`, default 60; 429 + `Retry-After`). Scopes: `contacts:read|write`, `conversations:read|write`, `bookings:read|write` (`knowledge:*` exist but no public endpoint uses them yet). Writes are audit-logged with `actor_user_id = null` and `metadata.via = "public_api"`, `metadata.apiKeyId`.
Lists use keyset pagination: `limit` (1-100), `cursor` from `nextCursor`. Everything is tenant-scoped; another tenant's ids return 404.

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/contacts` | contacts:read | `q`, `limit`, `cursor` -> `{ items: Contact[], nextCursor }` (same `Contact` as the dashboard API) |
| POST | `/contacts` | contacts:write | `{ name?, email?, phone?, customAttributes? }` -> 201 |
| GET / PATCH | `/contacts/:id` | read / write | PATCH merges `customAttributes`; a key set to `null` is removed |
| GET | `/conversations` | conversations:read | `status`, `handler`, `contactId`, `limit`, `cursor` |
| POST | `/conversations` | conversations:write | `{ contactId, metadata? }` -> 201 (channel `widget`, `metadata.source = "api"`; counts against `monthly_conversations`, 402 when over plan) |
| GET | `/conversations/:id` | conversations:read | |
| GET | `/conversations/:id/messages` | conversations:read | `before` (message id), `limit`; customer-visible messages only (no notes/system) |
| POST | `/conversations/:id/messages` | conversations:write | `{ text, sender?: "agent"(default)\|"contact"\|"note", clientMessageId? }`. 201, or 200 when `clientMessageId` was already used (idempotent). `sender:"contact"` reopens a resolved conversation and queues `ai.respond` when the AI handles it. `agent` = shown as a human reply (does not take over). |
| GET | `/bookings` | bookings:read | `status`, `contactId`, `conversationId`, `from`, `to`, `limit`, `cursor` |
| POST | `/bookings` | bookings:write | same body as dashboard `POST /bookings` (`startAt`, `endAt` or `durationMinutes`, `title?`, `contactId?`, `conversationId?`, `attendeeEmail?`, `timezone?`, `notes?`). Uses the tenant's Google Calendar when connected (else a manual booking). 409 on overlap, 503 when the calendar is down. |
| GET | `/bookings/:id` | bookings:read | |
| POST | `/bookings/:id/cancel` | bookings:write | `{ reason? }`; 409 if already cancelled |

`Booking = { id, status, title, startAt, endAt, timezone, contactId, conversationId, attendeeEmail, notes, provider, eventUrl, cancelledAt, createdAt }`.

---
## 3. GDPR export / erasure

Async: requests are rows in `gdpr_requests` processed by worker jobs `gdpr.export` / `gdpr.erase` (3 attempts). At most 5 requests in progress per tenant (409).

| Method | Path | Notes |
|---|---|---|
| POST | `/gdpr/exports` | `{ contactId? }` -> 202 `GdprRequest`. With `contactId`: that contact (and contacts merged into it): contact, identities, conversations, all messages incl. internal notes, handoffs, AI lead state, widget sessions (ip/user agent) and tickets/bookings/transactions that reference it. Without: the whole workspace (adds users, agents, widgets, knowledge source metadata, webhooks, API key metadata, audit log; never password hashes, key hashes or secrets). Tables are capped at 100k rows each. |
| POST | `/gdpr/erasures` | `{ contactId, confirm: true }` -> 202. Irreversible. |
| GET | `/gdpr/requests` | `kind?`, `limit`, `cursor` |
| GET | `/gdpr/requests/:id` | `{ id, kind, contactId, status: queued\|processing\|completed\|failed, requestedBy, sizeBytes, result, error, downloadAvailable, expiresAt, createdAt, completedAt }` |
| GET | `/gdpr/requests/:id/download` | Export only, when completed and not expired (else 404). Returns `{ url, expiresAt }` (signed URL, 15 min) when the StorageProvider can presign (S3/MinIO), otherwise streams the JSON file through the API. `Cache-Control: no-store`. |

Export files expire after 7 days (the sweep deletes them from storage). Erasure **anonymises in place** (ids, timestamps and conversation structure stay so funnel metrics and FKs remain valid): contact name/email/phone cleared and `customAttributes = {"erased": true}`; identities deleted; every message in the contact's conversations (including notes) becomes `[erased]` with no `ui`/metadata; conversation previews/metadata, handoff summary/lead card/context, AI lead state, tool execution input/output/error and widget session ip/user agent/origin are cleared; earlier exports of that contact are deleted. Erasure emits no webhooks. Rows in `tickets`, `bookings`, `transactions` that reference the contact are **retained** (possible legal retention) and listed in `result.retained` for follow-up; whole-workspace exports taken before the erasure are not touched (they expire after 7 days). Audit: `gdpr.export.requested|completed|downloaded`, `gdpr.erasure.requested|completed`.

---
## 4. Retention

| Method | Path | Notes |
|---|---|---|
| GET | `/retention` | `{ messagesDays, auditLogsDays, webhookLogsDays, toolLogsDays, updatedAt, defaults }` |
| PUT | `/retention` | replaces all four (null = keep forever; webhook logs default to 30 days): `messagesDays` 7-3650, `auditLogsDays` 30-3650, `webhookLogsDays` 1-365, `toolLogsDays` 7-3650 |

The worker's hourly maintenance loop calls `retention_run_all` in bounded batches (5000 rows per table per tenant per round, repeated while full). Messages are deleted only from conversations whose last message is older than the cutoff, so live conversations keep their history. Pending/retrying webhook deliveries are never purged.

---
## 5. Operational notes
- Worker jobs: `webhook.deliver`, `gdpr.export`, `gdpr.erase` (registered in `apps/worker/src/jobs/integrations.ts`); retention + expired-export sweep run from `apps/worker/src/maintenance.ts`.
- Tables (migration 0500): `webhooks`, `webhook_deliveries`, `webhook_delivery_attempts`, `gdpr_requests`, `retention_policies`; all RLS ENABLE+FORCE with tenant and `owner_all` policies. SQL functions: `webhook_emit`, `gdpr_erase_contact` (hard-bound to the caller's tenant), `retention_run_all`, `gdpr_expired_exports`, `gdpr_expired_mark`, `webhooks_attach_optional_triggers`.
