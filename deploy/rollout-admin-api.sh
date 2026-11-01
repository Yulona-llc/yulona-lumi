#!/usr/bin/env bash
# Independent admin-api rollout. Touches ONLY the admin-api container (compose project `yulona-admin-api`);
# api, worker, postgres, redis and caddy keep running. Database migrations are applied by deploy/rollout.sh
# (the api rollout), never here.
# Usage: deploy/rollout-admin-api.sh <image-ref>
#   deploy/rollout-admin-api.sh ghcr.io/org/yulona/admin-api:abc1234
# Requires: deploy/.env (with ADMIN_JWT_SECRET and ADMIN_DB_PASSWORD), the Docker networks yulona_edge and
# yulona_backend from the full stack, and a running postgres and redis in compose project `yulona`.
# The container is recreated in place, so the admin API is unavailable for a few seconds during the swap.
# The previous image is restored automatically if the new one does not become ready.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"
BACKEND_FILE="$DIR/docker-compose.backend.yml"
PROJECT="yulona-admin-api"
CURRENT_FILE="$DIR/.deploy-admin-api-current"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-60}"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found; run deploy/setup.sh first"
IMAGE="${1:-}"
[ -n "$IMAGE" ] || die "usage: deploy/rollout-admin-api.sh <image-ref>"

for var in ADMIN_JWT_SECRET ADMIN_DB_PASSWORD; do
  value="$(awk -F= -v k="$var" '$1==k {sub(/^[^=]*=/,""); gsub(/["\r]/,""); print; exit}' "$ENV_FILE" || true)"
  [ -n "$value" ] || die "$var is empty in $ENV_FILE (see deploy/.env.backend.example)"
done

# Compose interpolates the whole file, so the api image variable must resolve even though only admin-api starts.
export YULONA_API_IMAGE="${YULONA_API_IMAGE:-$(cat "$DIR/.deploy-current" 2>/dev/null || echo yulona/api:unused)}"
export COMPOSE_PROFILES=admin

compose() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$BACKEND_FILE" "$@"
}

wait_ready() {
  local cid="$1"
  local deadline=$((SECONDS + READY_TIMEOUT_S))
  info "Waiting for /readyz on admin-api (timeout ${READY_TIMEOUT_S}s)"
  while (( SECONDS < deadline )); do
    if docker exec "$cid" bun -e '
      fetch("http://127.0.0.1:"+(process.env.PORT||4100)+"/readyz")
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch(() => process.exit(1));
    ' 2>/dev/null; then
      return 0
    fi
    running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
    [ "$running" = "true" ] || return 1
    sleep 2
  done
  return 1
}

previous="$(cat "$CURRENT_FILE" 2>/dev/null || true)"

info "Pulling $IMAGE"
docker pull "$IMAGE"

info "Starting admin-api ($IMAGE)"
YULONA_ADMIN_API_IMAGE="$IMAGE" compose up -d --no-deps admin-api
cid="$(YULONA_ADMIN_API_IMAGE="$IMAGE" compose ps -q admin-api)"
[ -n "$cid" ] || die "admin-api container did not start"

if ! wait_ready "$cid"; then
  echo "error: admin-api did not become ready" >&2
  docker logs --tail 40 "$cid" >&2 || true
  if [ -n "$previous" ]; then
    echo "Rolling back to $previous" >&2
    YULONA_ADMIN_API_IMAGE="$previous" compose up -d --no-deps admin-api || true
  else
    echo "No previous image recorded; stopping the failed container." >&2
    YULONA_ADMIN_API_IMAGE="$IMAGE" compose stop admin-api || true
  fi
  exit 1
fi

echo "$IMAGE" > "$CURRENT_FILE"
if [ -n "$previous" ] && [ "$previous" != "$IMAGE" ]; then
  echo "$previous" > "$DIR/.deploy-admin-api-previous"
fi

cat <<MSG

Admin API rollout complete.
  image:    $IMAGE
  previous: ${previous:-none recorded}
Rollback: deploy/rollout-admin-api.sh ${previous:-<previous-tag>}
MSG
