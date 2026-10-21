#!/usr/bin/env bash
# Upgrade: backup DB -> fetch new code/images -> build -> migrate -> restart services one by one.
# Usage: deploy/upgrade.sh [--no-git]    (--no-git: skip `git pull`, e.g. when using registry images)
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$DIR/docker-compose.yml")
die() { echo "error: $*" >&2; exit 1; }
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found; run deploy/setup.sh first"

mkdir -p "$DIR/backups"
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$DIR/backups/pre-upgrade-$stamp.sql.gz"
echo "==> Backing up database to $backup"
"${COMPOSE[@]}" exec -T postgres pg_dump -U yulona_owner -d yulona --no-owner | gzip > "$backup"
[ -s "$backup" ] || die "backup is empty; aborting"

# Remember current images so a rollback is one retag away.
prev_api="$(docker image inspect -f '{{.Id}}' "${YULONA_API_IMAGE:-yulona/api:local}" 2>/dev/null || true)"
prev_dash="$(docker image inspect -f '{{.Id}}' "${YULONA_DASHBOARD_IMAGE:-yulona/dashboard:local}" 2>/dev/null || true)"

if [ "${1:-}" != "--no-git" ] && git -C "$DIR/.." rev-parse --git-dir >/dev/null 2>&1; then
  echo "==> git pull --ff-only"
  git -C "$DIR/.." pull --ff-only
fi

echo "==> Building / pulling images"
"${COMPOSE[@]}" build --pull
"${COMPOSE[@]}" pull --ignore-buildable --quiet 2>/dev/null || true

echo "==> Migrating"
"${COMPOSE[@]}" up -d --wait postgres redis
if ! "${COMPOSE[@]}" run --rm migrate; then
  echo "Migration FAILED. Running services are unchanged. Restore if needed:"
  echo "  gunzip -c $backup | ${COMPOSE[*]} exec -T postgres psql -U yulona_owner -d yulona"
  exit 1
fi

echo "==> Restarting services"
for svc in api worker dashboard caddy; do
  "${COMPOSE[@]}" up -d --wait --no-deps "$svc"
done
"${COMPOSE[@]}" up -d --wait

cat <<MSG

Upgrade complete. Backup: $backup
Rollback (code/images): previous image IDs were
  api:       ${prev_api:-unknown}
  dashboard: ${prev_dash:-unknown}
  1) git checkout <previous-commit> (or set YULONA_*_IMAGE to the previous tag in deploy/.env)
  2) ${COMPOSE[*]} up -d --build
  Schema: migrations are forward-only; to undo one, restore the pre-upgrade backup (stops api/worker, restores, restarts):
  3) $DIR/restore.sh $backup
MSG
