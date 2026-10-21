# ADR 0001 — Phase 1 stack decisions

- **Monorepo:** bun workspaces (`apps/*`, `packages/*`).
- **DB access:** `postgres` (porsager) + raw SQL migrations. Chosen over Drizzle/Kysely because every request must run in a transaction that executes `set_config('app.current_tenant_id', $1, true)`; a thin driver makes that explicit and auditable. Tenant-scoped access goes only through `TenantRepository`.
- **Passwords:** `Bun.password` Argon2id. **JWT:** `hono/jwt` HS256 (access 15 min); refresh tokens opaque, hashed at rest, rotated, httpOnly cookie.
- **Deployment split:** `api` (Bun container) and `dashboard` (static assets served by unprivileged nginx) are independent images/services; they share nothing but the HTTP API. Dashboard calls API via `VITE_API_URL` or same-origin `/api` proxy.
- **Roles:** DB runs two roles — `yulona_owner` (migrations only) and `yulona_app` (no BYPASSRLS, used by api/worker).
