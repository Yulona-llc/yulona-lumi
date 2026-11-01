#!/bin/sh
# Runs at container start (nginx image executes /docker-entrypoint.d/*.sh).
# Generates /tmp/runtime/config.js and headers.conf from API_URL. Fails closed on suspicious input.
set -eu
dir=/tmp/runtime
mkdir -p "$dir"
api_url="${API_URL:-}"

# Only a plain http(s) origin/URL (or empty = same origin, the default behind Caddy) is accepted: blocks JS/CSP/nginx-config injection.
case "$api_url" in
  "") ;;
  http://*|https://*) ;;
  *) echo "lumi-admin: API_URL must be empty or start with http:// or https://" >&2; exit 1 ;;
esac
if printf '%s' "$api_url" | grep -Eq '[^A-Za-z0-9._~:/@%+-]'; then
  echo "lumi-admin: API_URL contains disallowed characters" >&2; exit 1
fi
api_url="${api_url%/}"

printf 'window.__ADMIN_CONFIG__ = Object.freeze({ apiUrl: "%s" });\n' "$api_url" > "$dir/config.js"

connect="'self'"
if [ -n "$api_url" ]; then
  origin=$(printf '%s' "$api_url" | sed -E 's#^(https?://[^/]+).*#\1#')
  connect="'self' $origin"
fi
csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src $connect; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

cat > "$dir/headers.conf" <<HDR
add_header Content-Security-Policy "$csp" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header X-Robots-Tag "noindex, nofollow" always;
HDR
