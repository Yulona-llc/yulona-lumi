# Platform API contract

Base: `/api/v1`. JSON only, request bodies are strict (unknown fields => 400). Errors: `{ "error": { code, message, requestId, details? } }`. Tenant is always derived from the access JWT, never from body/path/query. New error codes: `plan_limit_exceeded` (HTTP 402, `details: {metric, limit, used}`), `tenant_suspended`. Roles: `owner > admin > agent > viewer`. "min role" = that role or higher. Machine-readable spec: `/api/v1/openapi.json`.

## Tenant (any authenticated role unless noted)
- `GET /tenant` -> `{ id, name, status, plan: {key,name}, limits: [{metric, limit|null, used, warning}] }` (`warning` = usage >= 80%).
- `PATCH /tenant` (admin) `{ name }` -> `{ id, name }`.

## Users and invitations
- `GET /users` -> `{ items: [{ id, email, name, role, status: "active"|"disabled", lastLoginAt, createdAt }] }`.
- `PATCH /users/:id` (admin) `{ name?, role?, status? }` (>=1 field). Rules: you cannot change your own role/status; non-owners cannot touch users of equal/higher role or grant a higher role; a workspace must keep one active owner (409); disabling revokes the user's refresh tokens. 404 for other tenants' users.
- `GET /invitations` (admin) -> `{ items: [{ id, email, role, status: pending|accepted|revoked|expired, expiresAt, createdAt, invitedBy }] }`.
- `POST /invitations` (admin) `{ email, role }` -> 201 `{ id, email, role, expiresAt, emailSent, inviteUrl? }`. `inviteUrl` only when `NODE_ENV != production`. Cannot invite a role above your own; counts against the `seats` limit (402). Email link: `${APP_URL}/accept-invite?token=<token>` (valid 7 days).
- `DELETE /invitations/:id` (admin) revokes a pending invitation.
- `POST /invitations/accept` (public, rate limited) `{ token, name, password(min 12) }` -> 201 `{ ok: true, role }`. The client then logs in normally. 400 invalid/used/expired token, 409 email already has an account.

## Agents
`config` (see `agentConfigSchema` in `@yulona/shared`): `{ systemPrompt, similarityThreshold 0..1 (schema default 0.15) and topK 1..20 (5), both deprecated and ignored by the skills model, fallbackMessage, greeting?, model?, temperature?, enabledTools: string[] (default qualify_lead, collect_contact, escalate_to_human), customTools: ToolManifest[], escalationRules: { keywords[], maxUnansweredTurns } }`; defaults are filled in on write.
Agent object: `{ id, name, description, status: draft|published|archived, config, publishedVersion|null, createdAt, updatedAt }`.
- `GET /agents`, `GET /agents/:id` (any role).
- `POST /agents` (admin) `{ name, description?, config? }` -> 201; `agents` plan limit (402).
- `PATCH /agents/:id` (admin) `{ name?, description?, config? }` edits the **draft** only (409 if archived).
- `POST /agents/:id/publish` (admin) `{ note? }` -> agent + `version`. Snapshots the draft as the next immutable version.
- `POST /agents/:id/rollback` (admin) `{ version, note? }` -> republishes that version's config as a NEW version.
- `GET /agents/:id/versions` -> `{ items: [{ version, note, createdBy, createdAt }] }` (newest first).
- `DELETE /agents/:id` (admin) archives; `POST /agents/:id/unarchive` (admin).
Runtime reads: `published_version` not null => `agent_versions.config` for `(agent_id, published_version)`; else `agents.config` (draft, sandbox only).

## API keys (admin)
- `POST /api-keys` `{ name, scopes?: [conversations:read|write, contacts:read|write, knowledge:read|write], rateLimitPerMinute? (60), expiresAt? }` -> 201 `{ id, name, prefix, scopes, rateLimitPerMinute, expiresAt, ..., key }`. **`key` is returned only here.** `api_keys` limit (402).
- `GET /api-keys` (no secret), `DELETE /api-keys/:id` (revoke).
- Using a key: `Authorization: Bearer yl_...`. `GET /key-info` -> `{ id, name, scopes, tenantId }`. 401 invalid/revoked/expired, 429 over the key's per-minute limit. In code: `requireApiKey(db, limiter)` + `requireScope(scope)` from `apps/api/src/routes/api-keys.ts` (sets `auth` with `role: "agent"`, `userId` = key id, and `apiKey`).

## Audit logs (admin)
`GET /audit-logs?action&actorUserId&resourceType&resourceId&from&to&limit(<=200, 50)&cursor` -> `{ items: [{ id, actorUserId, action, resourceType, resourceId, metadata, ip, requestId, createdAt }], nextCursor|null }` newest first (keyset). Actions written by platform: `user.updated`, `invitation.created|revoked|accepted`, `agent.created|updated|published|rolled_back|archived|unarchived`, `api_key.created|revoked`, `tenant.renamed`, `tenant.status.*`, `tenant.updated_by_platform`.

## Feature flags
- `GET /feature-flags` -> `{ flags: { [key]: boolean } }` (override ?? default). Server helper: `isFeatureEnabled(tx, tenantId, key)` (`routes/flags.ts`).

## Super admin (`/api/v1/admin/*`, separate token realm; disabled when `SUPER_ADMIN_ENABLED=false`)
- `POST /admin/auth/login` `{ email, password }` -> `{ accessToken, expiresIn: 900, admin }` (no refresh; log in again). `GET /admin/auth/me`.
- `GET /admin/tenants?q&limit&offset` -> `{ items: [{ id, name, status, plan, deletedAt, createdAt, userCount }], total }`; `GET /admin/tenants/:id`.
- `POST /admin/tenants` `{ name, plan?: "free", ownerEmail, ownerName, ownerPassword }` -> 201 `{ id, ownerUserId }`.
- `PATCH /admin/tenants/:id` `{ name?, plan? }`; `POST /admin/tenants/:id/suspend|unsuspend|restore`; `DELETE /admin/tenants/:id` (soft delete; hard delete after 30 days; restore 409 after grace).
- `GET /admin/plans`; `PUT /admin/plans/:key/limits/:metric` `{ limit: int|null }`.
- `GET /admin/feature-flags`; `PUT|DELETE /admin/feature-flags/:key` (`{ description?, defaultEnabled }`); `GET /admin/tenants/:id/flags`; `PUT /admin/tenants/:id/flags/:key` `{ enabled: bool|null }` (null clears the override).
- `GET /admin/audit-logs?limit&offset` platform audit trail.
Super admins have no route into tenant data (their token fails tenant auth).

## Helpers for other agents
- `@yulona/queue`: `enqueue(dbOrTx, {name, tenantId, payload?, runAt?, maxAttempts?})`, `startWorker(db, handlers, opts)`, `FatalJobError`. Handler: `(payload, { job, db, log, withTenant }) => Promise<void>`. Register in `apps/worker/src/jobs/index.ts` (`...yourHandlers`). Jobs retry with exponential backoff (1s base, +-20% jitter, 1h cap), then `dead`. Finished jobs are pruned after 7 days.
- `@yulona/providers`: `createProvidersFromEnv()`, `createMockProviders()`; see ADR 0002 for env vars. `createApp({..., providers})` accepts an injected set.
- `apps/api/src/platform/authz.ts`: `requireRole(...roles)`, `requireMinRole(min)` (after `requireAuth`).
- `apps/api/src/platform/limits.ts`: `checkLimit(dbOrTx, tenantId, metric, inc=1)` -> `{limit|null, used, remaining, allowed, warning}`; `assertWithinLimit(...)` throws 402; `incrementUsage(dbOrTx, tenantId, metric, delta)` for `widgets`, `storage_mb`, `monthly_conversations`, `llm_tokens_monthly`. Metrics: seats, agents, widgets, api_keys, monthly_conversations, storage_mb, llm_tokens_monthly.
- Middleware gotcha: Hono hoists a sub-router's `use("*")` onto everything registered after it under the same prefix; platform routers therefore scope auth to their own prefixes (`/agents/*`, ...). Do the same.
- New tenant tables must also add an `owner_all` RLS policy (as in 0001) so the tenant hard-delete purge works.

## Tables (migrations 0100, 0101)
`jobs`, `plans`, `plan_limits`, `usage_counters`, `feature_flags`, `tenant_flag_overrides`, `invitations`, `agents`, `agent_versions`, `api_keys`, `platform_admins`, `platform_audit_logs`; `tenants.plan_key`; `users.role` now allows `viewer`.
