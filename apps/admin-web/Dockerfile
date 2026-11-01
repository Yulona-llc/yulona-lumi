# syntax=docker/dockerfile:1.7
# Lumi platform admin web (static SPA on unprivileged nginx). Build context MUST be the monorepo root:
#   docker build -f apps/admin-web/Dockerfile -t yulona/admin-web .
# Runtime config: API_URL (empty = same origin, the default behind the Caddy admin site). One image serves every environment.
ARG BUN_VERSION=1
ARG NGINX_VERSION=1.27-alpine

# Collect every workspace package.json (+ root manifest and lockfile) so a new workspace never requires editing this file.
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
COPY apps/admin-web apps/admin-web
RUN bun run --cwd apps/admin-web build

FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS runtime
COPY --chown=root:root apps/admin-web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --chown=root:root --chmod=0755 apps/admin-web/nginx/40-admin-config.sh /docker-entrypoint.d/40-admin-config.sh
COPY --from=build --chown=root:root /repo/apps/admin-web/dist /usr/share/nginx/html
ENV API_URL=""
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
