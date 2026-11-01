# syntax=docker/dockerfile:1.7
# Lumi dashboard (static SPA on unprivileged nginx). Build context MUST be the monorepo root:
#   docker build -f apps/dashboard/Dockerfile -t yulona/dashboard .
# Runtime config: set API_URL (empty = same-origin /api). One image serves every environment.
ARG BUN_VERSION=1
ARG NGINX_VERSION=1.27-alpine

# ---- manifests: collect every workspace package.json (+ root manifest and lockfile) automatically, so a new
# workspace never requires editing this file. The copy below only changes when a manifest/lockfile changes.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /m && cp package.json /m/ && { cp bun.lock* /m/ 2>/dev/null || true; } \
 && find apps packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /m/ \;

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /repo
COPY --from=manifests /m/ ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
COPY apps/widget apps/widget
# Build output: apps/dashboard/dist (VITE_API_URL is intentionally NOT baked in; see /config.js)
RUN bun run --cwd apps/dashboard build
# Embeddable widget bundle, served by this image at /widget.js (short cache) and /widget.<hash>.js (immutable).
RUN bun run --cwd apps/widget build \
 && h="$(sha256sum apps/widget/dist/widget.js | cut -c1-12)" \
 && cp apps/widget/dist/widget.js "apps/dashboard/dist/widget.$h.js" \
 && cp apps/widget/dist/widget.js apps/dashboard/dist/widget.js \
 && echo "$h" > apps/dashboard/dist/widget.version

FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS runtime
COPY --chown=root:root apps/dashboard/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chown=root:root --chmod=0755 apps/dashboard/nginx/40-yulona-config.sh /docker-entrypoint.d/40-yulona-config.sh
COPY --from=build --chown=root:root /repo/apps/dashboard/dist /usr/share/nginx/html
ENV API_URL=""
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
