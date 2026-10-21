#!/usr/bin/env bash
# Logical backup of the database (gzip'd pg_dump) to deploy/backups/. Keeps the newest $KEEP (default 14).
# Usage: deploy/backup.sh [output-file]     Cron example: 17 3 * * *  /opt/yulona/deploy/backup.sh
# Also back up deploy/.env (ENCRYPTION_KEY!) and your object storage (S3/MinIO) separately.
set -euo pipefail
umask 077
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose --env-file "$DIR/.env" -f "$DIR/docker-compose.yml")
[ -f "$DIR/.env" ] || { echo "error: $DIR/.env not found" >&2; exit 1; }
mkdir -p "$DIR/backups"
out="${1:-$DIR/backups/yulona-$(date +%Y%m%d-%H%M%S).sql.gz}"
"${COMPOSE[@]}" exec -T postgres pg_dump -U yulona_owner -d yulona --no-owner | gzip > "$out.tmp"
[ -s "$out.tmp" ] || { rm -f "$out.tmp"; echo "error: backup is empty" >&2; exit 1; }
gzip -t "$out.tmp"
mv "$out.tmp" "$out"
echo "backup written: $out ($(wc -c < "$out") bytes)"
if [ -z "${1:-}" ]; then
  # shellcheck disable=SC2012
  ls -1t "$DIR"/backups/yulona-*.sql.gz 2>/dev/null | tail -n +"$(( ${KEEP:-14} + 1 ))" | xargs -r rm -f
fi
