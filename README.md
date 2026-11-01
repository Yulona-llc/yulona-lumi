# Lumi

AI-powered revenue conversion and customer interaction hub. Monorepo (bun workspaces): `apps/api` (Bun + Hono), `apps/worker`, `apps/dashboard` (React SPA), `packages/shared`, `packages/db`. See `PLAN.md` and `docs/`.

## Develop (3 commands)

```bash
bun install
docker compose -f deploy/docker-compose.dev.yml up -d postgres redis   # Postgres on :5433, Redis on :6380
bun run dev                                                            # api + dashboard
```

Tests: `TEST_DATABASE_URL=postgres://yulona_owner:yulona_owner@localhost:5433/yulona bun run test`
Dev credentials (dev compose only): owner `yulona_owner/yulona_owner`, app role `yulona_app/yulona_app`, db `yulona`.

## Deploy (1 command)

```bash
deploy/setup.sh app.example.com     # or no argument for https://localhost
```

Generates secrets into `deploy/.env` (mode 600), builds images, migrates, starts Caddy (TLS) + api + worker + dashboard + Postgres/pgvector + Redis. Only Caddy publishes ports. Upgrade with `deploy/upgrade.sh`.

Full guide (requirements, backups, split api/dashboard hosts, hardening notes): [`docs/self-hosting.md`](docs/self-hosting.md).

## Images

```bash
docker build -f apps/api/Dockerfile -t yulona/api .              # api, worker, migrate (different commands)
docker build -f apps/dashboard/Dockerfile -t yulona/dashboard .  # static SPA on unprivileged nginx
```
Build context is always the repo root.
