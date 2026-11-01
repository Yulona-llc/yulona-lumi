#!/usr/bin/env bash
# One-command install: generates secrets, writes deploy/.env (chmod 600), builds, migrates, creates the first
# tenant + admin, starts everything and prints the URL + credentials ONCE.
# Usage: deploy/setup.sh [domain] [--email admin@example.com] [--workspace "Acme"] [--name "Ada"]
#        e.g. deploy/setup.sh app.example.com --email me@example.com        (default domain: localhost)
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DIR/docker-compose.yml")

die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is required"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
command -v openssl >/dev/null || die "openssl is required"

site="localhost"; email=""; workspace=""; admin_name="Admin"
while [ $# -gt 0 ]; do
  case "$1" in
    --email) email="${2:?--email needs a value}"; shift 2 ;;
    --workspace) workspace="${2:?--workspace needs a value}"; shift 2 ;;
    --name) admin_name="${2:?--name needs a value}"; shift 2 ;;
    -*) die "unknown option: $1" ;;
    *) site="$1"; shift ;;
  esac
done
[[ "$site" =~ ^[A-Za-z0-9.:_-]+$ ]] || die "invalid domain: $site"
host="${site%%:*}"; [ -n "$host" ] || host="localhost"
[ -n "$email" ] || email="admin@${host}"
[ -n "$workspace" ] || workspace="My Workspace"

[ -e "$ENV_FILE" ] && die "$ENV_FILE already exists; refusing to overwrite secrets. Use deploy/upgrade.sh, or delete it to start over."

gen() { openssl rand -hex "$1"; }
tmp="$(mktemp "$DIR/.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
sed \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$site|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(gen 24)|" \
  -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(gen 24)|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(gen 24)|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=$(gen 48)|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
  -e "s|^MINIO_ROOT_PASSWORD=CHANGE_ME|MINIO_ROOT_PASSWORD=$(gen 16)|" \
  "$DIR/.env.example" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
trap - EXIT
echo "Wrote $ENV_FILE (mode 600). Back it up somewhere safe: losing it (esp. ENCRYPTION_KEY) means losing access to your data."

"${COMPOSE[@]}" build
# Postgres creates the `yulona_app` role (password APP_DB_PASSWORD) via the initdb script on first start.
"${COMPOSE[@]}" up -d --wait postgres redis
"${COMPOSE[@]}" run --rm migrate
creds="$("${COMPOSE[@]}" run --rm -T create-tenant --workspace "$workspace" --email "$email" --name "$admin_name" --json)"
"${COMPOSE[@]}" up -d --wait

if [ "$site" = "localhost" ] || [ "$site" = ":80" ]; then
  url="https://localhost (self-signed local CA)"; [ "$site" = ":80" ] && url="http://<this-host>"
else
  url="https://$site"
fi
pw="$(printf '%s' "$creds" | sed -n 's/.*"password":"\([^"]*\)".*/\1/p' | tail -n1)"
echo
echo "Lumi is running: $url"
echo "Admin login : $email"
echo "Password    : ${pw:-<see create-tenant output above>}    (shown once - change it after first login)"
echo "Health      : curl -k ${url%% *}/readyz"
echo "Logs        : ${COMPOSE[*]} logs -f"
echo "Backups     : deploy/backup.sh   (cron it; copy off-host)"
