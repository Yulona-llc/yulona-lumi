# Phase 1 — Foundation (brief)

Goal: backend and frontend are **independently buildable, runnable and deployable**; secure by default; one-command local/prod bring-up.
Source of truth: `PLAN.md` (§3 rules, §7 DoD). ADR: `docs/adr/0001-stack-decisions.md`.

## Ownership (do not edit outside your area; ask lead via your final report)
| Agent | Owns |
|---|---|
| backend | `packages/shared`, `packages/db`, `apps/api`, `apps/worker` (stub only) |
| devops | `deploy/`, `.github/`, `apps/*/Dockerfile`, `apps/dashboard/nginx/`, root `README.md`, `docs/self-hosting.md` |
| dashboard | `apps/dashboard` (except Dockerfile + nginx/) |

Root `package.json`, `tsconfig.base.json`, `.gitignore` are owned by the lead; do not change them (report needed changes).

## Runtime topology
- `api`: Bun + Hono, listens on `PORT` (default 3000). Stateless. Env-validated at boot (Zod); refuses to start with weak/missing secrets in production.
- `dashboard`: static SPA (Vite build) in nginx-unprivileged, port 8080. Reads runtime config from `/config.js` (generated at container start from `API_URL`), so one image works in every environment.
- `postgres` (pgvector image), `redis` — in compose only; api works with Postgres alone in Phase 1 (Redis optional → used for rate limiting if `REDIS_URL` set, else in-memory limiter).
- A reverse proxy (Caddy) in prod compose terminates TLS and routes `/api/*` → api, everything else → dashboard. Dev/prod compose must also support running them on separate hosts (CORS via `CORS_ORIGINS` allowlist, credentials on).

## API contract (all JSON, prefix `/api/v1`, errors `{ "error": { "code": string, "message": string, "requestId": string, "details"?: unknown } }`)
All request bodies are Zod `.strict()`. Schemas live in `packages/shared/src/auth.ts` and are consumed by the dashboard for types.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/healthz` (no prefix) | none | liveness |
| GET | `/readyz` (no prefix) | none | checks DB (+Redis if configured) |
| POST | `/api/v1/auth/register` | none | body `{ email, password(min 12), name, workspaceName }` → creates tenant + owner user (only if `ALLOW_PUBLIC_SIGNUP=true`, else 403). Returns session (below) |
| POST | `/api/v1/auth/login` | none | `{ email, password }`; constant-time-ish, generic failure message, per-IP+email rate limit, lockout backoff |
| POST | `/api/v1/auth/refresh` | refresh cookie + CSRF header | rotates refresh token; reuse of a rotated token revokes the whole family |
| POST | `/api/v1/auth/logout` | refresh cookie + CSRF header | revokes family, clears cookie |
| GET | `/api/v1/me` | Bearer access JWT | `{ user, tenant }` |

Session response: `{ accessToken, expiresIn: 900, user: {id,email,name,role}, tenant: {id,name} }`. Refresh token is **only** in cookie `yl_rt` (httpOnly, Secure in prod, SameSite=Lax? → use `Strict` when same-origin, `None; Secure` only if `CROSS_SITE_COOKIES=true`; path `/api/v1/auth`). CSRF: double-submit — non-httpOnly cookie `yl_csrf` mirrored in `X-CSRF-Token` header on refresh/logout.
Access JWT claims: `sub`, `tid` (tenant), `role`, `iat`, `exp`, `jti`. `tenantId` is **never** read from bodies/params.

## Backend deliverables
1. `packages/shared`: Zod schemas + types (auth, error envelope, roles), `ChannelCapability`, `ConversionStage` + transition table (§3.4), `WidgetUISchema` + `ToolManifest` types (types/schemas only, versioned). Exported via `src/index.ts`, no build step (TS source consumed by workspace).
2. `packages/db`: SQL migrations (ordered, idempotent runner with `schema_migrations`), tables for Phase 1 = `tenants, users, refresh_tokens, audit_logs` (+ `CREATE EXTENSION vector`), `tenant_id NOT NULL REFERENCES tenants(id)`, RLS ENABLE+FORCE with policy on `current_setting('app.current_tenant_id', true)::uuid`, roles `yulona_owner`/`yulona_app` (no BYPASSRLS). `withTenant(tenantId, fn)` transaction helper using `set_config(..., true)`. `TenantRepository` base requiring tenantId. A narrowly-scoped, documented "pre-auth" path for login/register/refresh lookups (e.g. SECURITY DEFINER functions or a separate minimal repo) — no broad RLS bypass for the app role.
3. `apps/api`: Hono app, middleware order: request-id → secure headers → CORS allowlist → body size limit (e.g. 1 MB) → structured JSON logger with redaction (passwords, tokens, cookies, auth headers) → rate limiter (sliding window; Redis or memory) → tenancy resolver → routes → error handler (no stack traces to clients). Graceful shutdown (SIGTERM), `Bun.serve` tuned (idleTimeout), OpenAPI generated from Zod (`/api/v1/openapi.json`, disabled-by-flag in prod optional), multi-stage friendly (`bun build --target=bun` output to `dist/`), migrations runnable via `bun run migrate`.
4. Tests (`bun test`): auth flow, refresh rotation + reuse detection, rate limit, validation strictness, **RLS test helper** that connects as `yulona_app` and proves tenant A cannot read/write tenant B (rows invisible, insert with wrong tenant rejected, no GUC ⇒ zero rows). Tests need a Postgres: read `TEST_DATABASE_URL`; skip with a clear message if absent. Provide `docker compose -f deploy/docker-compose.dev.yml up -d postgres` as the way to get one (devops owns that file; use service `postgres` on host port 5433, db `yulona`, owner user `yulona_owner`/`yulona_owner`, app role `yulona_app`/`yulona_app` in dev only).
5. `apps/worker`: stub entrypoint that boots, logs, handles SIGTERM. No jobs yet.

## Devops deliverables
1. `apps/api/Dockerfile` (multi-stage, `oven/bun` slim/distroless-style, non-root, read-only-fs friendly, HEALTHCHECK, `bun install --frozen-lockfile --production`), `apps/dashboard/Dockerfile` (build with bun/vite → `nginxinc/nginx-unprivileged`, gzip/brotli-off-safe, immutable caching for hashed assets, `no-cache` for index.html, SPA fallback, strict CSP/HSTS/X-Frame-Options/Referrer-Policy/Permissions-Policy, runtime `config.js` from env via entrypoint script, non-root, HEALTHCHECK), `.dockerignore`s.
2. `deploy/docker-compose.dev.yml` (postgres pgvector on 5433, redis), `deploy/docker-compose.yml` (prod: caddy, api, dashboard, worker, postgres, redis; internal network, only caddy publishes 80/443; resource limits, `restart: unless-stopped`, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, healthchecks, migrate one-shot service), `deploy/Caddyfile`, `deploy/.env.example` (no real secrets; document each var), `deploy/setup.sh` (generates secrets with openssl, writes `.env` chmod 600, compose up, runs migrate, prints URL), `deploy/upgrade.sh` (pull/build, migrate, rolling restart, rollback hint). Also a split-deploy doc: api alone and dashboard alone (e.g. to different hosts).
3. `.github/workflows/ci.yml`: install --frozen-lockfile, typecheck, lint, test (postgres service), `bun audit`, docker build of both images (no push).
4. Root `README.md` (quickstart: dev in 3 commands; prod in 1) and `docs/self-hosting.md`.

## Dashboard deliverables
Vite + React + TS SPA, runs standalone with only the API URL (`window.__YULONA_CONFIG__.apiUrl` from `/config.js`, fallback `import.meta.env.VITE_API_URL`, fallback same-origin). Deps minimal (react, react-router, @tanstack/react-query, zod via `@yulona/shared`, tailwind). Pages: login, register (hidden if signup disabled — handle 403), authenticated shell with sidebar + placeholders (Inbox, Contacts, Agents, Settings) + `/me` profile. Access token **in memory only** (never localStorage); silent refresh via cookie + CSRF header on load and on 401; logout. Loading/error/empty states, a11y basics (labels, focus, contrast), code-split routes, small bundle (report size in final message). `bun run dev|build|typecheck|lint|test`. Use `frontend-design`/`ui-ux-pro-max` skills for a distinctive, clean look; reuse nothing from `../chatwoot`.

## Done when
`bun install && bun run typecheck && bun run test` pass at root; `docker compose -f deploy/docker-compose.yml config` validates; api and dashboard each start alone; each agent reports commands run + results honestly.
