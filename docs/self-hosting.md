# Self-hosting Yulona

## Requirements
- Linux host, 2 vCPU / 4 GB RAM / 20 GB disk minimum.
- Docker Engine 24+ with Compose v2, `openssl`, `git`.
- A DNS A/AAAA record pointing to the host and ports 80/443 open (for automatic HTTPS).

## Install
```bash
git clone <repo> yulona && cd yulona
deploy/setup.sh app.example.com --email you@example.com --workspace "Acme"
```
`setup.sh` refuses to overwrite an existing `deploy/.env`. It generates every secret (`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`), builds the images, starts Postgres/Redis (Postgres creates the `yulona_app` role from `APP_DB_PASSWORD` at first start; no initdb bind-mount tricks needed beyond the bundled script), runs the `migrate` one-shot, creates the first tenant and admin with the `create-tenant` one-shot, starts everything, waits for health and **prints the admin password once**. Every variable is documented in `deploy/.env.example`.

Without a domain use `deploy/setup.sh` (https://localhost, local CA) or `deploy/setup.sh :80` (plain HTTP; only on a trusted network).

Add more tenants/admins later (self-hosted mode is intended for one): `docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm create-tenant --workspace Acme --email a@b.com`.

## Deployment modes
`DEPLOYMENT_MODE` (compose default `selfhosted`; API default `saas`):

| | `selfhosted` | `saas` |
|---|---|---|
| Tenants | one, created by `create-tenant` | many |
| `/auth/register` | always closed | open if `ALLOW_PUBLIC_SIGNUP=true` |
| Billing routes (`/api/v1/billing*`, Stripe webhook) | not mounted | mounted |
| Super-admin routes (`/api/v1/admin/*`) | not mounted unless `SUPER_ADMIN_ENABLED=true` | mounted unless `SUPER_ADMIN_ENABLED=false` |
| Plan | `self_hosted` (no limits) | `free`/`pro`/... |

Knowledge needs no embedding model or extra API key: each source becomes a skill (description + titled sections) that the agent reads and keyword-searches in Postgres.

AI: `AI_PROVIDER=openai|deepseek|mock` + `AI_API_KEY` (+ `AI_BASE_URL`, `AI_MODEL` for OpenAI-compatible servers). With no key the offline `mock` provider answers (demo only).

## Optional services
Enable with `COMPOSE_PROFILES=minio,clamav` in `deploy/.env`.
- **minio**: S3-compatible storage on the internal network (bucket auto-created). Point `S3_ENDPOINT=http://minio:9000`, `S3_BUCKET=yulona`, `S3_ACCESS_KEY_ID=$MINIO_ROOT_USER`, `S3_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD`. Without any S3 settings uploads/exports are held in memory (not durable): configure storage for real use.
- **clamav**: clamd + an HTTP wrapper; set `CLAMAV_URL=http://clamav:3000`. Uploads are scanned before ingestion. clamd needs about 1.5-2 GB RAM on top of the base requirement.

## Widget bundle
The dashboard nginx image also serves the embeddable widget: `/widget.js` (stable name, `max-age=300`, so releases reach customer sites within minutes) and `/widget.<hash>.js` (content hash, `immutable`; the hash is in `/widget.version`, for customers who want to pin). Trade-off vs a separate `widget` image/CDN: bundling keeps one image + same origin for the preview and no extra service, but widget releases are coupled to dashboard releases and traffic from customer sites hits the dashboard container. If you expect heavy embed traffic, put a CDN in front of `/widget*.js` (the files are static and cache-friendly) or serve them from your own bucket and set `WIDGET_SCRIPT_URL`.
The dashboard's live preview iframes `/widget-preview.html` (same origin, own CSP with `frame-ancestors 'self'`; every other dashboard page stays `X-Frame-Options: DENY`). The widget's allowed-domains list must include the dashboard origin for the preview to connect.

## License (optional, offline)
`LICENSE_KEY` is an Ed25519-signed JWT (`customer`, `seats`, `features`, `exp`); `LICENSE_PUBLIC_KEY` (PEM) is the vendor public key. The API verifies it locally at boot and logs the state; nothing is sent anywhere. Verify a key on any machine: `bun packages/license/src/cli.ts verify <token|file> --pub vendor.pem`; signed update manifests: `... manifest manifest.json --pub vendor.pem`. An expired/invalid license degrades to community defaults, it never blocks access to your data.

## Security model
- Only Caddy publishes ports. Postgres and Redis sit on an `internal` network with no egress and no host exposure; Redis requires a password.
- Every container: `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem (+ tmpfs `/tmp`). Exceptions, minimal and intentional: Caddy adds `NET_BIND_SERVICE`; Postgres/Redis add the chown/setuid caps their entrypoints need to prepare data volumes and drop privileges.
- api/worker/dashboard run as non-root; the api image contains only a bundled `dist/` and SQL migrations (no source, no secrets).
- The app DB role `yulona_app` has no `BYPASSRLS`; only the one-shot `migrate` service holds the owner credentials.
- Secrets live only in `deploy/.env` (chmod 600) and are injected at runtime. Never bake them into images or commit them.
- Set `ALLOW_PUBLIC_SIGNUP=false` unless you want open registration.

## Operate
```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f api
curl https://app.example.com/readyz
```
**Upgrade:** `deploy/upgrade.sh` (pre-upgrade `pg_dump`, pulls/builds, migrates, restarts service by service, prints rollback steps; a failed migration leaves the running services untouched). Use `--no-git` when deploying registry images (`YULONA_API_IMAGE` / `YULONA_DASHBOARD_IMAGE` in `.env`).

**Backup:** `deploy/backup.sh` writes `deploy/backups/yulona-<ts>.sql.gz` (verified with `gzip -t`, keeps the newest 14). Cron it (`17 3 * * * /opt/yulona/deploy/backup.sh`) and copy files off-host. Also back up `deploy/.env` (**`ENCRYPTION_KEY` is required to read stored channel/OAuth credentials**) and your S3/MinIO bucket.
**Restore:** `deploy/restore.sh <file.sql.gz>` (asks for confirmation; stops api/worker, replaces the schema, re-runs migrations, restarts). Test restores on a scratch host periodically.

## Network hardening (egress / SSRF)
The `worker` and `api` join the `edge` network so they can call LLM/SMTP/Stripe/Google and customer webhooks. The app blocks private/loopback/link-local/metadata targets for crawls, webhooks and custom tools (re-checked on every redirect), but defence in depth belongs at the host: firewall outbound traffic from the Docker `yulona_edge` bridge to RFC1918 ranges, `169.254.169.254` and your management network (e.g. `iptables -I DOCKER-USER -s <edge subnet> -d 10.0.0.0/8 -j DROP`, allowing DNS and your intended destinations). Postgres and Redis are on an `internal` network with no egress.

## Requirements and sizing
2 vCPU / 4 GB RAM / 20 GB disk minimum (compose limits add up to about 3.7 GB; add ~2 GB for ClamAV, ~512 MB for MinIO). TLS terminates at the bundled Caddy (automatic Let's Encrypt for a real domain). To use your own reverse proxy instead, run with `SITE_ADDRESS=:80` behind it and forward `/` and WebSocket upgrades (`/api/v1/realtime/ws`, `/api/v1/public/widget/ws`) to Caddy.

## Load testing
`scripts/load-test.ts` (Bun fetch, no deps): `BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... bun scripts/load-test.ts --duration 15 --concurrency 20`. `scripts/smoke-stack.ts` runs the functional end-to-end check against a running stack. Reference run (MacBook, Docker Desktop VM, mock AI provider, Caddy local TLS, load generator on the same machine, 20 connections, 10 s): `/healthz` about 6,400 req/s (p50 2 ms, p95 7 ms); authenticated reads about 4,800 req/s of which almost all were answered 429 by the built-in rate limiter (300 req/min/IP global), accepted reads p50 2.6 ms; widget conversation start 429s after a handful of requests (per-widget/IP limit). Conclusion: a single IP cannot overload the API because the limiter engages first; to measure raw capacity run the generator from several IPs or temporarily raise `rateLimits` in `apps/api/src/config.ts`. LLM latency, not the API, dominates real conversation time.

## Split deployment (api and dashboard on separate hosts)
The two images share nothing except the HTTP API.

**API host** (`api.example.com`): run the api image plus Postgres/Redis (you can reuse `docker-compose.yml`, removing the `dashboard` service and the Caddy dashboard route, or put your own TLS proxy in front of `api:3000`). Required env:
```
CORS_ORIGINS=https://app.example.com      # exact dashboard origin(s), comma-separated; credentials are allowed
CROSS_SITE_COOKIES=true                   # only if the two hosts are different SITES (not subdomains of one domain)
```
If both are subdomains of the same registrable domain (`app.` / `api.example.com`), leave `CROSS_SITE_COOKIES=false` (SameSite=Strict still works for same-site requests). The API must be served over HTTPS (cookies are `Secure`).

**Dashboard host** (`app.example.com`): only the static image:
```bash
docker run -d --name yulona-dashboard --restart unless-stopped \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e API_URL=https://api.example.com -p 127.0.0.1:8080:8080 \
  yulona/dashboard:local          # put any TLS proxy in front of :8080
```
`API_URL` is read at container start and written to `/config.js` (and into the CSP `connect-src`); one image works everywhere. It must be a plain `http(s)://host[:port]` URL.

Both on one host but separate: keep Caddy, leave `DASHBOARD_API_URL` empty (same-origin `/api`).

## Troubleshooting
- API exits at boot: it refuses weak/missing secrets in production; check `docker compose logs api`.
- `variable is missing a value`: run compose with `--env-file deploy/.env` from outside `deploy/`, or run `deploy/setup.sh` first.
- Changing `APP_DB_PASSWORD` after first start does not change the DB role password: run `ALTER ROLE yulona_app PASSWORD '...'` in Postgres.
