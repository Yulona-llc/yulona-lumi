#!/usr/bin/env bash
# Build the platform admin web for a Vercel static deploy.
# Root Directory in the Vercel project must be apps/admin-web.
# Required env: VITE_ADMIN_API_URL=https://admin-api.example.com (no trailing slash).
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$APP_DIR/../.." && pwd)"
cd "$ROOT"

api_url="${VITE_ADMIN_API_URL:-}"
case "$api_url" in
  "")
    echo "vercel-build: VITE_ADMIN_API_URL is required (admin API origin)" >&2
    exit 1
    ;;
  http://*|https://*) ;;
  *)
    echo "vercel-build: VITE_ADMIN_API_URL must start with http:// or https://" >&2
    exit 1
    ;;
esac
api_url="${api_url%/}"
if printf '%s' "$api_url" | grep -Eq '[^A-Za-z0-9._~:/@%+-]'; then
  echo "vercel-build: VITE_ADMIN_API_URL contains disallowed characters" >&2
  exit 1
fi

bun install --frozen-lockfile
bun run --cwd apps/admin-web build
printf 'window.__ADMIN_CONFIG__ = Object.freeze({ apiUrl: "%s" });\n' "$api_url" > apps/admin-web/dist/config.js
