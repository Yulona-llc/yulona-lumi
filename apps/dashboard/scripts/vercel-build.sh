#!/usr/bin/env bash
# Build the tenant dashboard + widget bundle for a Vercel static deploy.
# Root Directory in the Vercel project must be apps/dashboard (this script cds to the monorepo root).
# Required env: VITE_API_URL=https://api.example.com (no trailing slash, no /api/v1).
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$APP_DIR/../.." && pwd)"
cd "$ROOT"

api_url="${VITE_API_URL:-}"
case "$api_url" in
  "")
    echo "vercel-build: VITE_API_URL is required (public API origin, e.g. https://api.example.com)" >&2
    exit 1
    ;;
  http://*|https://*) ;;
  *)
    echo "vercel-build: VITE_API_URL must start with http:// or https://" >&2
    exit 1
    ;;
esac
api_url="${api_url%/}"
if printf '%s' "$api_url" | grep -Eq '[^A-Za-z0-9._~:/@%+-]'; then
  echo "vercel-build: VITE_API_URL contains disallowed characters" >&2
  exit 1
fi

bun install --frozen-lockfile
bun run --cwd apps/dashboard build
bun run --cwd apps/widget build
h="$(sha256sum apps/widget/dist/widget.js | cut -c1-12)"
cp apps/widget/dist/widget.js "apps/dashboard/dist/widget.${h}.js"
cp apps/widget/dist/widget.js apps/dashboard/dist/widget.js
printf '%s\n' "$h" > apps/dashboard/dist/widget.version
# Same shape as the nginx entrypoint config.js so the SPA prefers it over the baked VITE_API_URL.
printf 'window.__YULONA_CONFIG__ = Object.freeze({ apiUrl: "%s" });\n' "$api_url" > apps/dashboard/dist/config.js
