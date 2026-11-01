# syntax=docker/dockerfile:1.7
# Lumi platform-admin API (separate service; never part of the self-hosted bundle). Build context MUST be the monorepo root:
#   docker build -f apps/admin-api/Dockerfile -t yulona/admin-api .
ARG BUN_VERSION=1

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
COPY packages packages
COPY apps/admin-api apps/admin-api
RUN bun build apps/admin-api/src/index.ts --target=bun --minify --outfile=/out/index.js

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ENV NODE_ENV=production PORT=4100
WORKDIR /app
COPY --from=build --chown=root:root /out/ /app/dist/
USER bun
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "run", "dist/index.js"]
