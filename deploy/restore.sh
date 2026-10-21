#!/usr/bin/env bash
# Restore a backup made by backup.sh into the running postgres. DESTRUCTIVE: replaces the `public` schema content.
# Usage: deploy/restore.sh <backup.sql.gz> [--yes]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose --env-file "$DIR/.env" -f "$DIR/docker-compose.yml")
file="${1:?usage: deploy/restore.sh <backup.sql.gz> [--yes]}"
[ -s "$file" ] || { echo "error: $file not found/empty" >&2; exit 1; }
gzip -t "$file"
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This REPLACES all data in database 'yulona'. Type 'restore' to continue: " a
  [ "$a" = "restore" ] || { echo aborted; exit 1; }
fi
"${COMPOSE[@]}" stop api worker
"${COMPOSE[@]}" up -d --wait postgres
psql_owner=("${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U yulona_owner -d yulona)
"${psql_owner[@]}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
gunzip -c "$file" | "${psql_owner[@]}" >/dev/null
# Re-run migrations (no-op when the dump is current; brings an older dump forward) which also re-applies role grants.
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d --wait
echo "restore complete from $file"
