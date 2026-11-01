#!/usr/bin/env bash
# Zero-downtime api + worker rollout (one image): backup -> pull image -> migrate -> start new slot ->
# gate on /readyz + worker -> caddy reload -> stop old slot. Does not touch the admin API
# (see deploy/rollout-admin-api.sh).
# Usage: deploy/rollout.sh <image-ref>
#   deploy/rollout.sh ghcr.io/org/yulona/api:abc1234
# Requires: deploy/.env, Docker networks yulona_edge / yulona_backend (from the full stack),
# and a running postgres (+ redis, caddy) in compose project `yulona`.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"
SLOT_FILE="$DIR/.deploy-slot"
PREV_FILE="$DIR/.deploy-previous"
INFRA=(docker compose --project-name yulona --env-file "$ENV_FILE" -f "$DIR/docker-compose.yml")
BACKEND_FILE="$DIR/docker-compose.backend.yml"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-90}"
STOP_GRACE_S="${STOP_GRACE_S:-30}"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found; run deploy/setup.sh first"
IMAGE="${1:-}"
[ -n "$IMAGE" ] || die "usage: deploy/rollout.sh <image-ref>"

export YULONA_API_IMAGE="$IMAGE"
# The admin API is deployed on its own by deploy/rollout-admin-api.sh (compose project yulona-admin-api),
# so an api/worker rollout never starts, restarts or stops it. Profiles are deliberately not activated here.
unset COMPOSE_PROFILES

LIVE="$(cat "$SLOT_FILE" 2>/dev/null || true)"
if [ "$LIVE" = "blue" ]; then NEXT=green
elif [ "$LIVE" = "green" ]; then NEXT=blue
else NEXT=blue
fi

compose_slot() {
  local slot="$1"
  shift
  docker compose --project-name "yulona-backend-${slot}" --env-file "$ENV_FILE" -f "$BACKEND_FILE" "$@"
}

caddy_reload() {
  if "${INFRA[@]}" ps -q caddy >/dev/null 2>&1 && [ -n "$("${INFRA[@]}" ps -q caddy)" ]; then
    info "Reloading Caddy"
    "${INFRA[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  else
    echo "warn: caddy container not running in project yulona; skip reload" >&2
  fi
}

wait_ready() {
  local cid="$1"
  local deadline=$((SECONDS + READY_TIMEOUT_S))
  info "Waiting for /readyz on new api (timeout ${READY_TIMEOUT_S}s)"
  while (( SECONDS < deadline )); do
    if docker exec "$cid" bun -e '
      fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/readyz")
        .then(async (r) => { const j = await r.json().catch(() => ({})); process.exit(r.ok && j.status === "ok" ? 0 : 1); })
        .catch(() => process.exit(1));
    ' 2>/dev/null; then
      return 0
    fi
    # Abort early if the container exited.
    running="$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
    [ "$running" = "true" ] || die "new api container exited before becoming ready"
    sleep 2
  done
  return 1
}

abort_next() {
  echo "error: $*" >&2
  echo "Leaving the live slot running. Removing the failed next slot (${NEXT})." >&2
  compose_slot "$NEXT" down --remove-orphans >/dev/null 2>&1 || true
  exit 1
}

# ----- backup (same idea as upgrade.sh; uses infra postgres)
mkdir -p "$DIR/backups"
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$DIR/backups/pre-rollout-$stamp.sql.gz"
info "Backing up database to $backup"
pg_cid="$("${INFRA[@]}" ps -q postgres)"
[ -n "$pg_cid" ] || die "postgres is not running in project yulona"
docker exec -i "$pg_cid" pg_dump -U yulona_owner -d yulona --no-owner | gzip > "$backup"
[ -s "$backup" ] || die "backup is empty; aborting"

prev_image="$(cat "$PREV_FILE" 2>/dev/null || true)"
# Remember what is live now so a later rollback has a tag.
if [ -n "$LIVE" ]; then
  live_cid="$(compose_slot "$LIVE" ps -q api 2>/dev/null || true)"
  if [ -n "$live_cid" ]; then
    prev_image="$(docker inspect -f '{{.Config.Image}}' "$live_cid" 2>/dev/null || echo "$prev_image")"
  fi
fi

info "Pulling $IMAGE"
docker pull "$IMAGE"

info "Migrating with new image (live services untouched until migrate succeeds)"
if ! compose_slot "$NEXT" run --rm --no-deps migrate; then
  echo "Migration FAILED. Running services are unchanged. Restore if needed:"
  echo "  gunzip -c $backup | docker exec -i $pg_cid psql -U yulona_owner -d yulona"
  compose_slot "$NEXT" down --remove-orphans >/dev/null 2>&1 || true
  exit 1
fi

info "Starting next slot: yulona-backend-${NEXT}"
compose_slot "$NEXT" up -d --no-deps api worker

api_cid="$(compose_slot "$NEXT" ps -q api)"
[ -n "$api_cid" ] || abort_next "new api container did not start"
worker_cid="$(compose_slot "$NEXT" ps -q worker)"
[ -n "$worker_cid" ] || abort_next "new worker container did not start"

wait_ready "$api_cid" || abort_next "new api did not become ready within ${READY_TIMEOUT_S}s"

info "Checking worker started"
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if docker logs "$worker_cid" 2>&1 | grep -q "worker started"; then
    break
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$worker_cid" 2>/dev/null || echo false)"
  [ "$running" = "true" ] || abort_next "new worker exited before logging startup"
  sleep 1
done
docker logs "$worker_cid" 2>&1 | grep -q "worker started" || abort_next "new worker did not log \"worker started\""
running="$(docker inspect -f '{{.State.Running}}' "$worker_cid" 2>/dev/null || echo false)"
[ "$running" = "true" ] || abort_next "new worker is not running after startup"

caddy_reload

info "Stopping old api/worker (grace ${STOP_GRACE_S}s)"
# First rollout after setup.sh: containers live in project `yulona`.
if [ -n "$("${INFRA[@]}" ps -q api 2>/dev/null || true)" ] || [ -n "$("${INFRA[@]}" ps -q worker 2>/dev/null || true)" ]; then
  "${INFRA[@]}" stop -t "$STOP_GRACE_S" api worker 2>/dev/null || true
fi
if [ -n "$LIVE" ] && [ "$LIVE" != "$NEXT" ]; then
  compose_slot "$LIVE" stop -t "$STOP_GRACE_S" 2>/dev/null || true
  compose_slot "$LIVE" down --remove-orphans 2>/dev/null || true
fi

caddy_reload

echo "$NEXT" > "$SLOT_FILE"
echo "$IMAGE" > "$DIR/.deploy-current"
if [ -n "$prev_image" ]; then
  echo "$prev_image" > "$PREV_FILE"
fi

cat <<MSG

Rollout complete.
  image:   $IMAGE
  slot:    yulona-backend-${NEXT}
  backup:  $backup
  previous image: ${prev_image:-none recorded}
Rollback (same schema): deploy/rollout.sh ${prev_image:-<previous-tag>}
Schema undo: deploy/restore.sh $backup
MSG
